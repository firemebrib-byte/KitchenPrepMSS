/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 应用根组件与顶层外壳：负责登录/加载态分屏渲染、左侧受众分组侧边栏与顶部工具栏、以及备餐记账表格、台账系统、库存总览、管理后台等各功能模块的路由编排；核心数据加载与登录鉴权逻辑已分别抽取到 useAppData/useAppAuth 两个自定义 Hook 中。
 */

import { useEffect, useState, useMemo, lazy, Suspense } from "react";
import { FoodCategory } from "./types/types.ts";
import { TableGrid } from "./components/inventory/TableGrid.tsx";
import { LogBroker, computeLedgerDailyAmountsByGroup, computeLedgerHistoricalInAmount } from "./utils.ts";
import { ErrorBoundary } from "./components/shared/ErrorBoundary.tsx";
import { useAppAuth } from "./hooks/useAppAuth.ts";
import { useAppData } from "./hooks/useAppData.ts";
import { useRangeLoad } from "./hooks/useRangeLoad.ts";

const AdminBackend = lazy(() => import("./components/admin/AdminBackend.tsx").then(m => ({ default: m.AdminBackend })));
const LedgerSystem = lazy(() => import("./components/ledger/LedgerSystem.tsx").then(m => ({ default: m.LedgerSystem })));
const InventoryPanel = lazy(() => import("./components/inventory/InventoryPanel.tsx").then(m => ({ default: m.InventoryPanel })));
import {
  Settings,
  RefreshCw,
  ShieldAlert,
  LogOut,
  Lock,
  Menu,
  X,
  CalendarDays,
  Package,
  AlertTriangle
} from "lucide-react";

/**
 * @description 食堂备餐备料记账统计系统主入口组件
 */
