/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 服务端日志文件持久化服务：将系统运行时的信息/警告/错误日志以带时间戳的格式追加写入本地日志文件；日志按"日期"自动分文件归档，单个日期文件超出体积上限时自动按序号滚动到下一个分片文件，避免出现体积无限增长的单个大文件。
 *
 * 两条相互独立的归档流（各自独立的活跃文件缓存与体积滚动）：
 *  1. 运行日志 `app-YYYY-MM-DD.log`   —— 通过 LogService.write() 写入，承载 HTTP 请求、系统启动、异常堆栈、客户端上报等运行期信息。
 *  2. 数据审计日志 `audit-YYYY-MM-DD.log` —— 通过 LogService.audit() 写入，只承载"数据被增/删/改了什么"的结构化前后对照记录，
 *     便于按时间点精确回溯某条台账数据在什么时刻由哪个请求改成了什么（数据丢失排查的主要依据）。写审计流的同时也会把同一条
 *     记录以 [AUDIT] 前缀镜像进运行日志，方便只翻一个文件时也能看到；但按数据问题排查时应优先只 grep audit-*.log。
 *
 * 新增任何会落库的数据变更方法时，务必同步补一条 LogService.audit(...) 记录，约定见根目录 LOGGING.md。
 */

import path from "path";
import fs from "fs";

/**
 * @description 日志文件持久化服务类，在本地部署时把日志保存在本地，按日期+体积自动归档，包含详细时间、事件描述
 */
export class LogService {
  /** 本地日志根目录，默认为 data/logs，每天的日志各自独立成文件存放于此目录下 */
  private static logDir: string = path.resolve(process.env.LOCAL_LOG_DIR || "data/logs");

  /** 单个日志文件的体积上限（字节），默认 5MB；超出后自动滚动到下一个序号分片文件继续写入 */
  private static maxFileSizeBytes: number =
    (Number(process.env.LOG_MAX_FILE_SIZE_MB) || 5) * 1024 * 1024;

  /** 当前缓存的活跃「运行日志」文件路径，避免每次写入都重新扫描目录 */
  private static activeFilePath: string | null = null;

  /** 当前缓存的活跃「数据审计日志」文件路径（与运行日志相互独立地滚动） */
  private static auditActiveFilePath: string | null = null;

  /**
   * 初始化日志所在目录，并将升级前遗留的单一大日志文件（data/app.log）平滑迁移进新的归档目录，避免旧日志被遗漏
   */
  public static init(): void {
    if (!fs.existsSync(LogService.logDir)) {
      fs.mkdirSync(LogService.logDir, { recursive: true });
    }

    const legacyLogPath = path.resolve("data/app.log");
    const migratedLegacyPath = path.join(LogService.logDir, "app-legacy-migrated.log");
    if (fs.existsSync(legacyLogPath) && !fs.existsSync(migratedLegacyPath)) {
      try {
        fs.renameSync(legacyLogPath, migratedLegacyPath);
        console.log(`[LOG SERVICE] 已将升级前的历史日志文件迁移至归档目录: ${migratedLegacyPath}`);
      } catch (err) {
        console.error("[LOG SERVICE ERROR] 迁移历史日志文件失败:", err);
      }
    }
  }

  /**
   * @description 获取当前日期（Asia/Shanghai 时区）字符串，固定 YYYY-MM-DD 格式
   */
  private static getTodayDateStr(): string {
    // sv-SE 语言环境固定输出 YYYY-MM-DD 格式
    return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
  }

