/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 客户端与后端持久化层之间的同步协调器（SyncHelper）：阶段三·增量写协议——收集调用方显式描述的
 * "这次到底变了什么"（SyncOp），去抖动 200ms 合并批量提交给服务端，并在系统初始化完成前加锁防止空状态覆写云端数据。
 * 取代此前"每次都整体拉取全部内存状态、整体 POST"的旧协议（BackendData/memoryFetcher/triggerSyncToServer）。
 * 另提供 refreshNow()：拉取全量最新状态并应用进各业务 service 内存，供写操作完成后的主动刷新、以及
 * 切换查看月份时的懒加载使用（心跳轮询已于 [2026-07-07] 随"按月懒加载 + 304 缓存"改造移除，见 useAppData.ts）。
 */

import { PrepReportService } from "./store.ts";
import { LedgerService } from "./ledgerStore.ts";
import { RawMaterialsDictService } from "./rawMaterialDict.ts";
import { LogBroker } from "../utils.ts";

/**
 * @description 把一批增量 SyncOp 概括成紧凑的一行，用于日志（`entity:op:key` 逗号分隔）
 * @param {Array<[string, SyncOp]> | SyncOp[]} batch 批次（可含去重 key）或纯 op 数组
 * @returns {string} 形如 `ledgerItemDailyRecord:upsert:{"itemId":"x","date":"2026-09-03"}, ledgerItem:upsert:x`
 */
function summarizeOps(batch: Array<[string, SyncOp]> | SyncOp[]): string {
  const ops: SyncOp[] = batch.map((entry) => (Array.isArray(entry) ? entry[1] : entry));
  if (!ops.length) return "(空批次)";
  return ops
    .map((op) => {
      const k = op.key === undefined ? "" : (typeof op.key === "object" ? JSON.stringify(op.key) : String(op.key));
      return `${op.entity}:${op.op}${k ? ":" + k : ""}`;
    })
    .join(", ");
}

/**
 * @description 后端读取接口 GET /api/storage/load 返回的完整状态数据结构（读路径不受本次改造影响，仍是整体状态）
 */
export interface BackendData {
  activeGroups?: any[];
  activeCategories?: any[];
  ledgers?: any[];
  ledgerItems?: any[];
  rawMaterialsDict?: any[];
  ledgerHelperDict?: Record<string, string[]>;
}

/** 阶段三·增量写协议：可增量写入的实体类型，需与 server/storageService.ts 的 SyncOpEntity 保持一致 */
export type SyncOpEntity =
  | "ledger" | "ledgerItem" | "ledgerItemDailyRecord" | "activeGroup" | "activeCategory" | "rawMaterial" | "ledgerHelperOptions";

/**
 * @description 单个增量同步操作，由每个具体的 mutation 方法在完成内存状态变更后显式构造并调用 queueChange() 提交。
 * key 的形状按 entity 而定：大多数实体是主键字符串，ledgerItemDailyRecord/preparedItemDailyData 是
 * { itemId, date } 复合键，report 是 { targetGroup, year, month } 复合键。previousKey 仅供主键本身可被改名的
 * 实体（目前只有 rawMaterial.name）在改名时携带旧主键，供后端清理旧行。
 * op: "replaceAll" 仅供首次启动/批量种子数据生成场景使用。
 */
export interface SyncOp {
  entity: SyncOpEntity;
  op: "upsert" | "delete" | "replace" | "replaceAll";
  key?: any;
  data?: any;
  previousKey?: any;
}

/**
 * @description 客户端与服务端数据同步助手类 (剔除 LocalStorage 本地缓存，完全基于内存与服务器通信)
 */
export class SyncHelper {
  /**
   * @description 当前前端所持有的全局数据库版本号（用于乐观锁校验防冲突）
   */
  public static currentDbVersion?: number;

  /**
   * @description 版本冲突（HTTP 409）时的通知回调。数据层只负责“把冲突这件事告诉出去”，具体如何提示由此回调决定——
   * 默认是一个阻断式 window.alert（保持既有 UX），上层（如 App.tsx）可替换为更友好的浮层，测试里可替换为 spy，
   * 设为 null 则完全静默（仅靠调用方 catch VERSION_CONFLICT）。传入的 message 已是拼好的中文提示文案。
   */
  public static onVersionConflict: ((message: string) => void) | null = (message: string) => {
    if (typeof window !== "undefined" && typeof window.alert === "function") {
      window.alert(message);
    }
  };