export default function App() {
  // ================= 状态声明部分 =================

  /** 全局耗时等待锁定提示文本，若为 null 则不锁屏 */
  const [globalLoadingText, setGlobalLoadingText] = useState<string | null>(null);
  /** 全局 Loading 进度条百分比，若为 null 则不渲染进度条 */
  const [globalLoadingProgress, setGlobalLoadingProgress] = useState<number | null>(null);

  // 挂载全局 Loading 辅助器，使非 Context 组件、后台、台账均可秒级调用锁屏防呆并呈现进度条
  useEffect(() => {
    let progressTimer: any = null;

    (window as any).__setGlobalLoading = (text: string | null, showProgress: boolean = true) => {
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
      }

      setGlobalLoadingText(text);

      if (text && showProgress) {
        setGlobalLoadingProgress(0);
        let current = 0;
        progressTimer = setInterval(() => {
          current += Math.max(2, Math.floor((95 - current) / 6)); // 平滑趋近式加载
          setGlobalLoadingProgress(Math.min(95, current));
        }, 100);
      } else {
        setGlobalLoadingProgress(null);
      }
    };

    return () => {
      if (progressTimer) clearInterval(progressTimer);
      (window as any).__setGlobalLoading = undefined;
    };
  }, []);

  // 人群/大类配置、台账、原料字典三大服务的首屏加载与数据变动订阅逻辑，统一由 useAppData 提供
  const {
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
  } = useAppData();

  /** 移动端侧边栏开启状态 */
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false);
  /** 当前处于激活状态的台账ID（通过子组件冒泡获取，用于底部分类统计汇总） */
  const [appActiveLedgerId, setAppActiveLedgerId] = useState<string>("");

  // 首页登录态与管理员后台密码校验逻辑，统一由 useAppAuth 提供
  const {
    isLoggedIn,
    loginPasswordInput,
    setLoginPasswordInput,
    loginError,
    isAdminMode,
    setIsAdminMode,
    isPasswordModalOpen,
    setIsPasswordModalOpen,
    enteredPassword,
    setEnteredPassword,
    passwordError,
    handleLoginSubmit,
    handleLogout,
    handleAdminAccessAttempt,
    handleVerifyPasswordSubmit
  } = useAppAuth();

  // ================= 状态声明：全局日期范围 =================
  /** 全局当前选择进行数据同步的日期 (格式 YYYY-MM-DD，默认今天) */
  const [selectedDate, setSelectedDate] = useState<string>(() => {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  });

  const selectedYear = parseInt(selectedDate.split("-")[0], 10);
  const selectedMonth = parseInt(selectedDate.split("-")[1], 10);

  // ================= 按月懒加载触发器 (针对台账每日流水) =================
  // 切换查看账期时，向服务器补拉该月区间数据；期间 periodLoad.loading=true → 下方 <main> 内渲染阻断式遮罩，
  // 确保"拉取成功、数据加载完整"后用户才能继续操作；失败时遮罩保持并提供重试（见 useRangeLoad）。
  const periodStart = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}-01`;
  const periodEnd = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}-${new Date(selectedYear, selectedMonth, 0).getDate()}`;
  const periodLoad = useRangeLoad(periodStart, periodEnd, [selectedYear, selectedMonth]);

  /** 库存总览面板显示状态 */
  const [isInventoryOpen, setIsInventoryOpen] = useState<boolean>(false);

  /** 关怀模式：页面字号与按钮大小控制状态，支持 "normal" | "large" | "huge" */
  const [fontSizeMode, setFontSizeMode] = useState<"normal" | "large" | "huge">(() => {
    return (localStorage.getItem("KPMSS_FONT_SIZE_MODE") as any) || "normal";
  });

  // 动态同步 html 节点上的关怀大字模式类名
  useEffect(() => {
    localStorage.setItem("KPMSS_FONT_SIZE_MODE", fontSizeMode);
    const htmlEl = document.documentElement;
    htmlEl.classList.remove("theme-elder-large", "theme-elder-huge");
    if (fontSizeMode === "large") {
      htmlEl.classList.add("theme-elder-large");
    } else if (fontSizeMode === "huge") {
      htmlEl.classList.add("theme-elder-huge");
    }
  }, [fontSizeMode]);

  // ================= 2026-06-30 新增：餐位分组折叠状态 =================
  /** 活动餐位分组用户是否手动折叠（左侧侧边栏折叠状态） */
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(false);

  // ================= 动态配置计算属性 =================

  /**
   * @description 动态生成一级人群的中文显名映射字典，便于性能及状态归纳
   */
  const dynamicGroupLabels = useMemo(() => {
    const map: Record<string, string> = {};
    activeGroupsList.forEach((g) => {
      map[g.key] = g.label;
    });
    return map;
  }, [activeGroupsList]);

  /**
   * @description 动态生成品类分类的中文名映射字典
   */
  const dynamicCategoryLabels = useMemo(() => {
    const map: Record<string, string> = {};
    activeCategoriesList.forEach((c) => {
      map[c.key] = c.label;
    });
    return map;
  }, [activeCategoriesList]);



  // ================= 辅助指标运算 =================

  /**
   * @description 计算当前选择分组备餐全品类在全月的累积费用总支出。
   * 求和逻辑收敛到 computeLedgerDailyAmountsByGroup（见 utils.ts），只按当月实际天数累加、
   * 避免历史脏键污染合计；此处先取逐日金额再统一求和四舍五入一次，减少逐日四舍五入的累积误差。
   */
  const activeGroupReportTotal = useMemo(() => {
    if (activeGroup === "LEDGER") return 0;
    const dailyAmounts = computeLedgerDailyAmountsByGroup(ledgerItemsList, activeGroup, selectedYear, selectedMonth);
    const sum = Object.values(dailyAmounts).reduce((a, b) => a + b, 0);
    return Math.round(sum * 100) / 100;
  }, [activeGroup, selectedYear, selectedMonth, ledgerItemsList]);

  /**
   * @description 计算原料购销台账所有原料的累计入库总额 (全账期)。
   * 走服务端预聚合的 historicalTotalInAmount（见 utils.computeLedgerHistoricalInAmount），
   * 不再对内存里的 dailyRecords 求和——否则未提前切换过其它月份时，内存只有当月数据，
   * “全部”会退化成只等于“本月”。
   */
  const allLedgersTotalAmount = useMemo(() => {
    return computeLedgerHistoricalInAmount(ledgerItemsList, appActiveLedgerId);
  }, [ledgerItemsList, appActiveLedgerId]);

  /**
   * @description 计算原料购销台账所有原料在当前自然月内的累计入库总额
   */
  const currentMonthLedgersTotalAmount = useMemo(() => {
    const monthPrefix = `${selectedYear}-${String(selectedMonth).padStart(2, "0")}`;
    return ledgerItemsList.reduce((sum, item) => {
      if (item.ledgerId !== appActiveLedgerId) return sum;
      let itemSum = 0;
      Object.entries(item.dailyRecords || {}).forEach(([dateStr, record]: [string, any]) => {
        if (dateStr.startsWith(monthPrefix)) {
          itemSum += record.inAmount || 0;
        }
      });
      return sum + itemSum;
    }, 0);
  }, [ledgerItemsList, selectedYear, selectedMonth, appActiveLedgerId]);

  /** 侧边栏"台账原料累计入库"统计的展示范围：默认当前自然月，用户可手动切换为全部账期累计 */
  const [ledgerAmountScope, setLedgerAmountScope] = useState<"month" | "all">("month");

  // ================= 极速首屏并行数据服务同步加载进度屏 =================
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-slate-900 font-sans p-4 relative overflow-hidden">
        {/* 晶莹剔透的环境光背景装饰 */}
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none"></div>
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-teal-500/10 rounded-full blur-3xl pointer-events-none"></div>

        <div className="w-full max-w-sm bg-slate-950 rounded-2xl shadow-2xl border border-slate-800 p-8 space-y-6 relative z-10 text-center select-none">
          <div className="space-y-2">
            <div className="mx-auto w-12 h-12 bg-gradient-to-tr from-emerald-500 to-teal-500 rounded-xl flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <RefreshCw className="text-white animate-spin" size={22} />
            </div>
            <h2 className="text-lg font-black text-white tracking-wide pt-2">
              系统数据资源同步中
            </h2>
            <p className="text-[12px] text-slate-400">
              正在与服务器端并行同步月度备餐、购销台账及大字典底册...
            </p>
          </div>

          {/* 进度条轨道 */}
          <div className="space-y-2">
            <div className="w-full h-2.5 bg-slate-900 rounded-full overflow-hidden p-0.5 border border-slate-800">
              <div
                className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-300 shadow-sm"
                style={{ width: `${syncProgress}%` }}
              ></div>
            </div>
            <div className="flex justify-between items-center text-[11px] text-slate-400 font-bold px-0.5">
              <span>{progressText}</span>
              <span className="text-emerald-400">{syncProgress}%</span>
            </div>
          </div>

          <span className="text-[10px] text-slate-500 font-medium block">
            系统正与云端服务建立一致性连接，装载完成后自动解锁
          </span>
        </div>
      </div>
    );
  }

  // ================= 首页系统安全验证屏 =================
  if (!isLoggedIn) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-slate-900 font-sans p-4 relative overflow-hidden">
        {/* 晶莹剔透的环境光背景装饰，增加美学科技质感 */}
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none"></div>
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-teal-500/10 rounded-full blur-3xl pointer-events-none"></div>

        <div className="w-full max-w-md bg-slate-950 rounded-2xl shadow-2xl border border-slate-800 p-8 space-y-6 relative z-10 animate-fade-in">
          {/* Logo 与顶条 */}
          <div className="text-center space-y-2">
            <div className="mx-auto w-12 h-12 bg-gradient-to-tr from-emerald-500 to-teal-500 rounded-xl flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Lock className="text-white" size={24} />
            </div>
            <h2 className="text-xl font-black text-white tracking-tight pt-2">
              食堂用餐服务管理系统
            </h2>
            <p className="text-[13px] text-slate-400">
              智能高效的日度矩阵记账及膳食营养辅助决策面板
            </p>
          </div>

          {/* 表单 */}
          <form onSubmit={handleLoginSubmit} className="space-y-4 pt-2">
            {loginError && (
              <div className="text-[13px] bg-rose-950/40 text-rose-400 p-3 rounded-lg border border-rose-900/60 flex items-center space-x-2 animate-pulse">
                <ShieldAlert size={14} className="shrink-0" />
                <span>{loginError}</span>
              </div>
            )}

            <div className="space-y-2">
              <label className="text-[11px] font-bold text-slate-400 block uppercase tracking-widest">
                系统登录密码 (存储于 .env 安全配置)
              </label>
              <input
                type="password"
                placeholder="请输入系统首页访问密码"
                value={loginPasswordInput}
                onChange={(e) => setLoginPasswordInput(e.target.value)}
                className="w-full bg-slate-900 text-[15px] text-slate-100 p-3 border border-slate-800 rounded-lg focus:border-emerald-500 outline-none transition-all focus:bg-slate-900/80 placeholder-slate-500"
                autoFocus
                required
              />
            </div>

            <button
              type="submit"
              className="w-full py-3 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-emerald-500 text-white font-bold text-[15px] rounded-lg cursor-pointer transition-all shadow-lg hover:shadow-emerald-500/10 hover:scale-[1.01] flex items-center justify-center space-x-1.5"
            >
              <span>安全解锁进入</span>
            </button>
          </form>

          {/* 安全提示信息 */}
          <div className="pt-4 border-t border-slate-900 text-center">
            <span className="text-[12px] text-slate-500">
              管理员建议：默认首页登录口令为 <code className="bg-slate-900 text-emerald-400 px-1.5 py-0.5 rounded font-mono font-bold">guest</code>
            </span>
          </div>
        </div>
      </div>
    );
  }

  // ================= 管理行政后台隔离屏渲染 =================
  if (isAdminMode) {
    return (
      <Suspense fallback={
        <div className="flex h-screen w-full bg-slate-900 text-slate-100 flex-col items-center justify-center space-y-4">
          <RefreshCw className="animate-spin text-emerald-400" size={24} />
          <span className="text-[13px]">系统安全审计后台加载中，请稍候...</span>
        </div>
      }>
        <ErrorBoundary fallbackTitle="管理行政后台运行异常">
          <AdminBackend
            activeCategoriesList={activeCategoriesList}
            onClose={() => setIsAdminMode(false)}
          />
        </ErrorBoundary>
      </Suspense>
    );
  }

  // ================= 前台报表交互展示屏 =================
  return (
    <div className={`flex flex-col h-screen w-full bg-[#f1f5f9] text-slate-800 font-sans select-none overflow-hidden ${
      fontSizeMode === "large" ? "theme-elder-large" : fontSizeMode === "huge" ? "theme-elder-huge" : ""
    }`}>

      {/* 顶部主横幅控制中心 (符合高密度设计风格 Deep Slate Colors) */}
      <header className="flex items-center justify-between px-3 sm:px-6 py-2 sm:py-2.5 bg-slate-900 text-white border-b border-slate-700 shrink-0 relative z-50">
        <div className="flex items-center space-x-2 sm:space-x-4 min-w-0">
          {/* 汉堡包按钮 (在 lg 以下显示) */}
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="lg:hidden p-1.5 hover:bg-slate-800 rounded text-slate-300 cursor-pointer transition-colors"
            title="展开/收起侧边栏"
          >
            {isSidebarOpen ? <X size={18} /> : <Menu size={18} />}
          </button>

          <div className="w-7 h-7 sm:w-8 sm:h-8 bg-emerald-500 rounded flex items-center justify-center font-extrabold text-lg sm:text-xl text-white shrink-0">K</div>
          <h1 className="text-[13px] sm:text-[15px] md:text-lg lg:text-xl font-semibold tracking-tight truncate">
            食堂用餐服务管理系统 <span className="hidden md:inline text-slate-400 font-normal text-[13px] sm:text-[15px] ml-2">v2.5</span>
          </h1>
        </div>

        <div className="flex items-center space-x-1.5 sm:space-x-3 shrink-0">

          {/* 自动保存状态展示器 */}
          {saveToast && (
            <span className="text-[10px] sm:text-[11px] bg-emerald-500/20 text-emerald-200 px-1.5 py-0.5 sm:px-2.5 sm:py-1 rounded border border-emerald-500/40 animate-fade-in font-medium font-sans shrink-0">
              {saveToast}
            </span>
          )}

          {/* 关怀模式字号调节 */}
          <div className="flex items-center bg-slate-800 border border-slate-700 rounded-lg p-0.5 text-slate-300 font-bold shrink-0 select-none">
            <span className="hidden sm:inline text-[10px] sm:text-[11px] px-1.5 text-slate-400 font-bold">字号</span>
            <button
              onClick={() => setFontSizeMode("normal")}
              className={`px-1.5 py-0.5 rounded text-[10px] sm:text-[11px] transition-all cursor-pointer ${
                fontSizeMode === "normal" ? "bg-emerald-600 text-white font-black" : "hover:text-white"
              }`}
              title="系统标准字号"
            >
              标准
            </button>
            <button
              onClick={() => setFontSizeMode("large")}
              className={`px-1.5 py-0.5 rounded text-[10px] sm:text-[11px] transition-all cursor-pointer ${
                fontSizeMode === "large" ? "bg-emerald-600 text-white font-black" : "hover:text-white"
              }`}
              title="中大字号关怀模式，适合视力欠佳用户"
            >
              大
            </button>
            <button
              onClick={() => setFontSizeMode("huge")}
              className={`px-1.5 py-0.5 rounded text-[10px] sm:text-[11px] transition-all cursor-pointer ${
                fontSizeMode === "huge" ? "bg-emerald-600 text-white font-black" : "hover:text-white"
              }`}
              title="特大字号关怀模式，适合中老年用户"
            >
              超大
            </button>
          </div>

          {/* 分组分隔线 */}
          <div className="hidden sm:block w-px h-5 bg-slate-700 shrink-0" />

          {/* 功能入口：库存总览 + 管理后台 */}
          <div className="flex items-center space-x-1.5 sm:space-x-2 shrink-0">
            <button
              onClick={() => setIsInventoryOpen(true)}
              className="flex items-center gap-1 px-2 py-1 sm:px-3 sm:py-1.5 bg-slate-700 hover:bg-emerald-700 border border-slate-600 hover:border-emerald-500 font-bold text-[11px] sm:text-[13px] text-slate-200 hover:text-white rounded cursor-pointer transition-all shadow-sm"
              title="查看全部原料库存总览"
            >
              <Package size={11} />
              <span className="hidden sm:inline">库存总览</span>
            </button>

            <button
              onClick={handleAdminAccessAttempt}
              className="flex items-center gap-1 px-2 py-1 sm:px-3.5 sm:py-1.5 bg-gradient-to-r from-teal-600 to-emerald-600 hover:from-teal-500 hover:to-emerald-500 font-bold text-[11px] sm:text-[13px] text-white rounded cursor-pointer transition-all shadow-sm hover:shadow"
              title="进入管理后台"
            >
              <Settings size={11} className="animate-spin-slow" />
              <span><span className="hidden sm:inline">进入</span>管理后台</span>
            </button>
          </div>

          {/* 分组分隔线 */}
          <div className="hidden sm:block w-px h-5 bg-slate-700 shrink-0" />

          {/* 会话控制：安全登出 */}
          <button
            onClick={handleLogout}
            className="flex items-center gap-1 px-2 py-1 sm:px-3 sm:py-1.5 bg-slate-800 hover:bg-rose-950/80 border border-slate-700 hover:border-rose-900/60 font-bold text-[11px] sm:text-[13px] text-slate-300 hover:rose-200 rounded cursor-pointer transition-all shadow-sm"
            title="安全退出当前食堂记账系统并锁定首页面"
          >
            <LogOut size={11} />
            <span className="hidden md:inline">安全登出</span>
          </button>
        </div>
      </header>

      {/* 主面板内容区 (遵循高密双分 Aside + Main 左右骨架排布布局) */}
      <div className="flex flex-1 overflow-hidden relative">

        {/* 移动端侧边栏遮罩层 */}
        {isSidebarOpen && (
          <div
            className="lg:hidden fixed inset-0 bg-slate-950/50 backdrop-blur-xs z-30 transition-opacity duration-300"
            onClick={() => setIsSidebarOpen(false)}
          />
        )}

        {/* 左侧侧边栏 Sidebar: 受众人群分组与多维分析决策顶级菜单栏 */}
        <aside className={`
          bg-white border-r border-slate-200 flex flex-col shrink-0 justify-between
          transition-all duration-300 ease-in-out
          fixed lg:static inset-y-0 left-0 z-40 h-full lg:h-auto
          ${isSidebarCollapsed ? "w-14" : "w-52"}
          ${isSidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
        `}>
          <div className="flex flex-col flex-1 min-h-0 font-sans">
            <div className="p-3 border-b border-slate-100 flex items-center justify-between overflow-hidden">
              {!isSidebarCollapsed && (
                <>
                  <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest font-sans truncate">活动餐位分组</span>
                  <span className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-mono font-extrabold shrink-0">{activeGroupsList.length}群</span>
                </>
              )}
              <button
                onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-slate-600 transition-colors mx-auto cursor-pointer font-bold"
                title={isSidebarCollapsed ? "展开" : "折叠"}
              >
                {isSidebarCollapsed ? "▶" : "◀"}
              </button>
            </div>

            <nav className="flex-1 py-2 space-y-0.5 overflow-y-auto scrollbar-thin flex flex-col">
              <div className="flex-1">
                {activeGroupsList.map((g) => {
                  const isSelected = activeGroup === g.key;
                  return (
                    <button
                      key={g.key}
                      onClick={() => {
                        setActiveGroup(g.key);
                        setIsSidebarOpen(false); // 点击后折叠侧边栏
                        LogBroker.publish("INFO", "App", `切换聚焦食堂受众人群: ${g.label}`);
                      }}
                      title={g.label}
                      className={`w-full flex items-center px-4 py-2.5 text-[13px] font-semibold cursor-pointer transition-all ${isSelected
                        ? "bg-emerald-50 border-r-4 border-emerald-500 text-emerald-700 font-bold"
                        : "text-slate-600 hover:bg-slate-50 border-r-4 border-transparent"
                        } ${isSidebarCollapsed ? "justify-center" : ""}`}
                    >
                      <span className={`${isSidebarCollapsed ? "mr-0" : "mr-3"} text-lg`}>{g.emoji}</span>
                      {!isSidebarCollapsed && <span>{g.label}</span>}
                    </button>
                  );
                })}
              </div>

              {/* 原多维分析决策已转移至各受众视图底部的辅助工具中 */}
              <div className="border-t border-slate-100 pt-2 mt-auto space-y-1">

                <div>
                  {!isSidebarCollapsed && (
                    <div className="px-4 py-1 text-[11px] font-bold text-slate-400 uppercase tracking-widest truncate">
                      仓库与库存台账
                    </div>
                  )}
                  <button
                    onClick={() => {
                      setActiveGroup("LEDGER");
                      setIsSidebarOpen(false); // 点击后折叠侧边栏
                      LogBroker.publish("INFO", "App", "激活原料购销台账及仓储库存模块。");
                    }}
                    title="原料购销台账"
                    className={`w-full flex items-center px-4 py-2.5 text-[13px] font-bold cursor-pointer transition-all ${activeGroup === "LEDGER"
                      ? "bg-emerald-50 border-r-4 border-emerald-500 text-emerald-700 font-black"
                      : "text-slate-600 hover:bg-slate-50 border-r-4 border-transparent"
                      } ${isSidebarCollapsed ? "justify-center" : ""}`}
                  >
                    <span className={`${isSidebarCollapsed ? "mr-0" : "mr-3"} text-lg`}>📋</span>
                    {!isSidebarCollapsed && <span>原料购销台账</span>}
                  </button>
                </div>
              </div>
            </nav>
          </div>

          {/* 备餐底栏：实时滚动费用指示牌 */}
          <div className="p-3 border-t border-slate-100">
            <div className="bg-slate-50 rounded-lg p-2.5 border border-slate-100">
              {!isSidebarCollapsed ? (
                <>
                  <div className="flex items-center justify-between gap-1.5 mb-1">
                    <span className="text-[11px] text-slate-500 font-bold font-sans truncate">
                      {activeGroup === "LEDGER"
                        ? (ledgerAmountScope === "month" ? "台账原料本月累计入库" : "台账原料累计入库(全部)")
                        : "当前受众全月采购支出"}
                    </span>
                    {activeGroup === "LEDGER" && (
                      <div className="flex items-center bg-slate-200/70 rounded p-0.5 shrink-0">
                        <button
                          onClick={() => setLedgerAmountScope("month")}
                          className={`px-1.5 py-0.5 rounded text-[10px] font-bold cursor-pointer transition-all ${
                            ledgerAmountScope === "month" ? "bg-white text-emerald-700 shadow-xs" : "text-slate-500 hover:text-slate-700"
                          }`}
                          title="仅统计当前自然月的累计入库"
                        >
                          本月
                        </button>
                        <button
                          onClick={() => setLedgerAmountScope("all")}
                          className={`px-1.5 py-0.5 rounded text-[10px] font-bold cursor-pointer transition-all ${
                            ledgerAmountScope === "all" ? "bg-white text-emerald-700 shadow-xs" : "text-slate-500 hover:text-slate-700"
                          }`}
                          title="统计全部账期的累计入库"
                        >
                          全部
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="text-lg font-extrabold text-slate-900 font-mono tracking-tight truncate">
                    ¥{(activeGroup === "LEDGER"
                      ? (ledgerAmountScope === "month" ? currentMonthLedgersTotalAmount : allLedgersTotalAmount)
                      : activeGroupReportTotal).toLocaleString("zh-CN", { minimumFractionDigits: 2 })}
                  </div>
                </>
              ) : (
                <div className="text-center font-bold text-slate-500 text-[13px]" title="支出">
                  ¥
                </div>
              )}
            </div>
          </div>
        </aside>

        {/* 核心右侧工作记账盘与二级品类选项页签 */}
        <main className="flex-1 flex flex-col min-w-0 bg-[#f8fafc] relative">
          {/* 切换查看账期时的阻断式加载遮罩：拉取成功前覆盖整个工作区并拦截点击，确保用户不会对着不完整的数据操作 */}
          {(periodLoad.loading || periodLoad.error) && (
            <div className="absolute inset-0 z-40 bg-white/75 backdrop-blur-[1.5px] flex flex-col items-center justify-center gap-3 select-none cursor-wait animate-fade-in">
              {periodLoad.error ? (
                <>
                  <AlertTriangle className="text-amber-500" size={28} />
                  <div className="text-[13px] font-bold text-slate-700 max-w-xs text-center px-4">{periodLoad.error}</div>
                  <button
                    onClick={periodLoad.retry}
                    className="mt-1 inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-[12px] font-bold px-4 py-1.5 rounded-lg shadow-sm transition-colors cursor-pointer"
                  >
                    <RefreshCw size={13} />
                    重新加载
                  </button>
                </>
              ) : (
                <>
                  <RefreshCw className="animate-spin text-emerald-500" size={26} />
                  <div className="text-[13px] font-semibold text-slate-600">
                    正在加载 {selectedYear} 年 {selectedMonth} 月账期数据…
                  </div>
                  <div className="text-[11px] text-slate-400">加载完成前请勿操作，以免数据不完整</div>
                </>
              )}
            </div>
          )}
          {activeGroup === "LEDGER" ? (
            <Suspense fallback={
              <div className="flex-1 flex flex-col items-center justify-center space-y-4 p-12 text-slate-500 bg-white m-6 rounded-xl border border-slate-200 shadow-sm">
                <RefreshCw className="animate-spin text-emerald-500" size={24} />
                <span className="text-[13px]">台账购销及库存控制模块加载中，请稍候...</span>
              </div>
            }>
              <ErrorBoundary fallbackTitle="台账系统模块运行异常">
                <LedgerSystem 
                  onActiveLedgerChange={setAppActiveLedgerId}
                  selectedDate={selectedDate}
                  onDateChange={setSelectedDate}
                />
              </ErrorBoundary>
            </Suspense>
          ) : (
            <>
              <div className="flex items-center px-4 bg-white border-b border-slate-200 justify-between shrink-0 h-12">
                <div className="flex items-center space-x-1 overflow-x-auto h-full scrollbar-none">
                  {activeCategoriesList.map((cat) => {
                    const isSelected = activeCategory === cat.key;
                    return (
                      <button
                        key={cat.key}
                        onClick={() => {
                          setActiveCategory(cat.key);
                          LogBroker.publish("INFO", "App", `切换食材主分类大类: ${cat.label}类`);
                        }}
                        className={`px-4 py-2 text-[13px] font-bold border-b-2 transition-all cursor-pointer h-full flex items-center whitespace-nowrap ${isSelected
                          ? "border-emerald-500 text-emerald-600 font-extrabold"
                          : "border-transparent text-slate-400 hover:text-slate-600"
                          }`}
                      >
                        {cat.label}品类
                      </button>
                    );
                  })}

                  <div className="h-4 w-[1px] bg-slate-200 mx-2 shrink-0" />

                  <button
                    onClick={() => {
                      setActiveCategory(null);
                      LogBroker.publish("INFO", "App", "激活宏观视图:「全品类预算/记账金额汇总报表」。");
                    }}
                    className={`px-5 py-2 text-[13px] font-bold transition-all relative shrink-0 border-b-2 cursor-pointer h-full flex items-center ${activeCategory === null
                      ? "border-emerald-600 text-emerald-700 font-extrabold"
                      : "border-transparent text-slate-400 hover:text-slate-600"
                      }`}
                  >
                    合计汇总表
                  </button>
                </div>

                {/* 账期选择器 */}
                {activeGroup !== "LEDGER" && (
                  <div className="flex items-center space-x-2 shrink-0 ml-4">
                    <span className="text-[13px] font-semibold text-slate-500 flex items-center gap-1 animate-fade-in">
                      <CalendarDays size={14} className="text-slate-400" />
                      查看账期:
                    </span>
                    <input
                      type="month"
                      value={`${selectedYear}-${String(selectedMonth).padStart(2, "0")}`}
                      onChange={(e) => {
                      const val = e.target.value;
                      if (val) {
                        const [y, m] = val.split("-");
                        const currentDay = selectedDate.split("-")[2];
                        const daysInNewMonth = new Date(parseInt(y, 10), parseInt(m, 10), 0).getDate();
                        const validDay = Math.min(parseInt(currentDay, 10), daysInNewMonth);
                        const newDate = `${y}-${m}-${String(validDay).padStart(2, "0")}`;
                        setSelectedDate(newDate);
                        LogBroker.publish("INFO", "App", `全局报表时间切换为: ${y}年${m}月`);
                      }
                    }}
                      className="bg-slate-50 border border-slate-200 hover:border-slate-300 rounded px-2.5 py-1 text-[13px] font-bold text-slate-700 outline-none cursor-pointer focus:bg-white focus:border-emerald-500 transition-all"
                    />
                  </div>
                )}
              </div>

              {/* 报表卡片容器（已根据指示，将进程日志等剥离到管理配置后台） */}
              <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-thin">

                {activeGroup !== "LEDGER" && (
                  <TableGrid
                    targetGroup={activeGroup}
                    year={selectedYear}
                    month={selectedMonth}
                    selectedCategory={activeCategory as FoodCategory | null}
                    activeGroupsList={activeGroupsList}
                    activeCategoriesList={activeCategoriesList}
                    ledgerItemsList={ledgerItemsList}
                  />
                )}

              </div>
            </>
          )}
        </main>
      </div>

      {/* 各项备餐审计说明页脚：仅在备餐记账视图下展示当前查看的分组/品类，台账等其他模块无对应上下文时不展示 */}
      {activeGroup !== "LEDGER" && (
        <footer className="px-6 py-2 bg-white border-t border-slate-200 flex items-center shrink-0 text-[11px] text-slate-500 select-none font-sans">
          <div className="flex items-center">
            <span className="font-bold text-slate-700 mr-2">当前查看：</span>
            <span>{`${dynamicGroupLabels[activeGroup]} · ${activeCategory ? dynamicCategoryLabels[activeCategory] : "合计汇总"}`}</span>
          </div>
        </footer>
      )}

      {/* 🔐 管理后台行政口令校验遮罩层 */}
      {isPasswordModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 animate-fade-in">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-sm w-full mx-4 overflow-hidden">
            {/* 顶条 */}
            <div className="bg-slate-900 text-slate-100 px-5 py-4 flex items-center space-x-2.5">
              <ShieldAlert className="text-emerald-400 shrink-0" size={18} />
              <h3 className="text-[15px] font-extrabold tracking-tight">行政管理授权认证</h3>
            </div>

            {/* 表单 */}
            <form onSubmit={handleVerifyPasswordSubmit} className="p-5 space-y-4">
              <p className="text-[13px] text-slate-500 leading-relaxed">
                进入配置后台可进行一级餐位客群、二级食材大类的管理，以及执行一键清空、备份和初始化。请输入安全验证密码以继续。
              </p>

              {passwordError && (
                <div className="text-[12px] bg-rose-50 text-rose-600 p-2.5 rounded border border-rose-100 flex items-center space-x-1.5">
                  <ShieldAlert size={12} className="shrink-0 animate-bounce" />
                  <span>{passwordError}</span>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-slate-500 block uppercase tracking-wider">
                  授权管理密码 (默认密码: admin)
                </label>
                <input
                  type="password"
                  placeholder="请输入后台管理员密码"
                  value={enteredPassword}
                  onChange={(e) => setEnteredPassword(e.target.value)}
                  className="w-full bg-slate-50 text-[13px] text-slate-800 p-2.5 border border-slate-300 rounded focus:border-emerald-500 outline-none transition-all focus:bg-white"
                  autoComplete="new-password"
                  autoFocus
                  required
                />
              </div>

              <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsPasswordModalOpen(false)}
                  className="px-3.5 py-1.5 bg-white border border-slate-200 hover:border-slate-300 text-slate-600 rounded text-[13px] font-semibold cursor-pointer transition-all"
                >
                  取消返回
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-[13px] font-bold cursor-pointer transition-all shadow-sm"
                >
                  校验进入
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 库存总览模态面板 */}
      {isInventoryOpen && (
        <Suspense fallback={
          <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center">
            <div className="bg-white rounded-xl p-8 max-w-sm w-full mx-4 shadow-xl text-center space-y-3">
              <RefreshCw className="animate-spin text-emerald-500 mx-auto" size={24} />
              <p className="text-[13px] text-slate-500">库存自检总盘数据加载中...</p>
            </div>
          </div>
        }>
          <ErrorBoundary fallbackTitle="库存盘点中心运行异常">
            <InventoryPanel onClose={() => setIsInventoryOpen(false)} />
          </ErrorBoundary>
        </Suspense>
      )}

      {/* 全局锁定遮罩，防止耗时异步期间用户多重误触操作 */}
      {globalLoadingText && (
        <div className="fixed inset-0 z-[9999] bg-slate-900/60 backdrop-blur-md flex flex-col items-center justify-center space-y-4 select-none cursor-wait">
          <div className="bg-white/95 border border-slate-200/50 p-8 rounded-2xl max-w-sm w-full mx-4 shadow-2xl flex flex-col items-center space-y-4">
            <div className="relative flex items-center justify-center">
              <div className="w-12 h-12 border-4 border-emerald-100 border-t-emerald-600 rounded-full animate-spin"></div>
              <span className="absolute text-[11px] font-black text-emerald-700 animate-pulse">KPMSS</span>
            </div>

            <div className="w-full space-y-2">
              <p className="text-[13px] font-black text-slate-800 tracking-wider text-center">{globalLoadingText}</p>

              {/* 如果开启了进度模拟，则在遮罩上渲染进度条 */}
              {globalLoadingProgress !== null && (
                <div className="space-y-1.5 pt-1">
                  <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden p-0.5 border border-slate-200">
                    <div
                      className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-150"
                      style={{ width: `${globalLoadingProgress}%` }}
                    ></div>
                  </div>
                  <div className="flex justify-between items-center text-[10px] text-slate-400 font-bold px-0.5">
                    <span>数据落盘同步进度</span>
                    <span className="text-emerald-600">{globalLoadingProgress}%</span>
                  </div>
                </div>
              )}
            </div>

            <span className="text-[10px] text-slate-400 font-medium text-center block">系统正在同步，此期间已安全锁定，请勿刷新页面</span>
          </div>
        </div>
      )}
    </div>
  );
}
