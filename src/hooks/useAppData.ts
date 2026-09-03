/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 封装 App 顶层的核心数据加载逻辑的自定义 Hook：负责首屏并行初始化人群/大类配置、台账、原料字典三大服务，
 * 并订阅各服务的数据变动以驱动重渲染。[2026-07-07] 原先每 10 秒静默拉取全量状态的心跳轮询机制已随"按月懒加载 + 304 缓存"
 * 改造移除，多端数据一致性现在依赖各写操作自身的 SyncHelper.refreshNow() 主动刷新 + 乐观并发版本冲突检测，
 * 不再有其它浏览器/设备的修改会在 10 秒内自动同步过来的能力。
 */

import { useEffect, useState } from "react";
import { DynamicGroup, DynamicCategory } from "../types/types.ts";
import { UI_TEXT } from "../constants/constants.ts";
import { PrepReportService } from "../services/store.ts";
import { LedgerService } from "../services/ledgerStore.ts";
import { SyncHelper } from "../services/syncHelper.ts";
import { RawMaterialsDictService } from "../services/rawMaterialDict.ts";
import { LogBroker } from "../utils.ts";

/**
 * @description useAppData 返回值接口
 */
export interface UseAppDataResult {

  /** 当前激活聚焦决策的一级餐位人群唯一标识Key */
  activeGroup: string;
  setActiveGroup: (val: string | ((prev: string) => string)) => void;
  /** 当前选中的二级食材品类。为 null 时代表"合计汇总"汇总表 */
  activeCategory: string | null;
  setActiveCategory: (val: string | null | ((prev: string | null) => string | null)) => void;
  /** 系统离线架构自检与加载态指示 */
  isLoading: boolean;
  /** 自动同步极速轻量气泡提示文字 */
  saveToast: string | null;
  /** 首屏数据同步进度 */
  syncProgress: number;
  /** 首屏数据同步文本 */
  progressText: string;
  /** 动态从底层存储库嗅探的一级人群分组 */
  activeGroupsList: DynamicGroup[];
  /** 动态从底层存储库嗅探的二级食材大类 */
  activeCategoriesList: DynamicCategory[];
  /** 订阅的购销台账原料列表 */
  ledgerItemsList: any[];
}

/**
 * @description 管理人群/大类配置、台账、原料字典三大服务的首屏并行加载与数据变动订阅的自定义 Hook（心跳轮询已移除，见文件顶部说明）
 */