  /** 当前内存中缓存的台账每日流水数据所属的起始日期 */
  private static loadedStartDate?: string;
  /** 当前内存中缓存的台账每日流水数据所属的结束日期 */
  private static loadedEndDate?: string;

  /**
   * @description 串行化所有 loadFromServer 的 Promise 链。多个 effect（App.tsx 的侧边栏月度合计、
   * LedgerSystem 的账期/样式切换、以及首屏三个服务各自的初始化）会在同一次渲染里并发触发拉取，
   * 若不串行化，响应可能乱序返回并彼此覆盖 loadedStartDate/End 与三大 service 的内存——尤其是一个更窄
   * 区间的响应最后落地，会把更宽区间的内存数据“冲掉”，且缓存标记还停留在窄区间导致后续不再补拉。
   * 串行化后每个拉取都能看到前一个更新过的 loadedStartDate/End，配合“区间只扩不缩”的并集逻辑彻底消除竞态。
   */
  private static loadChain: Promise<unknown> = Promise.resolve();

  /**
   * @description 全局初始化安全锁，只有在首屏 Promise.all 完美拉取就绪后才允许上传，防止引导时空内存覆盖服务器数据
   */
  private static isInitialized = false;

  /**
   * @description 初始化解锁前暂存的一次性回调队列（解锁后立即依次执行并清空）
   */
  private static onReadyQueue: Array<() => void> = [];

  /**
   * @description 开启或关闭全局初始化同步锁
   */
  public static setInitialized(val: boolean): void {
    this.isInitialized = val;
    console.log(`[SYNC HELPER] 全局初始化数据状态锁定已更新为: ${val ? "已就绪(解开限制)" : "未初始化(强力拦截)"}`);
    if (val && this.onReadyQueue.length > 0) {
      const queue = this.onReadyQueue;
      this.onReadyQueue = [];
      queue.forEach((fn) => fn());
    }
  }

  /**
   * @description 注册一个仅在全局初始化解锁后才执行一次的回调；若此时已解锁则立即同步执行，避免早于初始化完成的同步请求被拦截丢弃
   * @param fn 待执行的回调
   */
  public static runWhenInitialized(fn: () => void): void {
    if (this.isInitialized) {
      fn();
    } else {
      this.onReadyQueue.push(fn);
    }
  }

  /**
   * @description 待提交的增量操作批次，key 为 `entity:JSON(key)`，同一 debounce 窗口内对同一实体+主键的重复写入
   * 自然合并为最后一次（解决"同一单元格连续两次失焦保存"发送冗余/过期请求的问题）
   */
  private static pendingOps: Map<string, SyncOp> = new Map();

  /**
   * @description 防抖同步定时器句柄，用于取消上一次尚未触发的延迟保存
   */
  private static debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @description flush() 失败后的连续重试计数，超过上限即放弃并打印明显日志，避免无限重试
   */
  private static retryCount = 0;

  /** @description 连续重试的次数上限 */
  private static readonly MAX_RETRY = 3;

  /**
   * @description 是否有一批增量操作正在向后端发起提交请求、尚未收到响应（区别于 pendingOps：
   * pendingOps 是"还没到 200ms 防抖时间"，isFlushing 是"已经在路上、等服务器确认"）
   */
  private static isFlushing = false;

  /**
   * @description 是否存在尚未被服务器确认落盘的本地变更（排队等待防抖、或已发出请求等待响应）。
   * 供"保存"类交互在放行页面浏览前调用（见 waitForPendingSync()），确保用户看到的不是
   * "本地已更新、服务器尚未确认"的中间态。
   */
  public static hasPendingSync(): boolean {
    return this.pendingOps.size > 0 || this.debounceTimer !== null || this.isFlushing;
  }