  /**
   * @description 解析某条归档流当前应写入的文件路径：按日期归档，若当天已有文件写满（超出体积上限）则自动滚动到下一个序号分片。
   * "运行日志"（prefix=app）与"数据审计日志"（prefix=audit）各自维护独立的活跃文件路径缓存与滚动序号。
   * @param {"app" | "audit"} prefix 归档流前缀
   * @returns {string} 当前应写入的日志文件绝对路径
   */
  private static resolveLogFilePath(prefix: "app" | "audit"): string {
    const baseName = `${prefix}-${LogService.getTodayDateStr()}`;
    const cached = prefix === "app" ? LogService.activeFilePath : LogService.auditActiveFilePath;

    // 优先复用缓存路径（同一天且尚未写满时，避免重复扫描目录）
    if (cached && path.basename(cached).startsWith(baseName)) {
      try {
        const stat = fs.statSync(cached);
        if (stat.size < LogService.maxFileSizeBytes) {
          return cached;
        }
      } catch {
        // 缓存路径的文件不存在（如被手动删除），忽略并重新计算
      }
    }

    // 从当天的主文件开始，逐个序号探测，找到第一个"不存在"或"未写满"的分片文件
    let candidate = path.join(LogService.logDir, `${baseName}.log`);
    let seq = 0;
    while (fs.existsSync(candidate)) {
      const stat = fs.statSync(candidate);
      if (stat.size < LogService.maxFileSizeBytes) {
        break;
      }
      seq += 1;
      candidate = path.join(LogService.logDir, `${baseName}.${seq}.log`);
    }

    if (prefix === "app") {
      LogService.activeFilePath = candidate;
    } else {
      LogService.auditActiveFilePath = candidate;
    }
    return candidate;
  }

  /**
   * @description 解析运行日志（app-*.log）当前应写入的文件路径（保留原方法名，供 write() 与既有测试使用）
   * @returns {string} 当前应写入的运行日志文件绝对路径
   */
  private static resolveActiveLogFilePath(): string {
    return LogService.resolveLogFilePath("app");
  }

  /**
   * @description 把一行文本异步追加进指定日志文件；若目录被人为删除则重建目录后重试一次
   * @param {string} filePath 目标日志文件路径
   * @param {string} logLine 已组装好、以换行结尾的单行日志文本
   */
  private static appendLine(filePath: string, logLine: string): void {
    fs.appendFile(filePath, logLine, "utf8", (err) => {
      if (err && err.code === "ENOENT") {
        // 如果目录被人为删除了，尝试重新创建目录并重试异步写入一次
        fs.mkdir(LogService.logDir, { recursive: true }, (mkdirErr) => {
          if (!mkdirErr) {
            fs.appendFile(filePath, logLine, "utf8", () => {});
          } else {
            console.error("[LOG SERVICE ERROR] 重建日志目录并重试写入失败:", mkdirErr);
          }
        });
      } else if (err) {
        console.error("[LOG SERVICE ERROR] 异步写入本地日志文件失败:", err);
      }
    });
  }

  public static write(level: string, category: string, message: string): void {
    // 采用异步写入方式，避免同步IO阻塞 Node.js 主线程从而影响服务器并发性能
    const writeLog = () => {
      const filePath = LogService.resolveActiveLogFilePath();
      const timeStr = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
      const logLine = `[${timeStr}] [${level}] [${category}] ${message}\n`;

      LogService.appendLine(filePath, logLine);

      // 满足需求：控制台要输出“用户在什么时候对什么做了什么操作”的记录，且避免影响性能
      // 这里的 console 是异步非阻塞的（在输出重定向时），直接打印即可
      const consoleOutput = `[系统日志] 用户在 ${timeStr} 对 ${category} 做了操作: ${message}`;
      if (level === "ERROR") {
        console.error(consoleOutput);
      } else if (level === "WARN") {
        console.warn(consoleOutput);
      } else {
        console.log(consoleOutput);
      }
    };

    try {
      writeLog();
    } catch (err: any) {
      console.error("[LOG SERVICE ERROR] 启动日志写入任务失败:", err);
    }
  }