export function useAppData(): UseAppDataResult {

  /** 当前激活聚焦决策的一级餐位人群唯一标识Key，默认 TEACHER */
  const [activeGroup, setActiveGroup] = useState<string>("");
  /** 当前选中的二级食材品类。当设置为 null 时，代表"合计汇总"汇总表 */
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  /** 系统离线架构自检与加载态指示 */
  const [isLoading, setIsLoading] = useState<boolean>(true);
  /** 自动同步极速轻量气泡提示文字 */
  const [saveToast, setSaveToast] = useState<string | null>(null);

  /** 首屏数据同步进度 */
  const [syncProgress, setSyncProgress] = useState<number>(0);
  /** 首屏数据同步文本 */
  const [progressText, setProgressText] = useState<string>("正在启动网络同步总线...");

  /** 动态从底层存储库嗅探的一级人群分组 */
  const [activeGroupsList, setActiveGroupsList] = useState<DynamicGroup[]>([]);
  /** 动态从底层存储库嗅探的二级食材大类 */
  const [activeCategoriesList, setActiveCategoriesList] = useState<DynamicCategory[]>([]);
  /** 订阅的购销台账原料列表 */
  const [ledgerItemsList, setLedgerItemsList] = useState<any[]>([]);

  /**
   * @description 触发极速防抖自动保存通知标签气泡
   */
  const triggerSaveToast = () => {
    setSaveToast(UI_TEXT.saveSuccess);
    const timer = setTimeout(() => {
      setSaveToast(null);
    }, 2500);
    return () => clearTimeout(timer);
  };

  // 系统初始化，挂载并预检底层存储结构，同时订阅状态变动
  useEffect(() => {
    let active = true;

    // 跟踪首屏并行加载进度
    let progress = 10;
    const reportProgress = (amt: number, txt: string) => {
      progress += amt;
      setSyncProgress(Math.min(100, progress));
      setProgressText(txt);
    };

    // 并行初始化各服务，分别累加进度
    const p1 = PrepReportService.initStore().then(data => {
      reportProgress(30, "已成功装载人群与食材大类配置...");
      return data;
    });

    const p2 = LedgerService.initLedgerStore().then(data => {
      reportProgress(30, "已成功装载原料购销及库存台账...");
      return data;
    });

    const p3 = SyncHelper.loadFromServer().then(data => {
      reportProgress(20, "已成功对齐云端标准大字典底册...");
      return data;
    });

    Promise.all([p1, p2, p3]).then(([prepData, ledgerData, serverData]) => {
      reportProgress(10, "校验并装载全新主控交互面板...");

      // 延迟 400ms 解除，避免一闪而过的尴尬，让进度条 100% 的视觉体验最大化
      setTimeout(() => {
        if (active) {
          // 如果是系统初次启动且 data 目录下没有物理 db.json 数据，清空浏览器本地残留缓存，确保数据完全一致
          if (serverData && (serverData as any).isFirstBoot) {
            console.warn("[SECURITY CLEAR] 监测到系统首航初次启动，强力清洗浏览器旧版缓存，确保与服务器种子一致");
            localStorage.clear();
            sessionStorage.clear();
          }


          setLedgerItemsList(ledgerData.items);

          // 使用服务器的原料大字典来初始化字典内存
          const sDict = serverData ? (serverData as any).rawMaterialsDict : undefined;
          RawMaterialsDictService.initDictFromServer(sDict);

          const groups = PrepReportService.getActiveGroups();
          const cats = PrepReportService.getActiveCategories();
          setActiveGroupsList(groups);
          setActiveCategoriesList(cats);

          // 如果动态列表已经就绪，并且默认或先前的选中项不存在了，自适应调平到首项
          if (groups.length > 0 && !groups.some((g) => g.key === activeGroup)) {
            setActiveGroup(groups[0].key);
          }
          if (cats.length > 0 && activeCategory && !cats.some((c) => c.key === activeCategory)) {
            setActiveCategory(cats[0].key);
          }

          setIsLoading(false);
          SyncHelper.setInitialized(true);
          // 上次因连续重试失败而暂存在本地的增量操作，现在初始化完成、版本号已对齐，补传一次
          SyncHelper.replayStashedOps();
          LogBroker.publish("INFO", "App", "系统已完成人群大类配置、台账以及原料大字典服务数据模型的全局并行加载初始化");
        }
      }, 400);
    }).catch(err => {
      LogBroker.publish("ERROR", "App", "加载基础数据服务异常:", String(err));
    });

    // 监听服务数据重大变动回调，实现各版块自动重算
    const unsubscribe = PrepReportService.subscribe(() => {
      if (active) {
        const groups = PrepReportService.getActiveGroups();
        const cats = PrepReportService.getActiveCategories();
        setActiveGroupsList(groups);
        setActiveCategoriesList(cats);

        // 防止配置后台因级联删除而导致的悬空逻辑
        const groupKeys = groups.map((g) => g.key);
        const catKeys = cats.map((c) => c.key);

        setActiveGroup((prev) => {
          if (prev === "LEDGER") return prev;
          if (groupKeys.includes(prev)) return prev;
          return groupKeys[0] || "";
        });

        setActiveCategory((prev) => {
          if (prev === null) return null;
          if (catKeys.includes(prev)) return prev;
          return catKeys[0] || "";
        });

        // 触发自动存盘微气泡
        triggerSaveToast();
      }
    });

    // 监听原料台账数据的变动，为了能在 aside 底栏展示统计金额
    const unsubscribeLedger = LedgerService.subscribe((_ledgers, updatedItems) => {
      if (active) {
        setLedgerItemsList(updatedItems);
      }
    });

    // 监听前端浏览器全局未捕获 JS 运行时脚本错误
    const handleGlobalError = (event: ErrorEvent) => {
      const errMsg = `Message: ${event.message} | Source: ${event.filename} | Line: ${event.lineno}:${event.colno} | Stack: ${event.error?.stack || "No Stack"}`;
      LogBroker.publish("ERROR", "ClientGlobalError", errMsg);
    };

    // 监听前端未捕获 Promise Rejection
    const handleGlobalRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const errMsg = reason instanceof Error ? `${reason.message}\nStack: ${reason.stack}` : String(reason);
      LogBroker.publish("ERROR", "ClientUnhandledRejection", errMsg);
    };

    window.addEventListener("error", handleGlobalError);
    window.addEventListener("unhandledrejection", handleGlobalRejection);

    return () => {
      active = false;
      unsubscribe();
      unsubscribeLedger();
      window.removeEventListener("error", handleGlobalError);
      window.removeEventListener("unhandledrejection", handleGlobalRejection);
    };
  }, []);

  return {
    activeGroup,
    setActiveGroup,
    activeCategory,
    setActiveCategory,
    isLoading,
    saveToast,
    syncProgress,
    progressText,
    activeGroupsList,
    activeCategoriesList,
    ledgerItemsList
  };
}