  /**
   * @description 等待当前所有排队中与正在提交的增量操作全部完成（成功或达到重试上限后放弃），
   * 供"保存"类交互在正式呈现"已同步"提示或放行页面浏览前调用，确保用户看到的不是"本地已更新、
   * 服务器尚未确认"的中间态。
   */
  public static waitForPendingSync(): Promise<void> {
    if (!this.hasPendingSync()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const check = () => {
        if (!this.hasPendingSync()) {
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  /**
   * @description 封装 fetch 请求，自动注入当前版本号，拦截并发冲突，并自动更新版本号
   */
  public static async fetchWithVersion(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (this.currentDbVersion !== undefined) {
      headers.set("X-Base-Version", this.currentDbVersion.toString());
    }

    const response = await fetch(input, { ...init, headers });

    if (response.status === 409) {
      const errJson = await response.json().catch(() => ({}));
      // 数据层只负责把“发生了版本冲突”这件事通知出去，如何提示交给 onVersionConflict 回调（默认阻断式 alert）
      const message = `🚨 数据冲突保护\n\n${errJson.error || "数据已被其他设备修改！"}\n为防止覆盖他人数据，请立即刷新页面以获取最新数据。`;
      try {
        SyncHelper.onVersionConflict?.(message);
      } catch (notifyErr) {
        console.error("[SYNC HELPER] 版本冲突通知回调执行失败:", notifyErr);
      }
      throw new Error("VERSION_CONFLICT");
    }

    const newVersion = response.headers.get("X-New-Version");
    if (newVersion) {
      this.currentDbVersion = parseInt(newVersion, 10);
    }

    return response;
  }

  /**
   * @description 从服务器拉取最新的完整数据并返回给调用层（包含按月懒加载逻辑）。
   * 所有拉取都排进 loadChain 串行执行（见该字段说明），杜绝多个 effect 并发触发时响应乱序落地互相覆盖。
   * @param {string} [startDate] 可选。需要拉取流水的起始日期 (YYYY-MM-DD)
   * @param {string} [endDate] 可选。需要拉取流水的结束日期 (YYYY-MM-DD)
   * @param {{ strict?: boolean }} [opts] strict=true 时，网络失败/非 2xx 会 reject 给调用方（用于用户主动切换账期等
   *        强一致场景，需要明确"拉取成功"才放行操作）；默认 false，保持"失败静默 return null"的既有行为。
   * @returns {Promise<BackendData | null>} 获取到的后端数据，若返回 304 则返回 null (或特殊标记)
   */
  public static loadFromServer(startDate?: string, endDate?: string, opts?: { strict?: boolean }): Promise<BackendData | null> {
    const run = this.loadChain.then(
      () => this.loadFromServerInner(startDate, endDate, opts),
      () => this.loadFromServerInner(startDate, endDate, opts)
    );
    // 链上只保留“已完成”信号，吞掉结果与异常，避免某次失败的拉取阻断后续排队的拉取
    this.loadChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * @description loadFromServer 的实际执行体（已在 loadChain 串行保护下运行）。
   * 关键约束：
   *  1. 区间“只扩不缩” —— 把请求区间与当前已加载区间取并集再去拉，避免一个更窄的请求把更宽的内存数据覆盖掉；
   *  2. 不带区间参数 = 级联/强制刷新 —— 按当前已加载区间重新拉一次并强制绕过 304，务必拿到写操作连带的级联结果；
   *  3. 只有真正扩了窗（或首次带区间拉取）才附加 bypassCache，其余情况交给 X-Base-Version 走 304 快路径。
   * @param {string} [reqStart] 调用方请求的起始日期
   * @param {string} [reqEnd] 调用方请求的结束日期
   * @param {{ strict?: boolean }} [opts] strict=true 时把真实失败向上抛（见 loadFromServer 说明）
   * @returns {Promise<BackendData | null>}
   */
  private static async loadFromServerInner(reqStart?: string, reqEnd?: string, opts?: { strict?: boolean }): Promise<BackendData | null> {
    try {
      // 不带区间参数：级联后的主动刷新，按当前已加载区间重拉并强制绕过 304
      const isForceRefresh = !reqStart || !reqEnd;

      // 区间只扩不缩：与已加载区间取并集
      let startDate = reqStart;
      let endDate = reqEnd;
      if (this.loadedStartDate && this.loadedEndDate) {
        startDate = startDate && startDate < this.loadedStartDate ? startDate : this.loadedStartDate;
        endDate = endDate && endDate > this.loadedEndDate ? endDate : this.loadedEndDate;
      }

      const isRangeExtension =
        !!startDate && !!endDate &&
        (startDate !== this.loadedStartDate || endDate !== this.loadedEndDate);

      const params = new URLSearchParams();
      if (startDate) params.append("start", startDate);
      if (endDate) params.append("end", endDate);
      if (isForceRefresh || isRangeExtension) params.append("bypassCache", "true");

      const url = `/api/storage/load${params.toString() ? '?' + params.toString() : ''}`;

      // 使用 fetchWithVersion 以便在请求头带上 X-Base-Version 支持 304 判断，并自动更新返回的新版本号
      const response = await this.fetchWithVersion(url);

      if (response.status === 304) {
        console.log("[SYNC HELPER] 数据未修改 (304 Not Modified)，无需重新拉取");
        return null;
      }

      if (!response.ok) {
        throw new Error(`服务器拉取失败: ${response.statusText}`);
      }

      const data: BackendData = await response.json();

      // 更新当前已加载的日期区间缓存（已按并集扩窗）
      if (startDate && endDate) {
        this.loadedStartDate = startDate;
        this.loadedEndDate = endDate;
      }

      if (!data) return null;

      // 更新内存中的数据库版本号
      if ((data as any).dbVersion !== undefined) {
        this.currentDbVersion = (data as any).dbVersion;
      }

      // 过滤掉只有 isFirstBoot 而无其他数据属性的空状态壳，使其能在首航返回 null 并加载本地默认种子
      const hasRealPayload = Object.keys(data).some(k => k !== "isFirstBoot" && k !== "dbVersion");
      if (!hasRealPayload) {
        return { isFirstBoot: (data as any).isFirstBoot } as any;
      }

      return data;
    } catch (err) {
      console.error("[SYNC HELPER] 从后端加载数据失败:", err);
      // strict 模式（用户主动切换账期等强一致场景）：把真实的网络/5xx 失败抛给调用方去提示并重试，
      // 不再静默 return null 让 UI 用可能不完整的旧数据继续渲染。
      if (opts?.strict) throw (err instanceof Error ? err : new Error(String(err)));
      return null;
    }
  }

  /**
   * @description 把一份已经拉取到的全量最新状态与当前内存逐字段比对，仅对真正变化的字段调用对应 service 的
   * setXxxInMemory() 覆盖内存，变化时统一 forceNotify() 触发 UI 重绘。纯函数式的"应用"步骤，不涉及网络请求，
   * 供 refreshNow()（先自行 loadFromServer() 拉取最新状态，再调用本方法）复用这份 diff+应用逻辑。
   * @param {BackendData} freshData 已经拉取到的全量最新状态
   * @returns {boolean} 本次是否真的检测到并应用了变化
   */
  public static applyFreshData(freshData: BackendData): boolean {
    let memoryChanged = false;
    const changedParts: string[] = [];

    // 数据丢失高发点：若此刻还有未落盘的本地变更（排队防抖 / 正在提交），用服务器快照整体覆盖内存
    // 可能把用户刚录入、尚未确认落盘的数据"冲掉"。这里在覆盖前留痕，便于事后按时间点核对。
    const hadPendingWhenRefreshed = this.hasPendingSync();

    if (freshData.activeGroups && JSON.stringify(freshData.activeGroups) !== JSON.stringify(PrepReportService.getActiveGroups())) {
      PrepReportService.setActiveGroupsInMemory(freshData.activeGroups);
      memoryChanged = true;
      changedParts.push("activeGroups");
    }
    if (freshData.activeCategories && JSON.stringify(freshData.activeCategories) !== JSON.stringify(PrepReportService.getActiveCategories())) {
      PrepReportService.setActiveCategoriesInMemory(freshData.activeCategories);
      memoryChanged = true;
      changedParts.push("activeCategories");
    }
    if (freshData.ledgers && JSON.stringify(freshData.ledgers) !== JSON.stringify(LedgerService.getLedgers())) {
      LedgerService.setLedgersInMemory(freshData.ledgers);
      memoryChanged = true;
      changedParts.push("ledgers");
    }
    if (freshData.ledgerItems && JSON.stringify(freshData.ledgerItems) !== JSON.stringify(LedgerService.getLedgerItems())) {
      const beforeCount = LedgerService.getLedgerItems().length;
      const afterCount = freshData.ledgerItems.length;
      LedgerService.setLedgerItemsInMemory(freshData.ledgerItems);
      memoryChanged = true;
      changedParts.push(`ledgerItems(${beforeCount}->${afterCount}项)`);
    }
    if (freshData.rawMaterialsDict && JSON.stringify(freshData.rawMaterialsDict) !== JSON.stringify(RawMaterialsDictService.getItems())) {
      RawMaterialsDictService.setRawMaterialsDictInMemory(freshData.rawMaterialsDict);
      memoryChanged = true;
      changedParts.push("rawMaterialsDict");
    }

    if (memoryChanged) {
      PrepReportService.forceNotify();
      LedgerService.forceNotify();
      LogBroker.publish(
        hadPendingWhenRefreshed ? "WARN" : "INFO",
        "SyncHelper",
        `已用服务器最新快照覆盖本地内存（${changedParts.join(", ")}）` +
          (hadPendingWhenRefreshed ? "；注意：覆盖时仍有未落盘的本地变更，可能覆盖掉尚未同步的录入" : ""),
        `dbVersion=${this.currentDbVersion ?? "∅"}`
      );
    }
    return memoryChanged;
  }

  /**
   * @description 拉取一次全量最新状态并立即应用（fetch + applyFreshData 的组合）。
   * 供"某个操作已确定成功、且后端可能连带级联修改了其它实体"的场景在拿到成功响应后主动调用（不带参数：
   * 按当前已加载区间强制刷新），也用于按需懒加载切换日期区间时刷新数据（带区间：与已加载区间取并集）。
   * 底层 loadFromServer 已在 loadChain 上串行执行且区间只扩不缩，因此并发的多次 refreshNow 不会互相覆盖，
   * 最终落地的一定是最宽区间的数据。
   * @param {{ strict?: boolean }} [opts] strict=true 时，拉取失败会 reject（调用方据此提示并重试），而非静默返回 false
   * @returns {Promise<boolean>} 本次是否真的检测到并应用了变化
   */
  public static async refreshNow(startDate?: string, endDate?: string, opts?: { strict?: boolean }): Promise<boolean> {
    const freshData = await SyncHelper.loadFromServer(startDate, endDate, opts);
    if (!freshData) {
      // 可能是 304（数据已是最新），也可能是非 strict 模式下被静默的错误
      return false;
    }
    return SyncHelper.applyFreshData(freshData);
  }

  /**
   * @description 把一个增量同步操作描述加入待提交批次，去抖动 200 毫秒后统一打包提交给后端。
   * 每个具体的 mutation 方法（如新增一条台账原料、编辑某天的出入库记录）都应在完成内存状态变更后
   * 显式调用此方法描述"这次到底变了什么"，而不是像旧协议那样整体重新拉取全部内存状态。
   * @param {SyncOp} op 本次变更的增量操作描述
   * @returns {void}
   */
  public static queueChange(op: SyncOp): void {
    if (!this.isInitialized) {
      console.warn("[SYNC HELPER] 系统尚未初始化完成，拦截空内存数据同步云端，保护云端数据安全");
      return;
    }

    const dedupeKey = `${op.entity}:${JSON.stringify(op.key ?? null)}`;
    this.pendingOps.set(dedupeKey, op);
    this.scheduleFlush();
  }

  /**
   * @description 安排（或重新安排）一次防抖 flush：取消上一个尚未触发的计时器，重新计时 200 毫秒
   * @returns {void}
   */
  private static scheduleFlush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flush();
    }, 200);
  }

  /**
   * @description 把当前累积的待提交批次一次性打包 POST 给后端；失败时把这批操作（若未被更新的同 key 操作覆盖）
   * 重新放回队列并安排一次重试，超过重试上限后放弃并打印明显日志（这是增量写协议相比"整体覆盖"引入的新失败模式：
   * 旧协议下一次 POST 失败，下一次任意 mutation 触发的全量快照能顺带把丢失的写入捎带回来；
   * 增量协议下每个 op 出队后如果不重试就真的丢了）
   * @returns {Promise<void>}
   */
  private static async flush(): Promise<void> {
    if (this.pendingOps.size === 0) {
      return;
    }
    const batch = Array.from(this.pendingOps.entries());
    this.pendingOps.clear();
    const ops = batch.map(([, op]) => op);

    this.isFlushing = true;
    try {
      const response = await this.fetchWithVersion("/api/storage/save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ protocolVersion: 2, ops })
      });

      if (!response.ok) {
        throw new Error(`服务器保存失败: ${response.statusText}`);
      }

      const resJson = await response.json();
      this.retryCount = 0;
      console.log(`[SYNC HELPER] ${ops.length} 个增量同步操作已成功提交至服务器后端:`, resJson);
    } catch (err) {
      // 版本冲突（409）：重试只会继续冲突，补传/暂存则会覆盖他人数据——直接放弃这批、不重试也不暂存。
      // fetchWithVersion 已经触发过 onVersionConflict（提示用户刷新），这里只需清账。
      if (err instanceof Error && err.message === "VERSION_CONFLICT") {
        console.error("[SYNC HELPER] 版本冲突（409），放弃这批增量操作（用户需刷新页面获取最新数据）:", summarizeOps(batch));
        this.retryCount = 0;
        return;
      }
      // 仅打印到控制台，不在这里上报 /api/log：真正需要留痕的是"彻底放弃"的那一刻（见 retryFailedBatch），
      // 中间每次瞬时失败都上报会放大噪音，也会干扰对重试次数的精确断言。
      console.error(
        `[SYNC HELPER] 增量同步提交失败（将重试 ${this.retryCount + 1}/${this.MAX_RETRY}）:`,
        err,
        "ops:",
        summarizeOps(batch)
      );
      this.retryFailedBatch(batch);
    } finally {
      this.isFlushing = false;
    }
  }

  /** 连续重试仍失败、被放弃的增量操作暂存到本地的 key，下次加载完成后自动补传（见 replayStashedOps） */
  private static readonly STASH_KEY = "kpmss_pending_sync_ops";

  /**
   * @description 把一批（因连续重试失败而）被放弃的增量操作追加暂存到 localStorage，等下次应用启动完成后补传。
   * 仅用于网络/服务端 5xx 这类“过一会可能就好”的失败；版本冲突不会走到这里（见 flush）。
   */
  private static stashFailedOps(ops: SyncOp[]): void {
    if (typeof localStorage === "undefined" || ops.length === 0) return;
    try {
      const existing: SyncOp[] = JSON.parse(localStorage.getItem(SyncHelper.STASH_KEY) || "[]");
      localStorage.setItem(SyncHelper.STASH_KEY, JSON.stringify([...existing, ...ops]));
    } catch (e) {
      console.error("[SYNC HELPER] 暂存失败的同步操作到本地时出错:", e);
    }
  }

  /**
   * @description 在全局初始化完成后（见 useAppData 调用点）调用一次：把上次遗留、暂存在本地的失败增量操作
   * 重新入队补传。补传前先取出并清空暂存，避免重复。
   * @returns {void}
   */
  public static replayStashedOps(): void {
    if (typeof localStorage === "undefined") return;
    let ops: SyncOp[] = [];
    try {
      ops = JSON.parse(localStorage.getItem(SyncHelper.STASH_KEY) || "[]");
    } catch {
      ops = [];
    }
    if (!Array.isArray(ops) || ops.length === 0) return;
    localStorage.removeItem(SyncHelper.STASH_KEY);
    console.log(`[SYNC HELPER] 检测到上次有 ${ops.length} 个未同步的本地变更，正在补传`);
    LogBroker.publish(
      "WARN",
      "SyncHelper",
      `检测到上次有 ${ops.length} 个未同步的本地变更（暂存在本地），正在补传`,
      `补传的 ops: ${summarizeOps(ops)}`
    );
    for (const op of ops) {
      this.pendingOps.set(`${op.entity}:${JSON.stringify(op.key ?? null)}`, op);
    }
    this.scheduleFlush();
  }

  /**
   * @description flush() 失败后的重试处理：把这批操作放回待提交队列（若某个 key 期间已经有更新的操作覆盖了它，
   * 则不用失败的旧数据覆盖回去），重新安排一次 flush；超过连续重试上限后放弃
   * @param {Array<[string, SyncOp]>} batch 本次失败的操作批次（含去重 key）
   * @returns {void}
   */
  private static retryFailedBatch(batch: Array<[string, SyncOp]>): void {
    if (this.retryCount >= this.MAX_RETRY) {
      console.error(
        `[SYNC HELPER] 已连续重试 ${this.retryCount} 次仍失败，放弃这批 ${batch.length} 个同步操作，` +
        `已暂存到本地，将在下次加载完成后自动补传。`
      );
      // 曾经的数据丢失高发点：现在改成把这批 op 暂存进 localStorage，下次启动 replayStashedOps() 补传，
      // 而不是彻底丢弃。仍记 ERROR 供按时间点排查。
      const ops = batch.map(([, op]) => op);
      SyncHelper.stashFailedOps(ops);
      LogBroker.publish(
        "ERROR",
        "SyncHelper",
        `增量同步连续重试 ${this.MAX_RETRY} 次仍失败，已把 ${ops.length} 个操作暂存本地，将在下次加载完成后自动补传`,
        `暂存的 ops: ${summarizeOps(batch)}`
      );
      this.retryCount = 0;
      return;
    }
    this.retryCount += 1;
    for (const [key, op] of batch) {
      if (!this.pendingOps.has(key)) {
        this.pendingOps.set(key, op);
      }
    }
    this.scheduleFlush();
  }
}