  /**
   * @description 写入一条结构化「数据审计」记录：只用于记录数据被增/删/改成了什么，是按时间点回溯数据变化的主要依据。
   * 同一条记录会写入 audit-YYYY-MM-DD.log，并以 [AUDIT] 前缀镜像一份进 app-YYYY-MM-DD.log（level 由 result 决定：
   * 失败/丢弃类记 ERROR、跳过/告警类记 WARN、其余记 INFO）。
   *
   * 约定的 detail 写法（尽量一行内自解释，键值用 ` | ` 分段）：
   *   `entity=<主键>(<可读名>) | 变更: <字段 旧值 -> 新值, ...> | <子动作: 例如 当日记录 created/updated/deleted> | <重算: 例如 库存 3->1>`
   *
   * @param {string} action 点分动作名，如 `ledger.dailyRecord.update`、`ledger.item.delete`、`dict.rawMaterial.rename`、`config.group.delete`、`sync.batch.discard`
   * @param {string} detail 结构化的前后对照描述（见上）
   * @param {string} [ctx] 可选的请求上下文串（如 `req=ab12cd34 PUT /api/ledger-items/x/daily/2026-09-03 baseVer=5 dbVer=6`），由调用方从 RequestContext 组装
   * @param {"info" | "warn" | "error"} [severity] 严重级别，默认 info；warn=数据被跳过/未按预期写入，error=数据写入失败或被丢弃
   */
  public static audit(
    action: string,
    detail: string,
    ctx?: string,
    severity: "info" | "warn" | "error" = "info"
  ): void {
    try {
      const timeStr = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
      const ctxPart = ctx ? ` ${ctx}` : "";
      const body = `${action}${ctxPart} | ${detail}`;

      // 1) 写独立审计流
      const auditPath = LogService.resolveLogFilePath("audit");
      LogService.appendLine(auditPath, `[${timeStr}] [AUDIT] ${body}\n`);

      // 2) 镜像一份进运行日志，方便只翻一个文件时也能看到数据动作
      const level = severity === "error" ? "ERROR" : severity === "warn" ? "WARN" : "INFO";
      const appPath = LogService.resolveActiveLogFilePath();
      LogService.appendLine(appPath, `[${timeStr}] [${level}] [AUDIT] ${body}\n`);

      const consoleOutput = `[数据审计] ${timeStr} ${body}`;
      if (severity === "error") {
        console.error(consoleOutput);
      } else if (severity === "warn") {
        console.warn(consoleOutput);
      } else {
        console.log(consoleOutput);
      }
    } catch (err: any) {
      console.error("[LOG SERVICE ERROR] 写入数据审计日志失败:", err);
    }
  }

  /**
   * @description 把任意值格式化成审计日志里紧凑、可读的表示：空值统一记作 ∅，字符串加引号，对象/数组走 JSON。
   * @param {unknown} v 原始值
   * @returns {string} 紧凑可读表示
   */
  public static fmt(v: unknown): string {
    if (v === undefined || v === null || v === "") return "∅";
    if (typeof v === "string") return `"${v}"`;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }

  /**
   * @description 逐字段比对 before/after 两个对象，返回 `字段: 旧值 -> 新值` 的紧凑串（无变化返回"(无字段变化)"）。
   * 供各数据变更方法组装 audit() 的"变更:"段落，统一"增加了什么、减少了什么"的呈现口径。
   * @param {Record<string, unknown> | undefined | null} before 变更前对象
   * @param {Record<string, unknown> | undefined | null} after 变更后对象
   * @param {string[]} fields 需要比对的字段名列表
   * @returns {string} 紧凑的字段级差异串
   */
  public static diffFields(
    before: Record<string, unknown> | undefined | null,
    after: Record<string, unknown> | undefined | null,
    fields: string[]
  ): string {
    const parts: string[] = [];
    for (const f of fields) {
      const b = before ? before[f] : undefined;
      const a = after ? after[f] : undefined;
      if (JSON.stringify(b ?? null) !== JSON.stringify(a ?? null)) {
        parts.push(`${f} ${LogService.fmt(b)} -> ${LogService.fmt(a)}`);
      }
    }
    return parts.length ? parts.join(", ") : "(无字段变化)";
  }
}

// 初始化日志系统物理目录
LogService.init();
