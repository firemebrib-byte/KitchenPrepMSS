/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 本地 SQLite（阶段二·规范化关系型表结构 + 阶段三·增量写协议，见 SQLite迁移规划.md）与腾讯云对象存储（COS）
 * 双模式持久化服务：save() 接收一批增量 SyncOp[]，通过 applyChangesIntoSqlite() 对规范化表做目标 upsert/delete；
 * load() 返回完整状态供 GET /load 使用（按月懒加载时附带日期区间，见 server/routes/storage.ts）。
 * 早期 JSON 文件存储、阶段一 kv_store 浅迁移格式、以及此前的本地/云端 JSON 备份快照功能均已彻底移除，
 * 不再保留任何迁移兼容代码——数据安全性完全依赖 SQLite 事务+WAL（本地模式）或云厂商多副本冗余（COS 模式），
 * 灾难恢复（如硬盘损坏）由客户自行定期做操作系统级的 data/ 目录整体备份，详见部署指南.md。
 */

import path from "path";
import fs from "fs";
import crypto from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import Database from "better-sqlite3";
import COS from "cos-nodejs-sdk-v5";
// Constants previously here were removed
import { FoodCategory, TargetGroup, DynamicGroup, DynamicCategory } from "../src/types/types.ts";
import { Ledger, LedgerItem, DailyStockRecord } from "../src/types/ledgerTypes.ts";
import { RawMaterialsDictService, RawMaterialDictItem } from "../src/services/rawMaterialDict.ts";
import { LogService } from "./logService.ts";

/**
 * @description 台账逐日流水记录（DailyStockRecord）的全部字段名，供审计日志逐字段比对"这次录入在原有基础上增加/减少/修改了什么"
 */
const DAILY_RECORD_FIELDS = [
  "inQuantity", "inPrice", "inAmount", "outQuantity", "outPrice", "outAmount", "note",
  "certification", "sensoryProperty", "supplier", "purchaseDate", "buyer", "inspector", "keeper",
  "produceDate", "shelfLife", "outHandler", "outRecipient", "conversionUnitQuantity", "outDate"
] as const;

/** ledgerHelperDict 的 8 个 string[] 字段名，打平存入 ledger_helper_options 表 */
const HELPER_DICT_CATEGORIES = [
  "suppliers", "buyers", "inspectors", "keepers",
  "outHandlers", "outRecipients", "sensoryOptions", "shelfLifeOptions"
] as const;

/** 判断"当前规范化表结构是否完全为空"时需要检查的表清单 */
const NORMALIZED_TABLES = [
  "ledgers", "ledger_items", "active_groups",
  "active_categories", "raw_materials_dict", "ledger_helper_options"
] as const;

/** 阶段三·增量写协议：可增量写入的实体类型 */
export type SyncOpEntity =
  | "ledger" | "ledgerItem" | "ledgerItemDailyRecord" | "activeGroup" | "activeCategory" | "rawMaterial" | "ledgerHelperOptions";

/**
 * @description 单个增量同步操作。key 的形状按 entity 而定：大多数实体是主键字符串，
 * ledgerItemDailyRecord/preparedItemDailyData 是 { itemId, date } 复合键，report 是 { targetGroup, year, month } 复合键。
 * previousKey 仅供"主键本身可被改名"的实体（目前只有 rawMaterial.name）在改名时携带旧主键用于清理旧行。
 * op: "replaceAll" 仅供首次启动/批量种子数据生成使用，data 为该实体的完整数组（一次性整体替换，不做逐条枚举）。
 */
export interface SyncOp {
  entity: SyncOpEntity;
  op: "upsert" | "delete" | "replace" | "replaceAll";
  key?: any;
  data?: any;
  previousKey?: any;
}

export const RequestContext = new AsyncLocalStorage<{
  baseVersion?: number;
  /** 每个 HTTP 请求的短随机 ID，用于串联运行日志与数据审计日志里同一次请求产生的多条记录 */
  reqId?: string;
  /** 触发本次写操作的 HTTP 方法（同进程内直接调用业务方法时可能为空） */
  method?: string;
  /** 触发本次写操作的请求 URL */
  url?: string;
}>();

/**
 * @description 后端持久化数据同步引擎，支持本地 SQLite 与腾讯云 COS 对象存储双模式切换
 */
export class StorageService {
  /**
   * @description 存储类型：local（本地 SQLite） 或 cos（腾讯云对象存储）
   */
  private static storageType: string = process.env.STORAGE_TYPE || "local";

  /**
   * @description 本地数据存储目录，默认为项目根目录下 data/。SQLite 数据库文件与备份快照目录均位于其下。
   */
  private static localDataDir: string = path.resolve(process.env.LOCAL_DATA_DIR || "data");

  /**
   * @description 一键清空所有台账流水记录（保留底表）
   * @returns {boolean} 操作是否成功
   */
  public static async clearDailyRecords(): Promise<boolean> {
    return StorageService.withWriteLock(async () => {
      // 高危不可逆操作：删之前先存一份完整快照。备份失败则整个清空操作中止（宁可不清，也不能没备份就清）。
      const backupPath = await StorageService.snapshotBackup("before-clear-records");
      try {
        if (StorageService.storageType === "local") {
          const db = StorageService.getDb();
          const before = db.prepare(
            "SELECT (SELECT COUNT(*) FROM ledger_items) AS items, (SELECT COUNT(*) FROM ledger_item_daily_records) AS records"
          ).get() as { items: number; records: number };
          db.prepare("DELETE FROM ledger_item_daily_records").run();
          db.prepare("DELETE FROM ledger_items").run();
          LogService.audit(
            "system.clearDailyRecords",
            `一键清空所有台账流水：物理删除 ledger_items ${before.items} 行、ledger_item_daily_records ${before.records} 行（保留台账/人群/大类/字典配置）| 删前快照: ${backupPath ? path.basename(backupPath) : "(无)"}`,
            StorageService.auditCtx(),
            "warn"
          );
          return true;
        } else {
          // COS 模式下，直接读取全量数据并过滤，然后强制整体上传
          const data = await StorageService.loadCurrentFromCos();
          const removedCount = Array.isArray(data.ledgerItems) ? data.ledgerItems.length : 0;
          data.ledgerItems = [];
          // COS 模式下，直接移除不再使用的备餐冗余数据字段
          delete data.reports;
          delete data.preparedItems;
          delete data.preparedItemDailyData;
          // 保存回 COS
          const { Bucket, Region, Key } = StorageService.getCosConfig();
          await new Promise<void>((resolve, reject) => {
            StorageService.getCosClient().putObject({
              Bucket,
              Region,
              Key,
              Body: JSON.stringify(data, null, 2)
            }, (err) => {
              if (err) reject(err);
              else resolve();
            });
          });
          LogService.audit(
            "system.clearDailyRecords",
            `一键清空所有台账流水（COS 模式）：清空 ledgerItems ${removedCount} 项及其全部逐日流水（COS 多副本冗余，未生成本地快照）`,
            StorageService.auditCtx(),
            "warn"
          );
          return true;
        }
      } catch (err: any) {
        console.error("[STORAGE ERROR] 清空台账记录失败:", err);
        LogService.audit(
          "system.clearDailyRecords.fail",
          `一键清空所有台账流水失败: ${err?.message || String(err)}`,
          StorageService.auditCtx(),
          "error"
        );
        return false;
      }
    });
  }

  /**
   * @description 备份本地 SQLite 数据库到指定路径，确保 WAL 日志也一并落盘
   * @param destinationPath 目标备份文件路径
   */
  public static async backupLocalDb(destinationPath: string): Promise<void> {
    if (StorageService.storageType !== "local") {
      throw new Error("非本地 SQLite 模式，不支持调用 backupLocalDb");
    }
    const db = StorageService.getDb();
    await db.backup(destinationPath);
  }

  /** 备份快照目录（本地模式）：<localDataDir>/backups */
  private static get backupDir(): string {
    return path.join(StorageService.localDataDir, "backups");
  }

