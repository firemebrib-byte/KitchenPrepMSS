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
   * @returns {Promise<BackendData | null>} 获取到的后端数据，若返回 304 则返回 null (或特殊标记)
   */
  public static loadFromServer(startDate?: string, endDate?: string): Promise<BackendData | null> {
    const run = this.loadChain.then(
      () => this.loadFromServerInner(startDate, endDate),
      () => this.loadFromServerInner(startDate, endDate)
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
   * @returns {Promise<BackendData | null>}
   */
  private static async loadFromServerInner(reqStart?: string, reqEnd?: string): Promise<BackendData | null> {
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

    if (freshData.activeGroups && JSON.stringify(freshData.activeGroups) !== JSON.stringify(PrepReportService.getActiveGroups())) {
      PrepReportService.setActiveGroupsInMemory(freshData.activeGroups);
      memoryChanged = true;
    }
    if (freshData.activeCategories && JSON.stringify(freshData.activeCategories) !== JSON.stringify(PrepReportService.getActiveCategories())) {
      PrepReportService.setActiveCategoriesInMemory(freshData.activeCategories);
      memoryChanged = true;
    }
    if (freshData.ledgers && JSON.stringify(freshData.ledgers) !== JSON.stringify(LedgerService.getLedgers())) {
      LedgerService.setLedgersInMemory(freshData.ledgers);
      memoryChanged = true;
    }
    if (freshData.ledgerItems && JSON.stringify(freshData.ledgerItems) !== JSON.stringify(LedgerService.getLedgerItems())) {
      LedgerService.setLedgerItemsInMemory(freshData.ledgerItems);
      memoryChanged = true;
    }
    if (freshData.rawMaterialsDict && JSON.stringify(freshData.rawMaterialsDict) !== JSON.stringify(RawMaterialsDictService.getItems())) {
      RawMaterialsDictService.setRawMaterialsDictInMemory(freshData.rawMaterialsDict);
      memoryChanged = true;
    }

    if (memoryChanged) {
      PrepReportService.forceNotify();
      LedgerService.forceNotify();
    }
    return memoryChanged;
  }

  /**
   * @description 拉取一次全量最新状态并立即应用（fetch + applyFreshData 的组合）。
   * 供"某个操作已确定成功、且后端可能连带级联修改了其它实体"的场景在拿到成功响应后主动调用（不带参数：
   * 按当前已加载区间强制刷新），也用于按需懒加载切换日期区间时刷新数据（带区间：与已加载区间取并集）。
   * 底层 loadFromServer 已在 loadChain 上串行执行且区间只扩不缩，因此并发的多次 refreshNow 不会互相覆盖，
   * 最终落地的一定是最宽区间的数据。
   * @returns {Promise<boolean>} 本次是否真的检测到并应用了变化
   */
  public static async refreshNow(startDate?: string, endDate?: string): Promise<boolean> {
    const freshData = await SyncHelper.loadFromServer(startDate, endDate);
    if (!freshData) {
      // 可能是 304，也可能是错误
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
      console.error("[SYNC HELPER] 增量同步操作提交至后端失败:", err);
      this.retryFailedBatch(batch);
    } finally {
      this.isFlushing = false;
    }
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
        `本地数据可能未能同步至服务器，请检查网络连接与后端服务状态。`
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