  /** 自动备份定时器句柄，防止重复启动 */
  private static autoBackupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * @description 生成一份一致性数据库快照到 <localDataDir>/backups/，并按 KPMSS_BACKUP_KEEP（默认 30）滚动清理旧快照。
   * 用 better-sqlite3 的在线 backup 接口，天然处理 WAL 未落盘的页；本地模式才有意义，COS 模式直接返回 null（云端多副本冗余）。
   * **失败会抛异常**：高危删除前的保护性备份调用方据此中止删除（宁可不删，也不能没备份就删）。
   * @param {string} reason 备份缘由，写进文件名（如 before-clear-records / startup / scheduled）
   * @returns {Promise<string | null>} 生成的备份文件绝对路径；COS 模式为 null
   */
  public static async snapshotBackup(reason: string): Promise<string | null> {
    if (StorageService.storageType !== "local") return null;

    const safeReason = (reason || "manual").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "manual";
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

    try {
      if (!fs.existsSync(StorageService.backupDir)) {
        fs.mkdirSync(StorageService.backupDir, { recursive: true });
      }
      const dest = path.join(StorageService.backupDir, `kpmss_${stamp}_${safeReason}.sqlite`);
      await StorageService.getDb().backup(dest);

      // 滚动清理：只保留最新 keep 份 kpmss_*.sqlite
      const keep = Math.max(1, parseInt(process.env.KPMSS_BACKUP_KEEP || "30", 10) || 30);
      let pruned = 0;
      try {
        const files = fs.readdirSync(StorageService.backupDir)
          .filter((f) => /^kpmss_.*\.sqlite$/.test(f))
          .map((f) => ({ f, t: fs.statSync(path.join(StorageService.backupDir, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t);
        for (const { f } of files.slice(keep)) {
          fs.unlinkSync(path.join(StorageService.backupDir, f));
          pruned++;
        }
      } catch (pruneErr) {
        console.error("[STORAGE BACKUP] 清理旧备份失败（忽略）:", pruneErr);
      }

      const sizeKb = (() => { try { return Math.round(fs.statSync(dest).size / 1024); } catch { return -1; } })();
      LogService.audit(
        "system.backup",
        `已生成数据库快照 ${path.basename(dest)}（${sizeKb} KB，缘由 ${safeReason}）${pruned ? `，滚动清理 ${pruned} 份旧快照` : ""}`,
        StorageService.auditCtx(),
        "info"
      );
      return dest;
    } catch (err: any) {
      LogService.audit(
        "system.backup.fail",
        `生成数据库快照失败（缘由 ${safeReason}）: ${err?.message || String(err)}`,
        StorageService.auditCtx(),
        "error"
      );
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * @description snapshotBackup 的"永不抛"包装：用于启动时/定时的自动备份——备份失败只记日志，不影响服务运行。
   * @param {string} reason 备份缘由
   * @returns {Promise<string | null>}
   */
  private static async snapshotBackupSafe(reason: string): Promise<string | null> {
    try {
      return await StorageService.snapshotBackup(reason);
    } catch (err: any) {
      console.error(`[STORAGE BACKUP] 自动备份失败（缘由 ${reason}，已忽略）:`, err?.message || err);
      return null;
    }
  }

  /**
   * @description 启动自动备份：进程起来后立即备一份（startup），随后每隔 KPMSS_BACKUP_INTERVAL_HOURS 小时（默认 24）
   * 再备一份（scheduled）。设置 KPMSS_DISABLE_AUTO_BACKUP=1 可完全关闭。仅本地模式生效，可安全重复调用。
   */
  public static startAutoBackup(): void {
    if (StorageService.storageType !== "local") return;
    if (process.env.KPMSS_DISABLE_AUTO_BACKUP === "1" || process.env.KPMSS_DISABLE_AUTO_BACKUP === "true") {
      console.log("[STORAGE BACKUP] 已通过 KPMSS_DISABLE_AUTO_BACKUP 关闭自动备份");
      return;
    }
    if (StorageService.autoBackupTimer) return;

    void StorageService.snapshotBackupSafe("startup");

    const hours = Math.max(1, parseFloat(process.env.KPMSS_BACKUP_INTERVAL_HOURS || "24") || 24);
    StorageService.autoBackupTimer = setInterval(() => {
      void StorageService.snapshotBackupSafe("scheduled");
    }, hours * 3600 * 1000);
    // 不要因为这个定时器而让进程无法自然退出
    if (typeof StorageService.autoBackupTimer.unref === "function") {
      StorageService.autoBackupTimer.unref();
    }
    console.log(`[STORAGE BACKUP] 自动备份已启用：启动即备一份，此后每 ${hours} 小时一份，保留最新 ${process.env.KPMSS_BACKUP_KEEP || "30"} 份于 ${StorageService.backupDir}`);
  }

  /**
   * @description 优雅停机收尾（同步）：把 WAL 全量 checkpoint 回主库并关闭连接，避免进程被 kill 后主库文件长期落后、
   * 裸拷贝 kpmss.sqlite 得到陈旧/空库。仅本地模式且连接已建立时执行；尽力而为，失败只记录不抛。
   */
  public static checkpointAndClose(): void {
    if (StorageService.storageType !== "local" || !StorageService.db) return;
    try {
      StorageService.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (err) {
      console.error("[STORAGE SHUTDOWN] WAL checkpoint 失败（忽略）:", err);
    }
    try {
      StorageService.db.close();
      StorageService.db = null;
      console.log("[STORAGE SHUTDOWN] 数据库已 checkpoint 并安全关闭");
    } catch (err) {
      console.error("[STORAGE SHUTDOWN] 关闭数据库连接失败（忽略）:", err);
    }
  }

  /**
   * @description 本地 SQLite 数据库文件路径
   */
  private static sqliteDbPath: string = path.join(StorageService.localDataDir, "kpmss.sqlite");

  /**
   * @description 本地 SQLite 数据库连接（懒加载，全生命周期内复用同一个连接）
   */
  private static db: Database.Database | null = null;

  /**
   * @description 腾讯云 COS 客户端实例
   */
  private static cosClient: COS | null = null;

  /**
   * @description 获取腾讯云 COS 客户端实例（延迟初始化）
   * @returns {COS} COS 客户端实例
   */
  private static getCosClient(): COS {
    if (!StorageService.cosClient) {
      StorageService.cosClient = new COS({
        SecretId: process.env.COS_SECRET_ID || "",
        SecretKey: process.env.COS_SECRET_KEY || "",
      });
    }
    return StorageService.cosClient;
  }

  /**
   * @description 获取 COS 配置参数
   * @returns {Object} 包含 Bucket, Region, Key 等配置
   */
  private static getCosConfig() {
    return {
      Bucket: process.env.COS_BUCKET || "",
      Region: process.env.COS_REGION || "",
      Key: process.env.COS_KEY || "kitchen_db.json"
    };
  }

  /**
   * @description 串行化所有写操作的互斥锁（Promise 链式实现）：save() 无论被并发触发多少次，
   * 都会被严格排队、逐一执行，前一个操作完成（无论成功或失败）后才轮到下一个开始。
   */
  private static writeLock: Promise<void> = Promise.resolve();

  /**
   * @description 获取当前数据库版本号
   */
  public static getDbVersion(): number {
    if (StorageService.storageType === "local" && StorageService.db) {
      try {
        const row = StorageService.db.prepare("SELECT value FROM sys_config WHERE key = 'db_version'").get() as { value: string } | undefined;
        return row ? parseInt(row.value, 10) : 1;
      } catch (err) {
        return 1;
      }
    }
    return 1;
  }

  /**
   * @description 递增当前数据库版本号
   */
  private static incrementDbVersion(): void {
    if (StorageService.storageType === "local" && StorageService.db) {
      StorageService.db.prepare("UPDATE sys_config SET value = CAST(value AS INTEGER) + 1 WHERE key = 'db_version'").run();
    }
  }

  /**
   * @description 从 RequestContext 组装一段紧凑的请求上下文串，作为数据审计日志每条记录的 ctx 前缀，
   * 用于把同一次 HTTP 请求在运行日志/审计日志里的多条记录串起来，并记录本次变更所基于的数据库版本号
   * （日后出现 409 冲突或数据对不上时可据此定位是哪一次写、基于哪个版本）。
   * @returns {string} 形如 `req=ab12cd34 PUT /api/ledger-items/x/daily/2026-09-03 baseVer=5 dbVer=5`
   */
  private static auditCtx(): string {
    const c = RequestContext.getStore();
    const bits: string[] = [];
    if (c?.reqId) bits.push(`req=${c.reqId}`);
    if (c?.method && c?.url) bits.push(`${c.method} ${c.url}`);
    else if (c?.url) bits.push(c.url);
    bits.push(`baseVer=${c?.baseVersion ?? "∅"}`);
    bits.push(`dbVer=${StorageService.getDbVersion()}`);
    return bits.join(" ");
  }

  /**
   * @description auditCtx 的轻量版：只取 RequestContext 里的 reqId，**不查询数据库**。
   * 供 SQLite verbose 回调使用——那里若调用会查询的 auditCtx()/getDbVersion() 会再触发 verbose，造成无限递归。
   * @returns {string} 形如 `req=ab12cd34`（无请求上下文时为空串）
   */
  private static auditCtxLite(): string {
    const c = RequestContext.getStore();
    return c?.reqId ? `req=${c.reqId}` : "";
  }

  /**
   * @description 统计给定原料项 id 集合下的逐日流水**真实全历史**条数与日期范围，供删除类审计日志给出准确的
   * “连带删除 N 条流水 (最早 ~ 最晚)”——不能用 load() 的返回值算，那里只含当前自然月区间。
   * 本地 SQLite 直接对流水表 COUNT/MIN/MAX；COS 模式回退按传入的 items（COS 的 load() 本就返回完整 dailyRecords）统计。
   * @param {string[]} itemIds 原料项 id 列表
   * @param {any[]} fallbackItems COS 模式或本地查询不可用时，据以统计的原料项数组（需含完整 dailyRecords）
   * @returns {{ count: number; minDate: string | null; maxDate: string | null }}
   */
  private static countItemDailyRecords(
    itemIds: string[],
    fallbackItems: Array<{ id: string; dailyRecords?: Record<string, unknown> }>
  ): { count: number; minDate: string | null; maxDate: string | null } {
    if (itemIds.length === 0) return { count: 0, minDate: null, maxDate: null };
    if (StorageService.storageType === "local") {
      try {
        const db = StorageService.getDb();
        const placeholders = itemIds.map(() => "?").join(",");
        const row = db
          .prepare(`SELECT COUNT(*) AS count, MIN(date) AS minDate, MAX(date) AS maxDate FROM ledger_item_daily_records WHERE item_id IN (${placeholders})`)
          .get(...itemIds) as { count: number; minDate: string | null; maxDate: string | null };
        return { count: row?.count ?? 0, minDate: row?.minDate ?? null, maxDate: row?.maxDate ?? null };
      } catch (err) {
        console.error("[STORAGE SQLITE] 统计逐日流水条数失败，回退按内存统计:", err);
      }
    }
    const idSet = new Set(itemIds);
    const dates: string[] = [];
    for (const it of fallbackItems) {
      if (idSet.has(it.id)) dates.push(...Object.keys(it.dailyRecords ?? {}));
    }
    dates.sort();
    return { count: dates.length, minDate: dates[0] ?? null, maxDate: dates[dates.length - 1] ?? null };
  }

  /**
   * @description 把一个异步任务放入写锁队列：等前面所有排队中的任务完成后再执行当前任务，并在完成后释放锁供下一个任务使用
   * @param {() => Promise<T> | T} task 需要互斥执行的任务
   * @returns {Promise<T>} 任务的执行结果
   */
  private static async withWriteLock<T>(task: () => Promise<T> | T): Promise<T> {
    const previous = StorageService.writeLock;
    let release!: () => void;
    StorageService.writeLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const ctx = RequestContext.getStore();
      const baseVersion = ctx?.baseVersion;
      if (baseVersion !== undefined && StorageService.storageType === "local") {
        const currentVersion = StorageService.getDbVersion();
        if (baseVersion < currentVersion) {
          throw new Error("VERSION_CONFLICT");
        }
      }

      const result = await task();

      StorageService.incrementDbVersion();

      return result;
    } finally {
      release();
    }
  }

  /**
   * @description 当检测到 SQLite 为空时，在服务端内部直接生成所有的默认种子数据，
   * 包含台账、三大受众、各类配置项与基础词典。避免再由前端发现后反向推送。
   * @returns {any} 全量的后端存储快照格式数据
   */
  private static generateDefaultSeeds(): any {
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;

    // 1. active_groups
    const activeGroups: DynamicGroup[] = [
      { key: "KID", label: "幼儿", emoji: "👶", isDefault: true },
      { key: "STUDENT", label: "在校生", emoji: "🎓", isDefault: true },
      { key: "TEACHER", label: "教师", emoji: "👨‍🏫", isDefault: true }
    ];

    // 2. active_categories
    const activeCategories: DynamicCategory[] = [
      { key: "VEGETABLE", label: "蔬菜", isDefault: true },
      { key: "GRAIN_OIL", label: "粮油", isDefault: true },
      { key: "SEASONING", label: "调味品", isDefault: true },
      { key: "MEAT", label: "肉蛋", isDefault: true },
      { key: "LOW_CONSUMP", label: "低耗品", isDefault: true },
      { key: "FRUIT", label: "水果", isDefault: true }
    ];

    // 3. raw_materials_dict
    const rawMaterialsDict: RawMaterialDictItem[] = RawMaterialsDictService.getDefaultSeedList().map((item) => ({
      ...item,
      isDefault: true
    }));

    // 4. ledgers (与 activeGroups 一一对齐)
    const ledgers: Ledger[] = activeGroups.map((group) => ({
      id: group.key,
      name: group.label,
      createdAt: new Date().toISOString()
    }));
    const ledgerItems: LedgerItem[] = []; // 台账内容保持为空，等用户自行录入

    // 5. ledgerHelperDict
    const ledgerHelperDict: Record<string, string[]> = {
      suppliers: ["宾县宾州家家乐粮油店", "宾县鑫百达百货超市"], // 默认供货商
      buyers: [],                            // 默认采购员
      inspectors: ["王振东"],                                 // 默认检验员
      keepers: ["陈洪星"],                           // 默认保管员
      outHandlers: ["王振东"],                                // 默认发料人
      outRecipients: ["孙长玲"],                              // 默认接收人
      sensoryOptions: ["包装完整", "米粒饱满", "新鲜", "有光泽", "味正", "颜色好", "肉鲜", "新鲜光滑", "鲜", "嫩", "绿", "色泽鲜亮", "形状饱满", "光泽度好", "颜色鲜艳"], // 默认感官性状
      shelfLifeOptions: ["15天", "1个月", "6个月", "1年"]         // 默认保质期
    };

    return {
      ledgers,
      ledgerItems,

      activeGroups,
      activeCategories,
      rawMaterialsDict,
      ledgerHelperDict,
      isFirstBoot: true // 告诉前端清除旧的本地缓存
    };
  }

  /**
   * @description 获取（并按需懒创建）本地 SQLite 数据库连接与规范化的关系型表结构。
   * 按业务实体拆成了 8 张真正的关系型表（ledgers/ledger_items/ledger_item_daily_records/
   * active_groups/active_categories/raw_materials_dict/ledger_helper_options/sys_config），
   * 获得可索引查询、字段级类型约束等关系型数据库的实质好处。
   * 早期版本遗留的 kv_store/daily_records 两张表、以及后来被证实是冗余双轨的 reports/prepared_items/
   * prepared_item_daily_data 三张备餐报表表均予以主动清空（DROP TABLE IF EXISTS）——TableGrid 等展示
   * 视图现在直接以 ledger_items/ledger_item_daily_records 实时派生渲染，不再需要一份独立同步维护的报表，
   * 系统尚未正式上线、无需保留任何历史迁移兼容路径。
   * @returns {Database.Database} SQLite 数据库连接
   */
  private static getDb(): Database.Database {
    if (!StorageService.db) {
      // 低层 SQL 逐句追踪：设置环境变量 KPMSS_SQL_TRACE=1 后，better-sqlite3 每执行一条 SQL（含 BEGIN/COMMIT/
      // ROLLBACK、每一条 SELECT/INSERT/UPDATE/DELETE）都会回调，把语句原文写进数据审计日志 audit-*.log。
      // 默认关闭：它会把每次 GET /load 的多条 SELECT 也打出来，量很大，只在排查“数据库到底发生了什么”时临时开。
      const sqlTrace = process.env.KPMSS_SQL_TRACE === "1" || process.env.KPMSS_SQL_TRACE === "true";
      StorageService.db = new Database(
        StorageService.sqliteDbPath,
        sqlTrace
          ? {
              verbose: (sql?: unknown) => {
                try {
                  // 用 auditCtxLite（不查库）避免在 verbose 里再触发查询导致无限递归
                  LogService.audit("sqlite.exec", String(sql).replace(/\s+/g, " ").trim(), StorageService.auditCtxLite());
                } catch {
                  /* 日志失败绝不能影响数据库操作本身 */
                }
              }
            }
          : undefined
      );
      // WAL 模式：写入不阻塞并发读取，且每次事务提交都由 SQLite 引擎保证落盘的原子性与崩溃恢复能力
      StorageService.db.pragma("journal_mode = WAL");
      StorageService.db.exec(`
        -- 早期版本遗留表，主动清空（幂等，已清空的库上是无操作）
        DROP TABLE IF EXISTS kv_store;
        DROP TABLE IF EXISTS daily_records;
        
        -- 本次架构重构：删减被废弃的冗余备餐表
        DROP TABLE IF EXISTS reports;
        DROP TABLE IF EXISTS prepared_items;
        DROP TABLE IF EXISTS prepared_item_daily_data;

        -- 规范化关系型表结构
        CREATE TABLE IF NOT EXISTS ledgers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ledger_items (
          id TEXT PRIMARY KEY,
          ledger_id TEXT NOT NULL,
          name TEXT NOT NULL,
          unit TEXT NOT NULL,
          spec TEXT,
          -- category：原料所属二级大类的**快照**。新建原料项时从原料字典抄一次，此后字典怎么改名/删除都不影响台账。
          -- 台账展示层直接读这一列，不再回原料字典按 name 反查（字典与台账彻底解耦）。
          category TEXT,
          initial_stock REAL NOT NULL DEFAULT 0,
          current_stock REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_items_ledger_id ON ledger_items(ledger_id);

        -- 台账每日出入库流水：按 (item_id, date) 存放，字段级展开而非整块 JSON 文本
        CREATE TABLE IF NOT EXISTS ledger_item_daily_records (
          item_id TEXT NOT NULL,
          date TEXT NOT NULL,
          in_quantity REAL NOT NULL DEFAULT 0,
          in_price REAL NOT NULL DEFAULT 0,
          in_amount REAL NOT NULL DEFAULT 0,
          out_quantity REAL NOT NULL DEFAULT 0,
          out_price REAL,
          out_amount REAL,
          note TEXT,
          certification TEXT,
          sensory_property TEXT,
          supplier TEXT,
          purchase_date TEXT,
          buyer TEXT,
          inspector TEXT,
          keeper TEXT,
          produce_date TEXT,
          shelf_life TEXT,
          out_handler TEXT,
          out_recipient TEXT,
          conversion_unit_quantity REAL,
          out_date TEXT,
          PRIMARY KEY (item_id, date)
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_daily_date ON ledger_item_daily_records(date);


        CREATE TABLE IF NOT EXISTS active_groups (
          key TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          emoji TEXT,
          is_default INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS active_categories (
          key TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          is_default INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS raw_materials_dict (
          name TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          unit TEXT NOT NULL,
          remark TEXT,
          conversion_unit TEXT,
          conversion_ratio REAL,
          is_default INTEGER NOT NULL DEFAULT 0
        );

        -- ledgerHelperDict 的 8 个 string[] 字段打平存储；sort_order 保留管理员维护的原始顺序
        CREATE TABLE IF NOT EXISTS ledger_helper_options (
          category TEXT NOT NULL,
          value TEXT NOT NULL,
          sort_order INTEGER NOT NULL,
          PRIMARY KEY (category, value)
        );

        CREATE TABLE IF NOT EXISTS sys_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT OR IGNORE INTO sys_config (key, value) VALUES ('db_version', '1');
      `);

      // 幂等升级：旧库的 ledger_items 没有 category 列时补上，并按 name 从原料字典回填一次历史行。
      // 这是一次性的解耦迁移——回填后台账不再依赖字典，字典改动不会再回来动这一列。
      // ALTER 与回填 UPDATE 放在同一个事务里，避免"加了列但没回填"的半迁移状态（一旦发生，下次启动因
      // PRAGMA 已能查到 category 列而整段跳过，NULL 会一直留着）。
      const ledgerItemCols = StorageService.db
        .prepare("PRAGMA table_info(ledger_items)")
        .all() as Array<{ name: string }>;
      if (!ledgerItemCols.some((c) => c.name === "category")) {
        StorageService.db.transaction(() => {
          StorageService.db!.exec("ALTER TABLE ledger_items ADD COLUMN category TEXT");
          StorageService.db!.exec(`
            UPDATE ledger_items
            SET category = (SELECT rm.category FROM raw_materials_dict rm WHERE rm.name = ledger_items.name)
            WHERE category IS NULL
          `);
        })();
        console.log("[SYSTEM BOOT] 已为 ledger_items 增加 category 快照列，并按原料字典回填历史行（此后台账与字典解耦）");
      }

      if (StorageService.countNormalizedRows(StorageService.db) === 0) {
        if (process.env.SKIP_SEEDING === "1") {
          console.log("[SYSTEM BOOT] 数据库全表空置，当前处于测试模式并设置了 SKIP_SEEDING，跳过自动注入种子数据...");
        } else {
          console.log("[SYSTEM BOOT] 数据库全表空置，准备在后端直接生成并注入默认种子数据...");
          const defaultData = StorageService.generateDefaultSeeds();
          // 因为这是一个本地启动初始化时的调用，直接调用 upsertSkeleton 写入数据。
          // 它会通过 delete + insert 的方式进行注入
          StorageService.upsertSkeleton(StorageService.db, defaultData);
          console.log("[SYSTEM BOOT] 已在后端自动生成并注入默认种子数据完成");
        }
      } else {
        // 数据表非空，但检查是否存在核心配置表因旧版备份恢复被意外清空的情况
        const groupCount = StorageService.db.prepare("SELECT COUNT(*) as c FROM active_groups").get() as { c: number };
        if (groupCount.c === 0 && process.env.SKIP_SEEDING !== "1") {
          console.log("[SYSTEM BOOT] 检测到 active_groups 为空 (可能由于旧版备份覆盖导致)，启动种子数据自动修复...");
          const defaultData = StorageService.generateDefaultSeeds();
          // 利用 upsertSkeleton 现有的选择性覆盖特性，只修复这四张配置表，不触碰用户的台账与备餐记录
          StorageService.upsertSkeleton(StorageService.db, {
            activeGroups: defaultData.activeGroups,
            activeCategories: defaultData.activeCategories,
            rawMaterialsDict: defaultData.rawMaterialsDict,
            ledgerHelperDict: defaultData.ledgerHelperDict
          });
          console.log("[SYSTEM BOOT] 种子数据自动修复完成");
        }
      }
    }
    return StorageService.db;
  }

  /**
   * @description 统计规范化表结构里一共有多少行数据，用于判断"是否首次启动/是否需要迁移"
   * @param {Database.Database} db SQLite 数据库连接
   * @returns {number} 规范化表结构的数据总行数
   */
  private static countNormalizedRows(db: Database.Database): number {
    return NORMALIZED_TABLES.reduce((sum, table) => {
      const row = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
      return sum + row.c;
    }, 0);
  }

  /**
   * @description 覆盖写入"骨架"部分：ledgers / ledger_items（不含每日流水）/ active_groups /
   * active_categories / raw_materials_dict / ledger_helper_options。
   * 不涉及 ledger_item_daily_records，供首次启动生成默认种子数据、以及修复被意外清空的配置表使用；
   * 正常保存路径走的是 applyChangesIntoSqlite() 的增量 upsert/delete，不使用整体覆盖。
   * @param {Database.Database} db SQLite 数据库连接
   * @param {any} data 需要写入的全量数据包
   * @returns {void}
   */
  private static upsertSkeleton(db: Database.Database, data: any): void {
    // 1. ledgers
    if (data.ledgers !== undefined) {
      db.prepare("DELETE FROM ledgers").run();
      const insertLedger = db.prepare("INSERT INTO ledgers (id, name, created_at) VALUES (?, ?, ?)");
      for (const l of data.ledgers) {
        insertLedger.run(l.id, l.name, l.createdAt);
      }
    }

    // 2. ledger_items（骨架，不含每日流水）
    if (data.ledgerItems !== undefined) {
      db.prepare("DELETE FROM ledger_items").run();
      const insertItem = db.prepare(
        "INSERT INTO ledger_items (id, ledger_id, name, unit, spec, category, initial_stock, current_stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const item of data.ledgerItems) {
        insertItem.run(item.id, item.ledgerId, item.name, item.unit, item.spec ?? null, item.category ?? null, item.initialStock ?? 0, item.currentStock ?? 0);
      }
    }

    // 3. active_groups / active_categories
    if (data.activeGroups !== undefined) {
      db.prepare("DELETE FROM active_groups").run();
      const insertGroup = db.prepare("INSERT INTO active_groups (key, label, emoji, is_default) VALUES (?, ?, ?, ?)");
      for (const g of data.activeGroups) {
        insertGroup.run(g.key, g.label, g.emoji ?? null, g.isDefault ? 1 : 0);
      }
    }
    if (data.activeCategories !== undefined) {
      db.prepare("DELETE FROM active_categories").run();
      const insertCategory = db.prepare("INSERT INTO active_categories (key, label, is_default) VALUES (?, ?, ?)");
      for (const c of data.activeCategories) {
        insertCategory.run(c.key, c.label, c.isDefault ? 1 : 0);
      }
    }

    // 4. raw_materials_dict
    if (data.rawMaterialsDict !== undefined) {
      db.prepare("DELETE FROM raw_materials_dict").run();
      const insertDictItem = db.prepare(
        "INSERT INTO raw_materials_dict (name, category, unit, remark, conversion_unit, conversion_ratio, is_default) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      for (const d of data.rawMaterialsDict) {
        insertDictItem.run(d.name, d.category, d.unit, d.remark ?? null, d.conversionUnit ?? null, d.conversionRatio ?? null, d.isDefault ? 1 : 0);
      }
    }

    // 5. ledger_helper_options
    if (data.ledgerHelperDict !== undefined) {
      db.prepare("DELETE FROM ledger_helper_options").run();
      const insertHelperOption = db.prepare("INSERT INTO ledger_helper_options (category, value, sort_order) VALUES (?, ?, ?)");
      const helperDict = data.ledgerHelperDict;
      for (const category of HELPER_DICT_CATEGORIES) {
        const values: string[] = helperDict[category] ?? [];
        values.forEach((value, idx) => insertHelperOption.run(category, value, idx));
      }
    }
  }

  /**
   * @description 增量写入专用的 prepared statement 缓存（按名称缓存，避免每次防抖 flush 都重新 db.prepare()）。
   * 与 upsertSkeleton（全量重建路径，专供备份恢复使用）完全独立、互不复用，避免为了减少一点重复 SQL 文本
   * 而让这两套本质不同的写入路径产生耦合。
   */
  private static incrementalStmts: Map<string, Database.Statement> | null = null;

  /**
   * @description 懒加载并返回增量写入用的 prepared statement 缓存
   * @param {Database.Database} db SQLite 数据库连接
   * @returns {Map<string, Database.Statement>} 按名称索引的 prepared statement 缓存
   */
  private static getIncrementalStmts(db: Database.Database): Map<string, Database.Statement> {
    if (!StorageService.incrementalStmts) {
      const stmts = new Map<string, Database.Statement>();
      stmts.set("upsertLedger", db.prepare(
        "INSERT INTO ledgers (id, name, created_at) VALUES (@id, @name, @createdAt) " +
        "ON CONFLICT(id) DO UPDATE SET name = @name, created_at = @createdAt"
      ));
      stmts.set("deleteLedger", db.prepare("DELETE FROM ledgers WHERE id = ?"));
      stmts.set("upsertLedgerItem", db.prepare(
        "INSERT INTO ledger_items (id, ledger_id, name, unit, spec, category, initial_stock, current_stock) " +
        "VALUES (@id, @ledgerId, @name, @unit, @spec, @category, @initialStock, @currentStock) " +
        "ON CONFLICT(id) DO UPDATE SET ledger_id=@ledgerId, name=@name, unit=@unit, spec=@spec, category=@category, " +
        "initial_stock=@initialStock, current_stock=@currentStock"
      ));
      stmts.set("deleteLedgerItem", db.prepare("DELETE FROM ledger_items WHERE id = ?"));
      stmts.set("deleteDailyRecordsByItem", db.prepare("DELETE FROM ledger_item_daily_records WHERE item_id = ?"));
      stmts.set("upsertDailyRecord", db.prepare(`
        INSERT INTO ledger_item_daily_records
          (item_id, date, in_quantity, in_price, in_amount, out_quantity, out_price, out_amount, note,
           certification, sensory_property, supplier, purchase_date, buyer, inspector, keeper,
           produce_date, shelf_life, out_handler, out_recipient, conversion_unit_quantity, out_date)
        VALUES
          (@itemId, @date, @inQuantity, @inPrice, @inAmount, @outQuantity, @outPrice, @outAmount, @note,
           @certification, @sensoryProperty, @supplier, @purchaseDate, @buyer, @inspector, @keeper,
           @produceDate, @shelfLife, @outHandler, @outRecipient, @conversionUnitQuantity, @outDate)
        ON CONFLICT(item_id, date) DO UPDATE SET
          in_quantity=@inQuantity, in_price=@inPrice, in_amount=@inAmount, out_quantity=@outQuantity,
          out_price=@outPrice, out_amount=@outAmount, note=@note, certification=@certification,
          sensory_property=@sensoryProperty, supplier=@supplier, purchase_date=@purchaseDate, buyer=@buyer,
          inspector=@inspector, keeper=@keeper, produce_date=@produceDate, shelf_life=@shelfLife,
          out_handler=@outHandler, out_recipient=@outRecipient,
          conversion_unit_quantity=@conversionUnitQuantity, out_date=@outDate
      `));
      stmts.set("deleteDailyRecord", db.prepare("DELETE FROM ledger_item_daily_records WHERE item_id = ? AND date = ?"));

      stmts.set("upsertActiveGroup", db.prepare(
        "INSERT INTO active_groups (key, label, emoji, is_default) VALUES (@key, @label, @emoji, @isDefault) " +
        "ON CONFLICT(key) DO UPDATE SET label=@label, emoji=@emoji, is_default=@isDefault"
      ));
      stmts.set("deleteActiveGroup", db.prepare("DELETE FROM active_groups WHERE key = ?"));
      stmts.set("upsertActiveCategory", db.prepare(
        "INSERT INTO active_categories (key, label, is_default) VALUES (@key, @label, @isDefault) " +
        "ON CONFLICT(key) DO UPDATE SET label=@label, is_default=@isDefault"
      ));
      stmts.set("deleteActiveCategory", db.prepare("DELETE FROM active_categories WHERE key = ?"));
      stmts.set("upsertRawMaterial", db.prepare(
        "INSERT INTO raw_materials_dict (name, category, unit, remark, conversion_unit, conversion_ratio, is_default) " +
        "VALUES (@name, @category, @unit, @remark, @conversionUnit, @conversionRatio, @isDefault) " +
        "ON CONFLICT(name) DO UPDATE SET category=@category, unit=@unit, remark=@remark, " +
        "conversion_unit=@conversionUnit, conversion_ratio=@conversionRatio, is_default=@isDefault"
      ));
      stmts.set("deleteRawMaterial", db.prepare("DELETE FROM raw_materials_dict WHERE name = ?"));
      stmts.set("deleteHelperCategory", db.prepare("DELETE FROM ledger_helper_options WHERE category = ?"));
      stmts.set("insertHelperOption", db.prepare("INSERT INTO ledger_helper_options (category, value, sort_order) VALUES (?, ?, ?)"));
      StorageService.incrementalStmts = stmts;
    }
    return StorageService.incrementalStmts;
  }

  /**
   * @description 把一条台账逐日流水记录（可能字段不全）规整成 upsertDailyRecord 需要的具名参数对象
   * @param {string} itemId 台账原料项 id
   * @param {string} date 日期字符串
   * @param {any} record 逐日流水记录（可能为 undefined）
   * @returns {any} 具名参数对象
   */
  private static toDailyRecordParams(itemId: string, date: string, record: any) {
    return {
      itemId, date,
      inQuantity: record?.inQuantity ?? 0, inPrice: record?.inPrice ?? 0, inAmount: record?.inAmount ?? 0,
      outQuantity: record?.outQuantity ?? 0, outPrice: record?.outPrice ?? null, outAmount: record?.outAmount ?? null,
      note: record?.note ?? null, certification: record?.certification ?? null, sensoryProperty: record?.sensoryProperty ?? null,
      supplier: record?.supplier ?? null, purchaseDate: record?.purchaseDate ?? null, buyer: record?.buyer ?? null,
      inspector: record?.inspector ?? null, keeper: record?.keeper ?? null, produceDate: record?.produceDate ?? null,
      shelfLife: record?.shelfLife ?? null, outHandler: record?.outHandler ?? null, outRecipient: record?.outRecipient ?? null,
      conversionUnitQuantity: record?.conversionUnitQuantity ?? null, outDate: record?.outDate ?? null
    };
  }

  /**
   * @description 增量应用一批同步操作到规范化关系型表，包裹在同一个 SQLite 事务里（整批要么全部生效、要么全部回滚）。
   * 与 upsertSkeleton 的"全量 DELETE+INSERT 重建"不同，这里只对 op 里明确指出的实体/主键做目标 upsert/delete。
   * 由于当前 schema 未声明任何 ON DELETE CASCADE（全量重建靠"删光重插"隐式达到级联效果），
   * 这里对有子表的实体删除操作必须显式做级联清理，否则会留下孤儿行。
   * @param {SyncOp[]} ops 一批增量同步操作
   * @returns {void}
   */
  private static applyChangesIntoSqlite(ops: SyncOp[]): void {
    const db = StorageService.getDb();
    const stmts = StorageService.getIncrementalStmts(db);

    // 逐条 prepared statement 的执行留痕：语句名 + 绑定参数 + 数据库层面实际影响的行数（changes）。
    // 这是回溯“某次写操作在数据库里到底动了哪几行”的关键——例如一条 delete 打出 changes=0 就说明
    // 代码以为删掉了什么、其实那行根本不存在；一条本该 insert 的 upsert 打出 changes=1 且无 rowid
    // 则说明命中了 ON CONFLICT 更新了已有行。始终开启（仅写操作触发，量不大）。
    const trace: string[] = [];
    const runStmt = (name: string, ...args: any[]): Database.RunResult => {
      const info = stmts.get(name)!.run(...args);
      const argStr =
        args.length === 1 && typeof args[0] === "object" && args[0] !== null
          ? JSON.stringify(args[0])
          : JSON.stringify(args);
      const rowid = /^(upsert|insert)/.test(name) && info.changes > 0 ? ` rowid=${info.lastInsertRowid}` : "";
      trace.push(`${name}(${argStr}) -> changes=${info.changes}${rowid}`);
      return info;
    };

    const run = db.transaction((batch: SyncOp[]) => {
      for (const op of batch) {
        if (op.op === "replaceAll") {
          trace.push(`replaceAll:${op.entity}(rows=${Array.isArray(op.data) ? op.data.length : 0})`);
          StorageService.applyReplaceAllIntoSqlite(db, stmts, op);
          continue;
        }
        switch (op.entity) {
          case "ledger":
            if (op.op === "delete") {
              runStmt("deleteLedger", op.key);
            } else {
              runStmt("upsertLedger", { id: op.data.id, name: op.data.name, createdAt: op.data.createdAt });
            }
            break;

          case "ledgerItem":
            if (op.op === "delete") {
              // 无 FK 级联声明，显式先清空该原料项的全部逐日流水，再删骨架行，避免留下孤儿流水行
              runStmt("deleteDailyRecordsByItem", op.key);
              runStmt("deleteLedgerItem", op.key);
            } else {
              const d = op.data;
              runStmt("upsertLedgerItem", {
                id: d.id, ledgerId: d.ledgerId, name: d.name, unit: d.unit,
                spec: d.spec ?? null, category: d.category ?? null,
                initialStock: d.initialStock ?? 0, currentStock: d.currentStock ?? 0
              });
            }
            break;

          case "ledgerItemDailyRecord": {
            const key = op.key as { itemId: string; date: string };
            if (op.op === "delete") {
              runStmt("deleteDailyRecord", key.itemId, key.date);
            } else {
              runStmt("upsertDailyRecord", StorageService.toDailyRecordParams(key.itemId, key.date, op.data));
            }
            break;
          }



          case "activeGroup":
            if (op.op === "delete") {
              runStmt("deleteActiveGroup", op.key);
            } else {
              const d = op.data;
              runStmt("upsertActiveGroup", { key: d.key, label: d.label, emoji: d.emoji ?? null, isDefault: d.isDefault ? 1 : 0 });
            }
            break;

          case "activeCategory":
            if (op.op === "delete") {
              runStmt("deleteActiveCategory", op.key);
            } else {
              const d = op.data;
              runStmt("upsertActiveCategory", { key: d.key, label: d.label, isDefault: d.isDefault ? 1 : 0 });
            }
            break;

          case "rawMaterial":
            if (op.op === "delete") {
              runStmt("deleteRawMaterial", op.key);
            } else {
              const d = op.data;
              // rawMaterial.name 本身是主键且支持改名：改名时先删旧主键行，避免留下 (旧名, 新数据的孤本) 之外的重复行
              if (op.previousKey && op.previousKey !== d.name) {
                runStmt("deleteRawMaterial", op.previousKey);
              }
              runStmt("upsertRawMaterial", {
                name: d.name, category: d.category, unit: d.unit, remark: d.remark ?? null,
                conversionUnit: d.conversionUnit ?? null, conversionRatio: d.conversionRatio ?? null, isDefault: d.isDefault ? 1 : 0
              });
            }
            break;

          case "ledgerHelperOptions": {
            const category = op.key as string;
            runStmt("deleteHelperCategory", category);
            const values: string[] = op.data ?? [];
            values.forEach((value, idx) => runStmt("insertHelperOption", category, value, idx));
            break;
          }

          default:
            throw new Error(`[STORAGE SQLITE] 未知的增量操作实体类型: ${(op as any).entity}`);
        }
      }
    });

    try {
      run(ops);
      LogService.audit(
        "persist.sqlite.stmts",
        `事务提交成功：${ops.length} 个增量操作、${trace.length} 条 SQL | ${trace.join(" ;; ")}`,
        StorageService.auditCtx()
      );
    } catch (err: any) {
      // db.transaction 抛错时 better-sqlite3 已自动 ROLLBACK，这里把回滚前已尝试的语句原样记下来
      LogService.audit(
        "persist.sqlite.rollback",
        `事务执行中抛错并整体回滚（本批 ${ops.length} 个操作全部未生效）| 回滚前已尝试 ${trace.length} 条 SQL: ${trace.join(" ;; ")} | 原因: ${err?.message || String(err)}`,
        StorageService.auditCtx(),
        "error"
      );
      throw err;
    }
  }

  /**
   * @description "replaceAll" 操作的具体应用逻辑：仅供首次启动/批量种子数据生成场景使用，
   * 整批删除并重插入指定实体的全部行（而不是强行拆成逐条 upsert 枚举）。
   * @param {Database.Database} db SQLite 数据库连接
   * @param {Map<string, Database.Statement>} stmts 增量写入 prepared statement 缓存
   * @param {SyncOp} op replaceAll 操作
   * @returns {void}
   */
  private static applyReplaceAllIntoSqlite(db: Database.Database, stmts: Map<string, Database.Statement>, op: SyncOp): void {
    const rows: any[] = op.data ?? [];
    switch (op.entity) {
      case "ledger":
        db.prepare("DELETE FROM ledgers").run();
        for (const l of rows) stmts.get("upsertLedger")!.run({ id: l.id, name: l.name, createdAt: l.createdAt });
        break;

      case "ledgerItem":
        db.prepare("DELETE FROM ledger_item_daily_records").run();
        db.prepare("DELETE FROM ledger_items").run();
        for (const item of rows) {
          stmts.get("upsertLedgerItem")!.run({
            id: item.id, ledgerId: item.ledgerId, name: item.name, unit: item.unit,
            spec: item.spec ?? null, category: item.category ?? null,
            initialStock: item.initialStock ?? 0, currentStock: item.currentStock ?? 0
          });
          for (const [dateStr, record] of Object.entries(item.dailyRecords ?? {}) as [string, any][]) {
            if (!dateStr || !record) continue;
            stmts.get("upsertDailyRecord")!.run(StorageService.toDailyRecordParams(item.id, dateStr, record));
          }
        }
        break;

      case "activeGroup":
        db.prepare("DELETE FROM active_groups").run();
        for (const g of rows) stmts.get("upsertActiveGroup")!.run({ key: g.key, label: g.label, emoji: g.emoji ?? null, isDefault: g.isDefault ? 1 : 0 });
        break;

      case "activeCategory":
        db.prepare("DELETE FROM active_categories").run();
        for (const c of rows) stmts.get("upsertActiveCategory")!.run({ key: c.key, label: c.label, isDefault: c.isDefault ? 1 : 0 });
        break;

      case "rawMaterial":
        db.prepare("DELETE FROM raw_materials_dict").run();
        for (const d of rows) {
          stmts.get("upsertRawMaterial")!.run({
            name: d.name, category: d.category, unit: d.unit, remark: d.remark ?? null,
            conversionUnit: d.conversionUnit ?? null, conversionRatio: d.conversionRatio ?? null, isDefault: d.isDefault ? 1 : 0
          });
        }
        break;

      case "ledgerHelperOptions":
        // 此实体的 replaceAll 用 data: Array<{ category: string; values: string[] }> 的特殊形状
        for (const entry of rows as Array<{ category: string; values: string[] }>) {
          stmts.get("deleteHelperCategory")!.run(entry.category);
          (entry.values ?? []).forEach((value, idx) => stmts.get("insertHelperOption")!.run(entry.category, value, idx));
        }
        break;
    }
  }

  /**
   * @description 从规范化关系型表中读出完整的应用状态对象，支持按日期范围过滤每日数据
   * @param {string} [startDate] 可选。起始日期 (YYYY-MM-DD)，如果不传则返回全量或默认逻辑
   * @param {string} [endDate] 可选。结束日期 (YYYY-MM-DD)
   * @returns {any} 完整的应用状态对象
   */
  private static readDataFromSqlite(startDate?: string, endDate?: string): any {
    const db = StorageService.getDb();
    if (StorageService.countNormalizedRows(db) === 0) {
      // 骨架表全空——正常是首次启动，返回 {} 让上层判定 isFirstBoot 并清浏览器旧缓存。
      // 但若逐日流水表里还有孤儿行（坏迁移 / 手工改库遗留），说明这库并不“干净空”，此时返回 {} 会误清用户
      // 浏览器里的登录态/草稿等本地缓存。这种情况下按“非首启”继续走下面的正常读取（返回空骨架 + 现有配置）。
      const orphanDaily = (db.prepare("SELECT COUNT(*) AS c FROM ledger_item_daily_records").get() as { c: number }).c;
      if (orphanDaily === 0) {
        return {};
      }
      console.warn(`[STORAGE SQLITE] 骨架表全空但检测到 ${orphanDaily} 条孤儿逐日流水（疑似坏迁移/手工改库），按非首启继续读取，避免前端误清本地缓存`);
    }

    const ledgers = db.prepare("SELECT id, name, created_at as createdAt FROM ledgers").all();

    // currentStock 一律由 initialStock + 全历史入库累计 − 全历史出库累计 现算，不读 li.current_stock 存量列：
    // 存量列的维护历来只按“写操作发生当时前端加载的月份区间”重算，跨月编辑会写歪；这里以逐日流水表的无条件
    // SUM 为准，使 GET /load 返回的 currentStock 永远是真实库存，并自动修复任何历史写歪的存量值。
    // historicalFirst/LastRecordDate 是对该原料**全部**逐日流水（无日期过滤）的 MIN/MAX(date)，
    // 供前端在按月懒加载、内存里只有部分月份数据时，仍能准确判断"这本台账最近一次录入是哪天"，
    // 避免出现"明明 8-28 有记录却提示最近是 9-23"这类因视野不全导致的误报。
    const ledgerItemsRaw = db.prepare(`
      SELECT li.id, li.ledger_id as ledgerId, li.name, li.unit, li.spec, li.category, li.initial_stock as initialStock,
             (li.initial_stock + COALESCE(SUM(dr.in_quantity), 0) - COALESCE(SUM(dr.out_quantity), 0)) as currentStock,
             COALESCE(SUM(dr.in_quantity), 0) as historicalTotalIn,
             COALESCE(SUM(dr.out_quantity), 0) as historicalTotalOut,
             COALESCE(SUM(dr.in_amount), 0) as historicalTotalInAmount,
             MIN(dr.date) as historicalFirstRecordDate,
             MAX(dr.date) as historicalLastRecordDate
      FROM ledger_items li
      LEFT JOIN ledger_item_daily_records dr ON li.id = dr.item_id
      GROUP BY li.id
    `).all() as any[];

    let filterStart = startDate;
    let filterEnd = endDate;
    if (!filterStart || !filterEnd) {
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      filterStart = `${y}-${m}-01`;
      filterEnd = `${y}-${m}-${new Date(y, now.getMonth() + 1, 0).getDate()}`;
    }

    let dailyRowsSql = `
      SELECT item_id as itemId, date, in_quantity as inQuantity, in_price as inPrice, in_amount as inAmount,
             out_quantity as outQuantity, out_price as outPrice, out_amount as outAmount, note, certification,
             sensory_property as sensoryProperty, supplier, purchase_date as purchaseDate, buyer, inspector, keeper,
             produce_date as produceDate, shelf_life as shelfLife, out_handler as outHandler, out_recipient as outRecipient,
             conversion_unit_quantity as conversionUnitQuantity, out_date as outDate
      FROM ledger_item_daily_records
      WHERE date >= ? AND date <= ?
    `;
    const dailyRowsParams = [filterStart, filterEnd];
    const dailyRows = db.prepare(dailyRowsSql).all(...dailyRowsParams) as any[];
    const dailyByItem: Record<string, Record<string, any>> = {};
    for (const row of dailyRows) {
      const { itemId, date, ...record } = row;
      if (!dailyByItem[itemId]) dailyByItem[itemId] = {};
      dailyByItem[itemId][date] = record;
    }
    const ledgerItems = ledgerItemsRaw.map((item) => ({
      ...item,
      dailyRecords: dailyByItem[item.id] || {}
    }));

    const rawMaterialsDict = (db.prepare(`
      SELECT name, category, unit, remark, conversion_unit as conversionUnit, conversion_ratio as conversionRatio, is_default as isDefault
      FROM raw_materials_dict
    `).all() as any[]).map((d) => ({ ...d, isDefault: !!d.isDefault }));

    const activeGroups = (db.prepare("SELECT key, label, emoji, is_default as isDefault FROM active_groups").all() as any[])
      .map((g) => ({ key: g.key, label: g.label, emoji: g.emoji, isDefault: !!g.isDefault }));
    const activeCategories = (db.prepare("SELECT key, label, is_default as isDefault FROM active_categories").all() as any[])
      .map((c) => ({ key: c.key, label: c.label, isDefault: !!c.isDefault }));



    const helperRows = db.prepare("SELECT category, value FROM ledger_helper_options ORDER BY category, sort_order").all() as Array<{ category: string; value: string }>;
    const ledgerHelperDict: Record<string, string[]> = {};
    for (const category of HELPER_DICT_CATEGORIES) {
      ledgerHelperDict[category] = [];
    }
    for (const row of helperRows) {
      if (!ledgerHelperDict[row.category]) ledgerHelperDict[row.category] = [];
      ledgerHelperDict[row.category].push(row.value);
    }

    return { activeGroups, activeCategories, ledgers, ledgerItems, rawMaterialsDict, ledgerHelperDict };
  }

  /**
   * @description 初始化存储引擎，创建必要的本地目录、打开 SQLite 连接
   * @returns {void}
   */
  public static init(): void {
    if (StorageService.storageType === "local") {
      const dir = StorageService.localDataDir;
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`[STORAGE] 已成功创建本地数据存储目录: ${dir}`);
      }
      // 立即建立数据库连接并执行 schema 初始化（含早期遗留表的 DROP TABLE IF EXISTS 清理），不等到首次 load()/save() 才懒加载
      StorageService.getDb();
    } else {
      console.log("[STORAGE] 启动云端存储模式：已挂载腾讯云 COS 同步总线。");
    }
  }

  /**
   * @description 从腾讯云 COS 拉取当前主数据对象（内部专用，供 load() 与增量写入路径共用读取逻辑）
   * @returns {Promise<any>} 当前云端主数据对象；不存在或解析失败时返回 {}
   */
  private static async loadCurrentFromCos(): Promise<any> {
    const { Bucket, Region, Key } = StorageService.getCosConfig();
    return new Promise((resolve) => {
      StorageService.getCosClient().getObject({
        Bucket,
        Region,
        Key
      }, (err, data) => {
        if (err) {
          // 如果文件不存在 (404 / NoSuchKey)，则返回空对象，供前端自行初始化默认值
          if (err.statusCode === 404 || err.code === "NoSuchKey") {
            console.log("[STORAGE COS] COS上暂无数据文件，将返回空初始集。");
            resolve({});
          } else {
            console.error("[STORAGE COS] 从腾讯云拉取数据失败:", err);
            resolve({});
          }
        } else {
          try {
            const bodyStr = data.Body.toString("utf8");
            resolve(JSON.parse(bodyStr));
          } catch (parseErr) {
            console.error("[STORAGE COS] 解析云端JSON失败:", parseErr);
            resolve({});
          }
        }
      });
    });
  }

  public static async load(startDate?: string, endDate?: string): Promise<any> {
    let data;
    if (StorageService.storageType === "cos") {
      data = await StorageService.loadCurrentFromCos();
      // COS 不支持服务端过滤，若有需要前端需自行裁剪。这里仍返回全量。
    } else {
      try {
        data = StorageService.readDataFromSqlite(startDate, endDate);
      } catch (err) {
        console.error("[STORAGE SQLITE] 读取本地数据失败:", err);
        data = {};
      }
    }
    data.dbVersion = StorageService.getDbVersion();
    return data;
  }

  /**
   * @description 在内存中把一批增量同步操作应用到一份完整状态对象上，返回应用后的新对象（不修改传入的原对象）。
   * 腾讯云 COS 对象存储没有行级别写入 API，只能整体覆盖对象，因此 COS 模式下的"增量写"实质是
   * "读出当前完整对象→在内存里应用 op 批次→整体覆盖写回"，增量写入带来的收益（更小的写入体积、更少的全量重建）
   * 只体现在本地 SQLite 模式下；COS 模式下这是可接受的架构现实，不需要也没有必要单独优化。
   * @param {any} current 当前完整状态对象
   * @param {SyncOp[]} ops 一批增量同步操作
   * @returns {any} 应用完 op 批次后的新状态对象
   */
  private static applyOpsToPlainObject(current: any, ops: SyncOp[]): any {
    const data: any = {
      ledgers: current.ledgers ? [...current.ledgers] : [],
      ledgerItems: current.ledgerItems ? current.ledgerItems.map((i: any) => ({ ...i, dailyRecords: { ...(i.dailyRecords ?? {}) } })) : [],

      activeGroups: current.activeGroups ? [...current.activeGroups] : [],
      activeCategories: current.activeCategories ? [...current.activeCategories] : [],
      rawMaterialsDict: current.rawMaterialsDict ? [...current.rawMaterialsDict] : [],
      ledgerHelperDict: current.ledgerHelperDict ? { ...current.ledgerHelperDict } : {}
    };

    const findLedgerItem = (id: string) => data.ledgerItems.find((i: any) => i.id === id);
    for (const op of ops) {
      if (op.op === "replaceAll") {
        const rows = op.data ?? [];
        switch (op.entity) {
          case "ledger": data.ledgers = rows; break;
          case "ledgerItem": data.ledgerItems = rows.map((item: any) => ({ ...item, dailyRecords: item.dailyRecords ?? {} })); break;

          case "activeGroup": data.activeGroups = rows; break;
          case "activeCategory": data.activeCategories = rows; break;
          case "rawMaterial": data.rawMaterialsDict = rows; break;
          case "ledgerHelperOptions":
            data.ledgerHelperDict = Object.fromEntries(
              (rows as Array<{ category: string; values: string[] }>).map((entry) => [entry.category, entry.values ?? []])
            );
            break;
        }
        continue;
      }
      switch (op.entity) {
        case "ledger":
          data.ledgers = data.ledgers.filter((l: any) => l.id !== op.key);
          if (op.op === "upsert") data.ledgers.push(op.data);
          break;

        case "ledgerItem": {
          const existingDaily = findLedgerItem(op.key)?.dailyRecords ?? {};
          data.ledgerItems = data.ledgerItems.filter((i: any) => i.id !== op.key);
          if (op.op === "upsert") data.ledgerItems.push({ ...op.data, dailyRecords: existingDaily });
          break;
        }

        case "ledgerItemDailyRecord": {
          const key = op.key as { itemId: string; date: string };
          const item = findLedgerItem(key.itemId);
          if (item) {
            if (op.op === "delete") delete item.dailyRecords[key.date];
            else item.dailyRecords[key.date] = op.data;
          }
          break;
        }



        case "activeGroup":
          data.activeGroups = data.activeGroups.filter((g: any) => g.key !== op.key);
          if (op.op === "upsert") data.activeGroups.push(op.data);
          break;

        case "activeCategory":
          data.activeCategories = data.activeCategories.filter((c: any) => c.key !== op.key);
          if (op.op === "upsert") data.activeCategories.push(op.data);
          break;

        case "rawMaterial": {
          const previousKey = op.previousKey;
          data.rawMaterialsDict = data.rawMaterialsDict.filter((d: any) => d.name !== op.key && (!previousKey || d.name !== previousKey));
          if (op.op === "upsert") data.rawMaterialsDict.push(op.data);
          break;
        }

        case "ledgerHelperOptions":
          data.ledgerHelperDict[op.key as string] = op.data ?? [];
          break;
      }
    }
    return data;
  }

  /**
   * @description 保存一批增量同步操作到引擎
   * @param {SyncOp[]} ops 一批增量同步操作（阶段三·增量写协议，取代此前的"整体状态"参数）
   * @returns {Promise<boolean>} 保存成功返回 true，失败返回 false
   */
  public static async save(ops: SyncOp[]): Promise<boolean> {
    // 整个保存流程（含云端写入、本地 SQLite 事务）都在写锁内串行执行，防止并发触发的多次 save() 交叉写入
    return StorageService.withWriteLock(() => StorageService.saveInternal(ops));
  }

  /**
   * @description 把一批增量 SyncOp 概括成紧凑的一行，用于审计日志（`entity:op:key` 逗号分隔，key 是复合键时取 JSON）
   * @param {SyncOp[]} ops 一批增量同步操作
   * @returns {string} 形如 `ledgerItemDailyRecord:upsert:{"itemId":"x","date":"2026-09-03"}, ledgerItem:upsert:x`
   */
  private static summarizeOps(ops: SyncOp[]): string {
    if (!ops.length) return "(空批次)";
    return ops
      .map((op) => {
        const k = op.key === undefined ? "" : (typeof op.key === "object" ? JSON.stringify(op.key) : String(op.key));
        return `${op.entity}:${op.op}${k ? ":" + k : ""}`;
      })
      .join(", ");
  }

  /**
   * @description save() 的实际执行体，被写锁包裹调用，禁止在锁外单独调用
   * @param {SyncOp[]} ops 一批增量同步操作
   * @returns {Promise<boolean>} 保存成功返回 true，失败返回 false
   */
  private static async saveInternal(ops: SyncOp[]): Promise<boolean> {
    if (StorageService.storageType === "cos") {
      // COS 对象存储没有行级别写入 API，只能整体覆盖：读出当前完整对象、在内存中应用这批增量操作、整体写回
      const current = await StorageService.loadCurrentFromCos();
      const data = StorageService.applyOpsToPlainObject(current, ops);
      const dataStr = JSON.stringify(data, null, 2);
      const { Bucket, Region, Key } = StorageService.getCosConfig();
      return new Promise<boolean>((resolve) => {
        StorageService.getCosClient().putObject({
          Bucket,
          Region,
          Key,
          Body: Buffer.from(dataStr, "utf8")
        }, (err) => {
          if (err) {
            console.error("[STORAGE COS] 保存主数据至云端失败:", err);
            LogService.audit(
              "persist.cos.fail",
              `${ops.length} 个操作整体覆盖写回 COS 失败，本批变更未落盘: ${StorageService.summarizeOps(ops)} | 原因: ${err.message || String(err)}`,
              StorageService.auditCtx(),
              "error"
            );
            resolve(false);
          } else {
            console.log("[STORAGE COS] 主数据已成功落盘至腾讯云 COS");
            LogService.audit(
              "persist.cos.ok",
              `${ops.length} 个操作已整体覆盖写回 COS: ${StorageService.summarizeOps(ops)}`,
              StorageService.auditCtx()
            );
            resolve(true);
          }
        });
      });
    } else {
      // 本地存储模式：这批增量操作经由 SQLite 事务原子应用（要么全部生效、要么全部不生效），是唯一的持久化落点。
      try {
        // applyChangesIntoSqlite 内部已按“逐条 SQL 语句 + 影响行数”写 persist.sqlite.stmts 审计（成功）
        // 或 persist.sqlite.rollback（抛错回滚），这里不再重复写 op 级摘要，只保留控制台一行。
        StorageService.applyChangesIntoSqlite(ops);
        console.log(`[STORAGE SQLITE] 已通过事务增量应用 ${ops.length} 个同步操作至本地规范化关系型表结构。`);
        return true;
      } catch (err: any) {
        console.error("[STORAGE SQLITE] 写入本地数据失败:", err);
        LogService.audit(
          "persist.sqlite.fail",
          `SQLite 事务写入失败并整体回滚，本批变更未落盘: ${StorageService.summarizeOps(ops)} | 原因: ${err?.message || String(err)}`,
          StorageService.auditCtx(),
          "error"
        );
        return false;
      }
    }
  }

  /**
   * @description 新增原料到全局字典（阶段A·业务规则迁移到后端）：校验规则与错误文案与迁移前的前端实现逐字一致，
   * 供 server/routes/rawMaterials.ts 的 POST /api/raw-materials 调用。
   * @param {object} input 新增原料的字段
   * @returns {Promise<RawMaterialDictItem>} 新增后的完整原料条目
   */
  public static async addRawMaterial(input: {
    name: string; category: string; unit: string; remark?: string;
    conversionUnit?: string; conversionRatio?: number;
  }): Promise<RawMaterialDictItem> {
    const trimmedName = (input.name ?? "").trim();
    if (!trimmedName) {
      throw new Error("原料名称不能为空");
    }
    return StorageService.withWriteLock(async () => {
      const current = await StorageService.load();
      const existingList: RawMaterialDictItem[] = current.rawMaterialsDict ?? [];
      if (existingList.some((item) => item.name === trimmedName)) {
        throw new Error(`名为 "${trimmedName}" 的原料在字典中已存在`);
      }
      const newItem: RawMaterialDictItem = {
        name: trimmedName,
        category: input.category as FoodCategory,
        unit: (input.unit ?? "").trim() || "斤",
        remark: input.remark?.trim() || "",
        conversionUnit: input.conversionUnit?.trim() || undefined,
        conversionRatio: input.conversionRatio || undefined
      };
      const ok = await StorageService.saveInternal([{ entity: "rawMaterial", op: "upsert", key: trimmedName, data: newItem }]);
      if (!ok) {
        throw new Error("新增原料失败");
      }
      LogService.audit(
        "dict.rawMaterial.add",
        `新增原料字典条目 name=${LogService.fmt(newItem.name)} | 字段: category=${LogService.fmt(newItem.category)}, unit=${LogService.fmt(newItem.unit)}, remark=${LogService.fmt(newItem.remark)}, conversionUnit=${LogService.fmt(newItem.conversionUnit)}, conversionRatio=${LogService.fmt(newItem.conversionRatio)}`,
        StorageService.auditCtx()
      );
      return newItem;
    });
  }

  /**
   * @description 更新字典中的原料并级联同步台账里所有同名条目（阶段A·业务规则迁移到后端）：
   * 校验规则、isDefault 保留逻辑、错误文案均与迁移前的前端实现逐字一致。级联通过构造附加的 ledgerItem
   * upsert op 一起交给 saveInternal()，与主体的 rawMaterial upsert op 共享同一次持久化（本地模式为同一个 SQLite
   * 事务，COS 模式为同一次整体对象覆盖写），原子性强于迁移前"前端两次独立调用各自 queueChange 靠防抖窗口凑巧合并"。
   * @param {string} oldName 原原料名称（主键）
   * @param {object} input 更新后的字段
   * @returns {Promise<RawMaterialDictItem>} 更新后的完整原料条目
   */
  public static async updateRawMaterial(oldName: string, input: {
    name: string; category: string; unit: string; remark?: string;
    conversionUnit?: string; conversionRatio?: number;
  }): Promise<RawMaterialDictItem> {
    const trimmedName = (input.name ?? "").trim();
    if (!trimmedName) {
      throw new Error("原料名称不能为空");
    }
    return StorageService.withWriteLock(async () => {
      const current = await StorageService.load();
      const existingList: RawMaterialDictItem[] = current.rawMaterialsDict ?? [];
      const existingIndex = existingList.findIndex((item) => item.name === oldName);
      if (existingIndex === -1) {
        throw new Error("未找到原原料记录");
      }
      if (trimmedName !== oldName && existingList.some((item) => item.name === trimmedName)) {
        throw new Error(`名为 "${trimmedName}" 的原料已存在`);
      }
      const finalUnit = (input.unit ?? "").trim() || "斤";
      const finalRemark = input.remark?.trim() || "";
      const updatedItem: RawMaterialDictItem = {
        name: trimmedName,
        category: input.category as FoodCategory,
        unit: finalUnit,
        remark: finalRemark,
        conversionUnit: input.conversionUnit?.trim() || undefined,
        conversionRatio: input.conversionRatio || undefined,
        // 保留原有的默认数据标记，确保系统默认原料被编辑（含改名）后依然不可删除
        isDefault: existingList[existingIndex].isDefault
      };

      // 原料字典与台账已解耦：编辑/改名字典条目**不再**级联改动台账里的同名采购项。
      // 台账项的 name/unit/spec/category 都是新建那一刻抄好的快照，此后各自独立。
      const ops: SyncOp[] = [{
        entity: "rawMaterial", op: "upsert", key: trimmedName, data: updatedItem,
        previousKey: trimmedName !== oldName ? oldName : undefined
      }];

      const ok = await StorageService.saveInternal(ops);
      if (!ok) {
        throw new Error("更新原料失败");
      }
      LogService.audit(
        "dict.rawMaterial.update",
        `编辑原料字典条目 ${LogService.fmt(oldName)}${trimmedName !== oldName ? ` -> ${LogService.fmt(trimmedName)}` : ""} | 变更: ${LogService.diffFields(
          existingList[existingIndex] as any,
          updatedItem as any,
          ["name", "category", "unit", "remark", "conversionUnit", "conversionRatio"]
        )} | 台账已有采购项不受影响（字典与台账已解耦）`,
        StorageService.auditCtx()
      );
      return updatedItem;
    });
  }

  /**
   * @description 从字典中删除原料（阶段A·业务规则迁移到后端）：系统默认原料（isDefault=true）禁止删除。
   * 【字典与台账解耦】删除字典条目**只**移除录入联想项，**不再**触碰台账里的同名采购项与历史流水——
   * 那些数据是交易记录，其 name/unit/spec/category 都是建项时抄好的快照，字典删了照样独立存在与展示。
   * @param {string} name 待删除的原料名称
   * @returns {Promise<void>}
   */
  public static async deleteRawMaterial(name: string): Promise<void> {
    return StorageService.withWriteLock(async () => {
      const current = await StorageService.load();
      const existingList: RawMaterialDictItem[] = current.rawMaterialsDict ?? [];
      const target = existingList.find((item) => item.name === name);
      if (target?.isDefault) {
        throw new Error(`「${name}」是系统默认原料，不允许删除，如需调整可编辑其属性`);
      }

      const ops: SyncOp[] = [{ entity: "rawMaterial", op: "delete", key: name }];

      const ok = await StorageService.saveInternal(ops);
      if (!ok) {
        throw new Error("删除原料失败");
      }
      const stillReferenced = (current.ledgerItems ?? []).filter((i: LedgerItem) => i.name === name).length;
      LogService.audit(
        "dict.rawMaterial.delete",
        `删除原料字典条目 name=${LogService.fmt(name)} | 仅移除录入联想项，不影响已有台账数据${stillReferenced ? `（当前仍有 ${stillReferenced} 个台账采购项使用此名称，保持不变）` : ""}`,
        StorageService.auditCtx()
      );
    });
  }

  /**
   * @description 重命名某本台账（阶段B·业务规则迁移到后端，见 SQLite迁移规划.md）：校验规则与错误文案与迁移前的
   * 前端实现逐字一致。级联同步餐位人群配置的 label（对应此前 PrepReportService.syncGroupFromLedger 的既有行为）
   * 与主体的 ledger upsert op 一起提交，同一次持久化内完成。
   * @param {string} id 台账ID
   * @param {string} name 新的台账名字
   * @returns {Promise<Ledger>} 更新后的完整台账对象
   */
  public static async updateLedger(id: string, name: string): Promise<Ledger> {
    const normalizedName = (name ?? "").trim();
    if (!normalizedName) {
      throw new Error("台账名称不能为空");
    }
    return StorageService.withWriteLock(async () => {
      const current = await StorageService.load();
      const ledgers: Ledger[] = current.ledgers ?? [];
      const ledgerIndex = ledgers.findIndex((l) => l.id === id);
      if (ledgerIndex === -1) {
        throw new Error("找不到该台账");
      }
      if (ledgers.some((l) => l.name === normalizedName && l.id !== id)) {
        throw new Error(`名称为 "${normalizedName}" 的台账已存在`);
      }
      const updatedLedger: Ledger = { ...ledgers[ledgerIndex], name: normalizedName };
      const ops: SyncOp[] = [{ entity: "ledger", op: "upsert", key: id, data: updatedLedger }];

      // 台账 ↔ 一级人群通过 id/key 关联，历史上一律规范化为大写（见 saveGroup / generateDefaultSeeds）。
      // 这里按大小写不敏感匹配（与 deleteLedger / deleteGroup 保持一致），命中则沿用人群原有 key 落 op、
      // 不猜测重新大小写；未命中才补齐一份，用大写规范形，避免因大小写不匹配误判成“不存在”而写出重复人群行。
      const activeGroups: DynamicGroup[] = current.activeGroups ?? [];
      const linkedGroup = activeGroups.find((g) => g.key.toUpperCase() === id.toUpperCase());
      if (linkedGroup) {
        if (linkedGroup.label !== normalizedName) {
          ops.push({ entity: "activeGroup", op: "upsert", key: linkedGroup.key, data: { ...linkedGroup, label: normalizedName } });
        }
      } else {
        // 极端情形：台账存在但对应的餐位人群配置尚不存在，补齐一份，
        // 与迁移前 syncGroupFromLedger() 的"新建人群"分支保持一致（备餐报表双状态已随本次重构整体删除，不再需要补空报表）
        const canonicalKey = id.toUpperCase();
        ops.push({ entity: "activeGroup", op: "upsert", key: canonicalKey, data: { key: canonicalKey, label: normalizedName, emoji: "🍽️" } });
      }

      const ok = await StorageService.saveInternal(ops);
      if (!ok) {
        throw new Error("更新台账失败");
      }
      LogService.audit(
        "ledger.rename",
        `台账改名 id=${id} ${LogService.fmt(ledgers[ledgerIndex].name)} -> ${LogService.fmt(normalizedName)} | 级联同步一级人群配置 label（${linkedGroup ? `key=${linkedGroup.key}` : "对应人群不存在，已补建"}）`,
        StorageService.auditCtx()
      );
      return updatedLedger;
    });
  }

  /**
   * @description 物理彻底删除某本台账，级联删除其下的所有原料采购项目（阶段B·业务规则迁移到后端）：
   * 同时级联删除对应的餐位人群配置（对应此前 PrepReportService.syncDeleteGroupFromLedger 的既有行为），
   * 与主体的 ledger delete op 一起提交，同一次持久化内完成。
   * @param {string} id 台账ID
   * @returns {Promise<void>}
   */
  public static async deleteLedger(id: string): Promise<void> {
    return StorageService.withWriteLock(async () => {
      const current = await StorageService.load();
      const ledgers: Ledger[] = current.ledgers ?? [];
      const ledger = ledgers.find((l) => l.id === id);
      if (!ledger) {
        throw new Error("找不到待删除的台账");
      }
      // 会连根删掉整本台账及其全部逐日流水：删前先存一份快照。备份失败则中止删除。
      const backupPath = await StorageService.snapshotBackup(`before-delete-ledger-${ledger.id}`);
      const ledgerItems: LedgerItem[] = current.ledgerItems ?? [];
      // 关联子项按**大小写不敏感**匹配（与 deleteGroup 一致）——历史上出现过 ledgerId 与 ledger.id 大小写不一致的
      // 脏数据，用严格 === 会漏删子项，留下孤儿 ledger_items / 逐日流水行（schema 无 FK 级联）。
      const removedItems = ledgerItems.filter((item) => item.ledgerId.toUpperCase() === ledger.id.toUpperCase());

      const ops: SyncOp[] = [{ entity: "ledger", op: "delete", key: ledger.id }];
      removedItems.forEach((item) => {
        ops.push({ entity: "ledgerItem", op: "delete", key: item.id });
      });
      // 连带删除的逐日流水按真实全历史统计（不用 load() 的当月区间）
      const dayStats = StorageService.countItemDailyRecords(removedItems.map((i) => i.id), current.ledgerItems ?? []);

      // 大小写不敏感匹配对应人群，删除时按人群实际行的 key 下 op（与 updateLedger / deleteGroup 一致）
      const activeGroups: DynamicGroup[] = current.activeGroups ?? [];
      const linkedGroup = activeGroups.find((g) => g.key.toUpperCase() === ledger.id.toUpperCase());
      if (linkedGroup) {
        ops.push({ entity: "activeGroup", op: "delete", key: linkedGroup.key });
      }


      const ok = await StorageService.saveInternal(ops);
      if (!ok) {
        throw new Error("删除台账失败");
      }
      LogService.audit(
        "ledger.delete",
        `物理删除台账 id=${ledger.id} name=${LogService.fmt(ledger.name)} | 级联删除原料项 ${removedItems.length} 个、逐日流水合计 ${dayStats.count} 条${dayStats.count ? ` (${dayStats.minDate} ~ ${dayStats.maxDate})` : ""}${linkedGroup ? `、一级人群配置 key=${linkedGroup.key}` : ""} | 删前快照: ${backupPath ? path.basename(backupPath) : "(无)"} | 被删原料项: [${removedItems.map((i) => `${i.id}(${i.name})`).join(", ")}]`,
        StorageService.auditCtx(),
        "warn"
      );
    });
  }

  /**
   * @description 为某个台账新增采购项目（原料明细）（阶段B·业务规则迁移到后端）：校验规则与错误文案与迁移前的
   * 前端实现逐字一致。
   * @param {object} input 新增采购项目的字段
   * @returns {Promise<LedgerItem>} 新增后的完整原料项目
   */
  public static async addLedgerItem(input: {
    ledgerId: string; name: string; unit: string; spec?: string; initialStock: number; category?: string;
  }): Promise<LedgerItem> {
    const trimmedName = (input.name ?? "").trim();
    if (!trimmedName) {
      throw new Error("原料名称不能为空");
    }
    return StorageService.withWriteLock(async () => {
      const current = await StorageService.load();
      const ledgers: Ledger[] = current.ledgers ?? [];
      if (!ledgers.some((l) => l.id === input.ledgerId)) {
        throw new Error("关联的台账不存在");
      }
      const ledgerItems: LedgerItem[] = current.ledgerItems ?? [];
      if (ledgerItems.some((item) => item.ledgerId === input.ledgerId && item.name === trimmedName)) {
        throw new Error(`该台账内已有名为 "${trimmedName}" 的采购项目原料`);
      }
      const initialStock = Math.max(0, input.initialStock);
      // category 是**快照**：优先用调用方显式传的，否则新建这一刻从原料字典按 name 抄一份。
      // 抄完即与字典解耦——之后字典改名/删除都不会回来动这一列。字典里查不到就留空（前端归到“未分类”）。
      const dictCategory = (current.rawMaterialsDict ?? []).find((d: RawMaterialDictItem) => d.name === trimmedName)?.category;
      const category = ((input.category ?? "").trim() || dictCategory || "") || undefined;
      const newItem: LedgerItem = {
        id: `ledger_item_${input.ledgerId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        ledgerId: input.ledgerId,
        name: trimmedName,
        unit: (input.unit ?? "").trim() || "斤",
        spec: (input.spec ?? "").trim() || "常规",
        category,
        initialStock,
        currentStock: initialStock,
        dailyRecords: {}
      };
      const ok = await StorageService.saveInternal([{ entity: "ledgerItem", op: "upsert", key: newItem.id, data: newItem }]);
      if (!ok) {
        throw new Error("新增原料失败");
      }
      LogService.audit(
        "ledger.item.add",
        `台账新增采购原料项 id=${newItem.id} ledger=${newItem.ledgerId} name=${LogService.fmt(newItem.name)} | 字段: unit=${LogService.fmt(newItem.unit)}, spec=${LogService.fmt(newItem.spec)}, category=${LogService.fmt(newItem.category)}, initialStock=${newItem.initialStock}, currentStock=${newItem.currentStock}`,
        StorageService.auditCtx()
      );
      return newItem;
    });
  }

  /**
   * @description 修改某项采购项目（原料）的基本信息并重新核算当前库存（阶段B·业务规则迁移到后端）：
   * 校验规则与错误文案与迁移前的前端实现逐字一致。
   * @param {string} id 原料项目ID
   * @param {object} input 更新后的字段
   * @returns {Promise<LedgerItem>} 更新后的完整原料项目
   */
  public static async updateLedgerItem(id: string, input: {
    name: string; unit: string; spec?: string; initialStock: number; category?: string;
  }): Promise<LedgerItem> {
    return StorageService.withWriteLock(async () => {
      const current = await StorageService.load();
      const ledgerItems: LedgerItem[] = current.ledgerItems ?? [];
      const oldItem = ledgerItems.find((item) => item.id === id);
      if (!oldItem) {
        throw new Error("找不到该采购原料项目");
      }
      const normalizedName = (input.name ?? "").trim();
      if (ledgerItems.some((item) => item.ledgerId === oldItem.ledgerId && item.name === normalizedName && item.id !== id)) {
        throw new Error(`台账内已有名为 "${normalizedName}" 的原料`);
      }
      const initialStock = Math.max(0, input.initialStock);
      // 库存按全历史累计口径重算：本次只改基础信息、不动任何逐日流水，故直接沿用 readDataFromSqlite() 预聚合的
      // historicalTotalIn/Out（对该原料全部逐日流水的无条件 SUM），不再对 oldItem.dailyRecords（仅含前端当前
      // 加载的月份区间）逐日求和 —— 那样跨月编辑基础信息会把更早月份的出入库丢掉，算出错误的库存。
      const historicalTotalIn = Number.isFinite(oldItem.historicalTotalIn as number)
        ? (oldItem.historicalTotalIn as number)
        : Object.values(oldItem.dailyRecords ?? {}).reduce((s: number, r: any) => s + (r.inQuantity || 0), 0);
      const historicalTotalOut = Number.isFinite(oldItem.historicalTotalOut as number)
        ? (oldItem.historicalTotalOut as number)
        : Object.values(oldItem.dailyRecords ?? {}).reduce((s: number, r: any) => s + (r.outQuantity || 0), 0);
      // 本次不动逐日流水，累计入库金额保持不变；沿用 readDataFromSqlite() 预聚合值，缺失时回退按内存求和
      const historicalTotalInAmount = Number.isFinite(oldItem.historicalTotalInAmount as number)
        ? (oldItem.historicalTotalInAmount as number)
        : Object.values(oldItem.dailyRecords ?? {}).reduce((s: number, r: any) => s + (r.inAmount || 0), 0);
      // category 快照的取值优先级（体现“字典改动不影响台账”）：
      //  1) 调用方显式传的 category（前端编辑表单主动选了大类）
      //  2) 仅当**改了原料名**（等于换了一种原料）时，按新名字重新从字典抄一次——这是“换原料”而非“字典变了”
      //  3) 否则一律沿用该台账项原有的 category 快照，绝不因为“字典里这个名字的分类后来被人改了”而跟着变
      const nameChanged = normalizedName !== (oldItem.name ?? "").trim();
      const dictCategoryForNewName = nameChanged
        ? (current.rawMaterialsDict ?? []).find((d: RawMaterialDictItem) => d.name === normalizedName)?.category
        : undefined;
      const category = ((input.category ?? "").trim() || dictCategoryForNewName || oldItem.category || "") || undefined;
      const updatedItem: LedgerItem = {
        ...oldItem,
        name: normalizedName,
        unit: (input.unit ?? "").trim() || "斤",
        spec: (input.spec ?? "").trim() || "常规",
        category,
        initialStock,
        historicalTotalIn,
        historicalTotalOut,
        historicalTotalInAmount,
        currentStock: Math.round((initialStock + historicalTotalIn - historicalTotalOut) * 100) / 100
      };
      const ok = await StorageService.saveInternal([{ entity: "ledgerItem", op: "upsert", key: updatedItem.id, data: updatedItem }]);
      if (!ok) {
        throw new Error("更新原料失败");
      }
      LogService.audit(
        "ledger.item.update",
        `编辑台账采购原料项 id=${id} ledger=${oldItem.ledgerId} | 变更: ${LogService.diffFields(
          oldItem as any,
          updatedItem as any,
          ["name", "unit", "spec", "category", "initialStock", "currentStock"]
        )} | 库存按全历史累计重算: ${oldItem.currentStock} -> ${updatedItem.currentStock} (histIn=${historicalTotalIn}, histOut=${historicalTotalOut})`,
        StorageService.auditCtx()
      );
      return updatedItem;
    });
  }

  /**
   * @description 彻底物理删除某项采购项目（原料），后端级联清理该原料自己的逐日流水（阶段B·业务规则迁移到后端）：
   * 校验规则与错误文案与迁移前的前端实现逐字一致。
   * @param {string} id 原料项目ID
   * @returns {Promise<void>}
   */
  public static async deleteLedgerItem(id: string): Promise<void> {
    return StorageService.withWriteLock(async () => {
      const current = await StorageService.load();
      const ledgerItems: LedgerItem[] = current.ledgerItems ?? [];
      const target = ledgerItems.find((item) => item.id === id);
      if (!target) {
        throw new Error("找不到要删除的原料项目");
      }
      // 连带删除的逐日流水按真实全历史统计（load() 只含当月，会低估跨月历史）
      const dayStats = StorageService.countItemDailyRecords([id], current.ledgerItems ?? []);
      const ok = await StorageService.saveInternal([{ entity: "ledgerItem", op: "delete", key: id }]);
      if (!ok) {
        throw new Error("删除原料失败");
      }
      LogService.audit(
        "ledger.item.delete",
        `物理删除台账采购原料项 id=${id} ledger=${target.ledgerId} name=${LogService.fmt(target.name)} | 连带删除其逐日流水 ${dayStats.count} 条${dayStats.count ? ` (${dayStats.minDate} ~ ${dayStats.maxDate})` : ""}、当前库存 ${target.currentStock}`,
        StorageService.auditCtx(),
        dayStats.count ? "warn" : "info"
      );
    });
  }

  /**
   * @description 录入/更新指定原料在指定日期的部分出入库字段，采用 Partial 合并技术实现 onBlur 自动保存，
   * 并自动重算当日入库金额与该原料的实时当前库存（阶段B·业务规则迁移到后端）：合并/校验/重算逻辑与迁移前的
   * 前端实现逐字一致。[V2 架构演进] 此前反向同步进备餐月度报表的 PrepReportService.syncFromLedger 已随报表
   * 双状态整体删除，调用方（前端 LedgerService）不再需要对返回的 mergedRecord 做任何反向同步处理——
   * TableGrid 等展示视图现在直接以 ledger_items/ledger_item_daily_records 实时派生渲染。
   * @param {string} itemId 原料ID
   * @param {string} dateStr 选中的日期 (格式如 "YYYY-MM-DD")
   * @param {Partial<DailyStockRecord>} fields 可选合并的属性集合
   * @returns {Promise<{ item: LedgerItem; mergedRecord: DailyStockRecord }>} 更新后的完整原料项目与合并后的当日记录
   */
  public static async updateLedgerDailyRecord(
    itemId: string,
    dateStr: string,
    fields: Partial<DailyStockRecord>
  ): Promise<{ item: LedgerItem; mergedRecord: DailyStockRecord }> {
    return StorageService.withWriteLock(async () => {
      // 关键：必须按“正在编辑的这一天”精确加载，而不是用 load() 的默认当月区间。
      // 否则当 dateStr 落在当月之外（如往月补录/补签字），item.dailyRecords[dateStr] 会缺失，
      // 下面的 Partial 合并就会以“全 0 旧记录”为底，把该天早先已保存的供货商/单价/检验员等字段一并写空，
      // 造成已录入数据（尤其是蔬菜等）在跨月编辑后凭空消失。
      const current = await StorageService.load(dateStr, dateStr);
      const ledgerItems: LedgerItem[] = current.ledgerItems ?? [];
      const item = ledgerItems.find((i) => i.id === itemId);
      if (!item) {
        throw new Error("找不到对应的采购原料项目");
      }

      const { updatedItem, mergedRecord, ops, changeSummary } = StorageService.mergeLedgerDailyRecord(item, dateStr, fields);

      const ok = await StorageService.saveInternal(ops);
      if (!ok) {
        throw new Error("保存出入库记录失败");
      }
      LogService.audit(
        "ledger.dailyRecord.update",
        `台账逐日流水录入 item=${itemId}(${item.name}/${item.ledgerId}) date=${dateStr} | 请求字段: ${JSON.stringify(fields)} | 当日记录: ${changeSummary.dayAction} | 变更: ${changeSummary.fieldDiff} | 库存: ${changeSummary.stockBefore} -> ${changeSummary.stockAfter} (累计入库 ${changeSummary.histInBefore} -> ${changeSummary.histInAfter}, 累计出库 ${changeSummary.histOutBefore} -> ${changeSummary.histOutAfter})`,
        StorageService.auditCtx(),
        changeSummary.dayAction === "deleted" ? "warn" : "info"
      );
      return { item: updatedItem, mergedRecord };
    });
  }

  /**
   * @description 批量更新指定台账下多个原料在指定日期的出入库字段，极大减少了多次单条 HTTP/SQLite 事务带来的性能延迟。
   * (一次 WriteLock + 一次 SQLite 事务)。
   * @param {string} dateStr 选中的日期 (格式如 "YYYY-MM-DD")
   * @param {Record<string, Partial<DailyStockRecord>>} updates 多个原料的更新负载，键为 itemId
   * @returns {Promise<{ updatedItems: LedgerItem[]; mergedRecords: Record<string, DailyStockRecord> }>}
   */
  public static async updateLedgerDailyRecordsBatch(
    dateStr: string,
    updates: Record<string, Partial<DailyStockRecord>>
  ): Promise<{ updatedItems: LedgerItem[]; mergedRecords: Record<string, DailyStockRecord> }> {
    return StorageService.withWriteLock(async () => {
      // 同 updateLedgerDailyRecord：按录入的这一天精确加载，避免跨月批量录入时用“全 0 旧记录”做底、
      // 把该天早先保存的字段写空（这是“录入了却丢了”的主因之一）。批次内所有更新都针对同一个 dateStr。
      const current = await StorageService.load(dateStr, dateStr);
      const ledgerItems: LedgerItem[] = current.ledgerItems ?? [];

      const updatedItems: LedgerItem[] = [];
      const mergedRecords: Record<string, DailyStockRecord> = {};
      const allOps: SyncOp[] = [];
      const ctx = StorageService.auditCtx();
      const requestedIds = Object.keys(updates);
      const perItemLines: string[] = [];
      const skippedIds: string[] = [];

      for (const [itemId, fields] of Object.entries(updates)) {
        const item = ledgerItems.find((i) => i.id === itemId);
        if (!item) {
          // 找不到对应的原料说明它可能已被删除（多端并发删除、或前端草稿里的 itemId 已过期）。
          // 我们选择忽略并记录告警，而非抛出异常，因为抛出异常会导致整个批量提交失败，
          // 同时可能导致前端在缓存草稿时陷入无限失败循环。
          // ——但这意味着用户为该原料录入的这一整行数据会被静默丢弃，属于数据丢失的高发点，务必留痕。
          console.warn(`[WARN] 找不到对应的采购原料项目(ID: ${itemId})，跳过该项的更新`);
          skippedIds.push(itemId);
          LogService.audit(
            "ledger.dailyRecord.batch.skip",
            `批量录入时找不到原料项 itemId=${itemId}（可能已被删除/草稿ID过期），该原料 ${dateStr} 这一行录入数据被丢弃未落盘 | 丢弃字段: ${JSON.stringify(fields)}`,
            ctx,
            "warn"
          );
          continue;
        }

        const { updatedItem, mergedRecord, ops, changeSummary } = StorageService.mergeLedgerDailyRecord(item, dateStr, fields);
        updatedItems.push(updatedItem);
        mergedRecords[itemId] = mergedRecord;
        allOps.push(...ops);
        perItemLines.push(
          `${itemId}(${item.name}) ${changeSummary.dayAction}${changeSummary.dayAction === "noop" ? "" : `[${changeSummary.fieldDiff}]`} 库存${changeSummary.stockBefore}->${changeSummary.stockAfter}`
        );

        // 关键：为了防止同一个批次里对其它项的查找受影响，实际上这里只需将 updatedItem 替换掉内存中的 item
        // 但由于本批次修改的是不同的 itemId，直接 push ops 并不会互相冲突。
      }

      if (allOps.length > 0) {
        const ok = await StorageService.saveInternal(allOps);
        if (!ok) {
          throw new Error("批量保存出入库记录失败");
        }
      }

      LogService.audit(
        "ledger.dailyRecord.batch",
        `批量录入 date=${dateStr} | 请求 ${requestedIds.length} 项、落盘 ${updatedItems.length} 项、跳过 ${skippedIds.length} 项${skippedIds.length ? `(丢弃: [${skippedIds.join(", ")}])` : ""} | 明细: ${perItemLines.length ? perItemLines.join(" ;; ") : "(无有效变更)"}`,
        ctx,
        skippedIds.length ? "warn" : "info"
      );

      return { updatedItems, mergedRecords };
    });
  }

  /**
   * @description 把一批出入库字段合并进某个已知台账原料项目的指定日期记录，重算入库金额与实时库存，
   * 并构造对应的增量同步 op（不做任何持久化，纯内存计算）。供 updateLedgerDailyRecord（台账侧直接编辑）
   * 复用这份合并/校验/重算逻辑。
   * @param {LedgerItem} item 当前的台账原料项目（调用方已确认存在）
   * @param {string} dateStr 选中的日期 (格式如 "YYYY-MM-DD")
   * @param {Partial<DailyStockRecord>} fields 可选合并的属性集合
   * @returns {{ updatedItem: LedgerItem; mergedRecord: DailyStockRecord; ops: SyncOp[] }} 更新后的完整原料项目、合并后的当日记录、以及对应的增量同步 op
   */
  private static mergeLedgerDailyRecord(
    item: LedgerItem,
    dateStr: string,
    fields: Partial<DailyStockRecord>
  ): {
    updatedItem: LedgerItem;
    mergedRecord: DailyStockRecord;
    ops: SyncOp[];
    /** 供调用方组装数据审计日志的前后对照摘要（这次录入在原有基础上增加/减少/改了什么、库存与累计如何变化） */
    changeSummary: {
      existedBefore: boolean;
      /** 该日流水记录经本次合并后的归宿：created 新建 / updated 覆盖 / deleted 因清空而整条删除 / noop 本就不存在且仍无数据 */
      dayAction: "created" | "updated" | "deleted" | "noop";
      /** 逐字段差异串，形如 `inQuantity 0 -> 10, supplier ∅ -> "宾县..."`（deleted 时展示被清掉的旧值） */
      fieldDiff: string;
      stockBefore: number;
      stockAfter: number;
      histInBefore: number;
      histInAfter: number;
      histOutBefore: number;
      histOutAfter: number;
    };
  } {
    const existedBefore = !!(item.dailyRecords && item.dailyRecords[dateStr]);
    const updatedDailyRecords: Record<string, DailyStockRecord> = { ...(item.dailyRecords ?? {}) };
    const oldRecord: DailyStockRecord = updatedDailyRecords[dateStr] || { inQuantity: 0, inPrice: 0, inAmount: 0, outQuantity: 0, note: "" };
    const mergedRecord: DailyStockRecord = { ...oldRecord, ...fields };

    mergedRecord.inQuantity = Number.isFinite(mergedRecord.inQuantity) ? Math.max(0, mergedRecord.inQuantity!) : 0;
    mergedRecord.inPrice = Number.isFinite(mergedRecord.inPrice) ? Math.max(0, mergedRecord.inPrice!) : 0;
    mergedRecord.inAmount = Math.round(mergedRecord.inQuantity * mergedRecord.inPrice * 100) / 100;
    mergedRecord.outQuantity = Number.isFinite(mergedRecord.outQuantity) ? Math.max(0, mergedRecord.outQuantity!) : 0;
    if (mergedRecord.note !== undefined) {
      mergedRecord.note = mergedRecord.note.trim();
    }

    const hasData =
      mergedRecord.inQuantity > 0 ||
      mergedRecord.inPrice > 0 ||
      mergedRecord.outQuantity > 0 ||
      (mergedRecord.note && mergedRecord.note.trim()) ||
      (mergedRecord.certification && mergedRecord.certification.trim()) ||
      (mergedRecord.sensoryProperty && mergedRecord.sensoryProperty.trim()) ||
      (mergedRecord.supplier && mergedRecord.supplier.trim()) ||
      (mergedRecord.buyer && mergedRecord.buyer.trim()) ||
      (mergedRecord.inspector && mergedRecord.inspector.trim()) ||
      (mergedRecord.keeper && mergedRecord.keeper.trim()) ||
      (mergedRecord.produceDate && mergedRecord.produceDate.trim()) ||
      (mergedRecord.shelfLife && mergedRecord.shelfLife.trim()) ||
      (mergedRecord.outHandler && mergedRecord.outHandler.trim()) ||
      (mergedRecord.outRecipient && mergedRecord.outRecipient.trim());

    if (!hasData) {
      delete updatedDailyRecords[dateStr];
    } else {
      updatedDailyRecords[dateStr] = mergedRecord;
    }

    // 库存按全历史累计口径重算，而不是对 updatedDailyRecords（仅含前端当前加载的月份区间）逐日求和 ——
    // 否则跨月查看/编辑时会把更早月份的出入库整段丢掉，算出错误（甚至为负）的库存。
    // readDataFromSqlite() 返回的 historicalTotalIn/Out 是对该原料全部逐日流水的无条件 SUM；这里按
    // “旧值 − 本次该天的旧数量 + 本次该天的新数量”做增量调整，使其继续等于全历史累计。
    // 注意：若正在编辑的 dateStr 落在写操作发生当时 load() 加载区间之外（如把 selectedDate 切到往月补录），
    // oldRecord 会退化为全 0，本次 REST 响应里的库存/累计可能短暂偏差，但下一次 GET /load 会用逐日流水表的
    // 无条件 SUM 重新算准（见 readDataFromSqlite），不会持久写歪。
    const priorHistoricalTotalIn = Number.isFinite(item.historicalTotalIn as number)
      ? (item.historicalTotalIn as number)
      : Object.values(item.dailyRecords ?? {}).reduce((s, r) => s + (r.inQuantity || 0), 0);
    const priorHistoricalTotalOut = Number.isFinite(item.historicalTotalOut as number)
      ? (item.historicalTotalOut as number)
      : Object.values(item.dailyRecords ?? {}).reduce((s, r) => s + (r.outQuantity || 0), 0);
    // 累计入库金额同理按增量调整，供左侧边栏“台账原料累计入库 → 全部”统计（不受前端按月懒加载影响）
    const priorHistoricalTotalInAmount = Number.isFinite(item.historicalTotalInAmount as number)
      ? (item.historicalTotalInAmount as number)
      : Object.values(item.dailyRecords ?? {}).reduce((s, r) => s + (r.inAmount || 0), 0);

    const oldDayIn = oldRecord.inQuantity || 0;
    const oldDayOut = oldRecord.outQuantity || 0;
    const oldDayInAmount = oldRecord.inAmount || 0;
    const newDayIn = mergedRecord.inQuantity || 0;
    const newDayOut = mergedRecord.outQuantity || 0;
    // hasData 为 false 时该天记录被删除，inQuantity 必为 0 ⇒ inAmount 也为 0，这里与 newDayIn/newDayOut 同口径
    const newDayInAmount = mergedRecord.inAmount || 0;

    const newHistoricalTotalIn = Math.round((priorHistoricalTotalIn - oldDayIn + newDayIn) * 100) / 100;
    const newHistoricalTotalOut = Math.round((priorHistoricalTotalOut - oldDayOut + newDayOut) * 100) / 100;
    const newHistoricalTotalInAmount = Math.round((priorHistoricalTotalInAmount - oldDayInAmount + newDayInAmount) * 100) / 100;
    const newCurrentStock = Math.round((item.initialStock + newHistoricalTotalIn - newHistoricalTotalOut) * 100) / 100;

    const updatedItem: LedgerItem = {
      ...item,
      dailyRecords: updatedDailyRecords,
      historicalTotalIn: newHistoricalTotalIn,
      historicalTotalOut: newHistoricalTotalOut,
      historicalTotalInAmount: newHistoricalTotalInAmount,
      currentStock: newCurrentStock
    };

    const ops: SyncOp[] = [];
    if (!hasData) {
      ops.push({ entity: "ledgerItemDailyRecord", op: "delete", key: { itemId: item.id, date: dateStr } });
    } else {
      ops.push({ entity: "ledgerItemDailyRecord", op: "upsert", key: { itemId: item.id, date: dateStr }, data: mergedRecord });
    }
    ops.push({ entity: "ledgerItem", op: "upsert", key: updatedItem.id, data: updatedItem });

    const stockBefore = Number.isFinite(item.currentStock as number)
      ? (item.currentStock as number)
      : Math.round((item.initialStock + priorHistoricalTotalIn - priorHistoricalTotalOut) * 100) / 100;
    const dayAction: "created" | "updated" | "deleted" | "noop" = hasData
      ? (existedBefore ? "updated" : "created")
      : (existedBefore ? "deleted" : "noop");
    // deleted 时 after 传空对象，让 diffFields 把被清掉的旧值逐个列出来（体现"减少了什么"）
    const fieldDiff = LogService.diffFields(
      oldRecord as any,
      hasData ? (mergedRecord as any) : {},
      DAILY_RECORD_FIELDS as unknown as string[]
    );

    return {
      updatedItem,
      mergedRecord,
      ops,
      changeSummary: {
        existedBefore,
        dayAction,
        fieldDiff,
        stockBefore,
        stockAfter: newCurrentStock,
        histInBefore: priorHistoricalTotalIn,
        histInAfter: newHistoricalTotalIn,
        histOutBefore: priorHistoricalTotalOut,
        histOutAfter: newHistoricalTotalOut
      }
    };
  }

  /**
   * @description 新增或编辑一级人群配置（阶段C·业务规则迁移到后端）：校验规则、isDefault 保留逻辑与
   * 错误文案与迁移前的前端实现逐字一致。级联同步创建/改名对应的台账（对应此前
   * LedgerService.syncLedgerFromGroup 的既有行为），与主体的 activeGroup upsert op 一起提交，
   * 同一次持久化内完成。
   * @param {string} key 人群标识键
   * @param {string} label 显示中文标签
   * @param {string} emoji 展现表情符号
   * @returns {Promise<DynamicGroup>} 保存后的完整人群配置
   */
  public static async saveGroup(key: string, label: string, emoji: string): Promise<DynamicGroup> {
    if (!key || !key.trim()) {
      throw new Error("人群标识键不能为空");
    }
    if (!label || !label.trim()) {
      throw new Error("人群名称标签不能为空");
    }
    return StorageService.withWriteLock(async () => {
      const current = await StorageService.load();
      const upperKey = key.trim().toUpperCase();
      const activeGroups: DynamicGroup[] = current.activeGroups ?? [];
      // 大小写不敏感匹配已有人群；命中则沿用其原有 key（不猜测重新大小写），未命中才用大写规范形新建
      const existingIndex = activeGroups.findIndex((g) => g.key.toUpperCase() === upperKey);
      const groupKey = existingIndex > -1 ? activeGroups[existingIndex].key : upperKey;

      const ops: SyncOp[] = [];
      let savedGroup: DynamicGroup;
      if (existingIndex > -1) {
        savedGroup = {
          key: groupKey, label: label.trim(), emoji: emoji.trim() || "🍽️",
          isDefault: activeGroups[existingIndex].isDefault
        };
      } else {
        savedGroup = { key: groupKey, label: label.trim(), emoji: emoji.trim() || "🍽️" };
      }
      ops.push({ entity: "activeGroup", op: "upsert", key: groupKey, data: savedGroup });

      const ledgers: Ledger[] = current.ledgers ?? [];
      const existingLedger = ledgers.find((l) => l.id.toUpperCase() === upperKey);
      if (existingLedger) {
        if (existingLedger.name !== label.trim()) {
          ops.push({ entity: "ledger", op: "upsert", key: existingLedger.id, data: { ...existingLedger, name: label.trim() } });
        }
      } else {
        ops.push({ entity: "ledger", op: "upsert", key: groupKey, data: { id: groupKey, name: label.trim(), createdAt: new Date().toISOString() } });
      }

      const ok = await StorageService.saveInternal(ops);
      if (!ok) {
        throw new Error("保存人群配置失败");
      }
      LogService.audit(
        "config.group.save",
        `${existingIndex > -1 ? "编辑" : "新增"}一级人群 key=${groupKey} | 变更: ${
          existingIndex > -1
            ? LogService.diffFields(activeGroups[existingIndex] as any, savedGroup as any, ["label", "emoji"])
            : `label=${LogService.fmt(savedGroup.label)}, emoji=${LogService.fmt(savedGroup.emoji)}`
        } | 级联${existingLedger ? "同步" : "新建"}对应台账 name=${LogService.fmt(label.trim())}`,
        StorageService.auditCtx()
      );
      return savedGroup;
    });
  }

  /**
   * @description 删除一级人群配置（阶段C·业务规则迁移到后端）：系统默认人群禁止删除，
   * 错误文案与迁移前的前端实现逐字一致。级联同步删除对应的台账及其下全部原料项目（对应此前
   * LedgerService.syncDeleteLedgerFromGroup 的既有行为），与主体的删除 op 一起提交，同一次持久化内完成。
   * @param {string} key 人群标识键
   * @returns {Promise<void>}
   */
  public static async deleteGroup(key: string): Promise<void> {
    return StorageService.withWriteLock(async () => {
      const current = await StorageService.load();
      const upperKey = key.toUpperCase();
      const activeGroups: DynamicGroup[] = current.activeGroups ?? [];
      const target = activeGroups.find((g) => g.key.toUpperCase() === upperKey);
      if (target?.isDefault) {
        throw new Error(`「${target.label}」是系统默认人群，不允许删除，如需调整可编辑其名称或图标`);
      }
      // 会连带删掉对应台账及其全部逐日流水：删前先存一份快照。备份失败则中止删除。
      const backupPath = await StorageService.snapshotBackup(`before-delete-group-${target ? target.key : upperKey}`);

      // 按人群实际行的 key 下删除 op（命中时），而不是重新大写猜一个——避免历史上存在非大写 key 时删不掉
      const ops: SyncOp[] = [{ entity: "activeGroup", op: "delete", key: target ? target.key : upperKey }];

      const ledgers: Ledger[] = current.ledgers ?? [];
      const ledger = ledgers.find((l) => l.id.toUpperCase() === upperKey);
      const cascadedItems: LedgerItem[] = [];
      if (ledger) {
        ops.push({ entity: "ledger", op: "delete", key: ledger.id });
        const ledgerItems: LedgerItem[] = current.ledgerItems ?? [];
        ledgerItems.filter((item) => item.ledgerId.toUpperCase() === ledger.id.toUpperCase()).forEach((item) => {
          ops.push({ entity: "ledgerItem", op: "delete", key: item.id });
          cascadedItems.push(item);
        });
      }
      // 连带删除的逐日流水按真实全历史统计（load() 只含当月）
      const dayStats = StorageService.countItemDailyRecords(cascadedItems.map((i) => i.id), current.ledgerItems ?? []);

      const ok = await StorageService.saveInternal(ops);
      if (!ok) {
        throw new Error("删除人群配置失败");
      }
      LogService.audit(
        "config.group.delete",
        `删除一级人群 key=${target ? target.key : upperKey} label=${LogService.fmt(target?.label)} | 级联删除对应台账${ledger ? ` id=${ledger.id}` : "(无)"}、原料项 ${cascadedItems.length} 个、逐日流水合计 ${dayStats.count} 条${dayStats.count ? ` (${dayStats.minDate} ~ ${dayStats.maxDate})` : ""} | 删前快照: ${backupPath ? path.basename(backupPath) : "(无)"}${cascadedItems.length ? ` | 被删原料项: [${cascadedItems.map((i) => `${i.id}(${i.name})`).join(", ")}]` : ""}`,
        StorageService.auditCtx(),
        ledger || cascadedItems.length ? "warn" : "info"
      );
    });
  }

  /**
   * @description 新增或编辑二级食材大类配置（阶段C·业务规则迁移到后端）：校验规则、isDefault 保留逻辑与
   * 错误文案与迁移前的前端实现逐字一致。
   * @param {string} key 大类标识键
   * @param {string} label 大类名称显名
   * @returns {Promise<DynamicCategory>} 保存后的完整大类配置
   */
  public static async saveCategory(key: string, label: string): Promise<DynamicCategory> {
    if (!key || !key.trim()) {
      throw new Error("大类标识键不能为空");
    }
    if (!label || !label.trim()) {
      throw new Error("大类名称标签不能为空");
    }
    return StorageService.withWriteLock(async () => {
      const current = await StorageService.load();
      const upperKey = key.trim().toUpperCase();
      const activeCategories: DynamicCategory[] = current.activeCategories ?? [];
      // 大小写不敏感匹配已有大类；命中则沿用其原有 key，未命中才用大写规范形新建
      const existingIndex = activeCategories.findIndex((c) => c.key.toUpperCase() === upperKey);
      const categoryKey = existingIndex > -1 ? activeCategories[existingIndex].key : upperKey;
      const savedCategory: DynamicCategory = existingIndex > -1
        ? { key: categoryKey, label: label.trim(), isDefault: activeCategories[existingIndex].isDefault }
        : { key: categoryKey, label: label.trim() };

      const ok = await StorageService.saveInternal([{ entity: "activeCategory", op: "upsert", key: categoryKey, data: savedCategory }]);
      if (!ok) {
        throw new Error("保存大类配置失败");
      }
      LogService.audit(
        "config.category.save",
        `${existingIndex > -1 ? "编辑" : "新增"}二级食材大类 key=${categoryKey} | 变更: ${
          existingIndex > -1
            ? LogService.diffFields(activeCategories[existingIndex] as any, savedCategory as any, ["label"])
            : `label=${LogService.fmt(savedCategory.label)}`
        }`,
        StorageService.auditCtx()
      );
      return savedCategory;
    });
  }

  /**
   * @description 删除二级大类配置（阶段C·业务规则迁移到后端）：
   * 系统默认大类禁止删除，错误文案与迁移前的前端实现逐字一致。
   * @param {string} key 大类标识键
   * @returns {Promise<void>}
   */
  public static async deleteCategory(key: string): Promise<void> {
    return StorageService.withWriteLock(async () => {
      const current = await StorageService.load();
      const upperKey = key.toUpperCase();
      const activeCategories: DynamicCategory[] = current.activeCategories ?? [];
      // 大小写不敏感匹配，并按大类实际行的 key 下删除 op（与 deleteGroup 一致），避免历史非大写 key 删不掉
      const target = activeCategories.find((c) => c.key.toUpperCase() === upperKey);
      if (target?.isDefault) {
        throw new Error(`「${target.label}」是系统默认大类，不允许删除，如需调整可编辑其名称`);
      }

      const ops: SyncOp[] = [{ entity: "activeCategory", op: "delete", key: target ? target.key : upperKey }];

      const ok = await StorageService.saveInternal(ops);
      if (!ok) {
        throw new Error("删除大类配置失败");
      }
      LogService.audit(
        "config.category.delete",
        `删除二级食材大类 key=${target ? target.key : upperKey} label=${LogService.fmt(target?.label)}`,
        StorageService.auditCtx()
      );
    });
  }
}

// 初始化存储目录
StorageService.init();
