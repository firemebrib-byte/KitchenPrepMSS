/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 备餐采购细表的编排层组件：按选定二级大类过滤并与台账入库数据对齐生成明细行，提供搜索、CSV 导出、主题切换、"合计汇总"视图，并根据 viewMode 渲染 EXCEL 日历总矩阵（TableGridMatrixView）或单日聚焦卡片（TableGridFocusView）子组件。
 */

import React, { useState, useMemo } from "react";
import { FoodCategory, DynamicGroup, DynamicCategory } from "../../types/types.ts";
import { PrepReportService } from "../../services/store.ts";
import { UI_TEXT, resolveLedgerItemCategory, UNCATEGORIZED_CATEGORY_KEY, UNCATEGORIZED_CATEGORY_LABEL } from "../../constants/constants.ts";
import { getDaysInMonth, LogBroker, matchPinyin, convertItemsToCsv, computeLedgerDailyAmountsByGroup } from "../../utils.ts";
import { Grid, Search, CalendarDays, Check, Flame, Download, TrendingUp } from "lucide-react";
import { SearchableSelect } from "../shared/SearchableSelect.tsx";
import { RawMaterialsDictService } from "../../services/rawMaterialDict.ts";
import { LedgerService } from "../../services/ledgerStore.ts";
import { useTableTheme } from "../../hooks/useTableTheme.ts";
import { TableGridMatrixView } from "./TableGridMatrixView.tsx";
import { TableGridFocusView } from "./TableGridFocusView.tsx";
import { MonthlySpendingChart } from "./MonthlySpendingChart.tsx";

/**
 * @description 备餐网格组件的输入参数协议
 */
interface TableGridProps {
  /** 当前选定聚焦的台账人群 ID */
  targetGroup: string;
  year: number;
  month: number;
  /** 当前激活的食材二级分类 (VEGETABLE | GRAIN_OIL... ；合计子表用 null 表示) */
  selectedCategory: FoodCategory | null;
  /** 激活的一级受众人群列表 */
  activeGroupsList: DynamicGroup[];
  /** 激活的二级食材分类列表 */
  activeCategoriesList: DynamicCategory[];
  /** 所有的购销台账物品列表 */
  ledgerItemsList: any[];
}

/**
 * @description 多功能食堂电子备料表格与汇总合计组件
 */
export const TableGrid: React.FC<TableGridProps> = ({
  targetGroup,
  year,
  month,
  selectedCategory,
  activeGroupsList,
  activeCategoriesList,
  ledgerItemsList
}) => {
  // 1. 核心视图布局模式切换：MATRIX (大宽表Excel矩阵) | FOCUS (单日卡片聚焦)
  const [viewMode, setViewMode] = useState<"MATRIX" | "FOCUS">("MATRIX");

  // 主题样式管理，统一由 useTableTheme 提供
  const { theme, activeTheme, handleThemeChange } = useTableTheme();

  // 新旧样式切换开关
  const [useNewStyle, setUseNewStyle] = useState<boolean>(true);

  // 聚焦日的索引状态，默认聚焦 1 号
  const [focusDay, setFocusDay] = useState<string>("1");

  // 当前受众+当前品类的当月采购花销趋势图显示开关，默认隐藏，由用户手动点击按钮展开
  const [showSpendingChart, setShowSpendingChart] = useState<boolean>(false);

  // 食材搜索关键字
  const [searchQuery, setSearchQuery] = useState<string>("");

  // 当月包含的日期数组 (["1", "2", ..., "31"])
  const days = useMemo(() => getDaysInMonth(year, month), [year, month]);

  // 1. 过滤与台账每日采购明细无缝对齐：按选定主类和搜索关键字过滤条目，并将 dailyData 数据完全拦截重定向至对应台账采购数量与单价上
  // 说明(R7)：本 memo 里 resolveLedgerItemCategory 会调 RawMaterialsDictService.getItems() 但字典不在依赖数组里，
  //   理论上存在陈旧闭包。字典与台账解耦(R1)后，分类以 item.category 快照为主、字典只是 null 项的兜底，回填后几乎不触发；
  //   且字典任何增删改都会经 refreshNow 改到 ledgerItemsList（在依赖里）从而重算。留待需要时再引入字典版本号做精确依赖。
  const filteredItems = useMemo(() => {
    // 拉取台账所有原料项目
    const allLedgerItems = ledgerItemsList;

    // 找出与当前备餐报表所属客群（targetGroup）相匹配的台账集合
    const groupLedgerItems = allLedgerItems.filter((i) => i.ledgerId === targetGroup);

    return groupLedgerItems
      .filter((item) => {
        // [字典与台账解耦] 分类走 item.category 快照，缺失回退字典、再缺失归“未分类”——不再因“字典里查不到”而丢行。
        const cat = resolveLedgerItemCategory(item, (n) => RawMaterialsDictService.getCategoryForMaterial(n));
        const matchCat = selectedCategory === null ? true : cat === selectedCategory;
        const matchSearch = matchPinyin(item.name, searchQuery);
        return matchCat && matchSearch;
      })
      .map((item) => {
        // 构造克隆条目，重定向其每日数据为台账当日入库数据
        const alignedDailyData: Record<string, any> = {};

        days.forEach((day) => {
          // 台账的日期索引是 YYYY-MM-DD
          const monthStr = String(month).padStart(2, "0");
          const dayStr = String(day).padStart(2, "0");
          const targetDateKey = `${year}-${monthStr}-${dayStr}`;

          const ledgerRecord = item.dailyRecords?.[targetDateKey];

          if (ledgerRecord && ledgerRecord.inQuantity > 0) {
            alignedDailyData[day] = {
              quantity: ledgerRecord.inQuantity,
              price: ledgerRecord.inPrice,
              amount: Number((ledgerRecord.inQuantity * ledgerRecord.inPrice).toFixed(2))
            };
          } else {
            // 台账内某日采购无对应记录，则细表中不对应显示任何值，置为 0
            alignedDailyData[day] = { quantity: 0, price: 0, amount: 0 };
          }
        });

        // 返回由台账映射而成的标准备餐明细项
        return {
          id: item.id,
          name: item.name,
          category: resolveLedgerItemCategory(item, (n) => RawMaterialsDictService.getCategoryForMaterial(n)),
          targetGroup: targetGroup,
          unit: item.unit,
          dailyData: alignedDailyData
        };
      });
  }, [targetGroup, year, month, selectedCategory, searchQuery, days, ledgerItemsList, activeCategoriesList]);

  // 2. 统计计算：每个日期(1-31号)在该类目下的总开销汇总
  const dayTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    days.forEach((day) => {
      let sum = 0;
      filteredItems.forEach((item) => {
        sum += item.dailyData[day]?.amount || 0;
      });
      totals[day] = Math.round(sum * 100) / 100;
    });
    return totals;
  }, [filteredItems, days]);

  // 3. 合计汇总表专用：不受品类/搜索过滤影响，统计每日全品类汇总金额。求和逻辑收敛到
  // computeLedgerDailyAmountsByGroup（见 utils.ts），此处逐日展示故仍在此对每日金额分别四舍五入
  const summaryDailyTotals = useMemo(() => {
    const dailyAmounts = computeLedgerDailyAmountsByGroup(ledgerItemsList, targetGroup, year, month);
    const totals: Record<string, number> = {};
    Object.entries(dailyAmounts).forEach(([day, sum]) => {
      totals[day] = Math.round(sum * 100) / 100;
    });
    return totals;
  }, [targetGroup, year, month, days, ledgerItemsList]);

  const getGroupLabel = (groupKey: string) => {
    const g = activeGroupsList.find((g) => g.key === groupKey);
    return g ? g.label : groupKey;
  };

  const getCategoryLabel = (catKey: string) => {
    const c = activeCategoriesList.find((c) => c.key === catKey);
    return c ? c.label : catKey;
  };

  /**
   * @description 导出当前餐位二级分组在当月的采购明细表
   */
  const handleExportCsv = () => {
    const catLabel = selectedCategory ? getCategoryLabel(selectedCategory) : "汇总合计";
    const groupLabel = getGroupLabel(targetGroup);

    // 生成 CSV 内容
    const csvString = convertItemsToCsv(filteredItems, days, catLabel);

    // 创建 blob 并下载
    const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `${year}年${month}月_${groupLabel}_${catLabel}_采购细表.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    LogBroker.publish(
      "INFO",
      "TableGrid",
      `【导出明细】操作员导出了「${groupLabel}」的 [${catLabel}类] 在 ${year}年${month}月 的采购细表 CSV。`
    );
  };




  // --- 合计汇总报表视图渲染 (当 selectedCategory === null 时触发) ---
  const renderCategoryCombinedSummary = () => {
    const allLedgerItems = ledgerItemsList;
    const groupLedgerItems = allLedgerItems.filter((i) => i.ledgerId === targetGroup);

    // [字典与台账解耦] 按 item.category 快照把本月每笔入库金额归到大类；查不到分类的归“未分类”桶，
    // 保证合计汇总不会因为某原料脱离字典而漏计。
    const amountByCat: Record<string, number> = {};
    groupLedgerItems.forEach((item) => {
      const catKey = resolveLedgerItemCategory(item, (n) => RawMaterialsDictService.getCategoryForMaterial(n));
      days.forEach((day) => {
        const targetDateKey = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const record = item.dailyRecords?.[targetDateKey];
        if (record) {
          amountByCat[catKey] = (amountByCat[catKey] || 0) + (record.inAmount || 0);
        }
      });
    });

    const categoryRows = PrepReportService.getActiveCategories().map((cat) => ({
      key: cat.key,
      label: cat.label,
      amount: Math.round((amountByCat[cat.key] || 0) * 100) / 100
    }));
    // 只有当真有未归类的采购金额时，才补一行“未分类”
    if ((amountByCat[UNCATEGORIZED_CATEGORY_KEY] || 0) > 0) {
      categoryRows.push({
        key: UNCATEGORIZED_CATEGORY_KEY,
        label: UNCATEGORIZED_CATEGORY_LABEL,
        amount: Math.round(amountByCat[UNCATEGORIZED_CATEGORY_KEY] * 100) / 100
      });
    }

    const grandTotal = categoryRows.reduce((sum, r) => sum + r.amount, 0);

    return (
      <div className="bg-white rounded-2xl p-6 border border-gray-100 shadow-xs mt-4">
        <div className="flex items-center justify-between mb-6 pb-4 border-b border-gray-100">
          <div>
            <h3 className="font-bold text-gray-800 text-xl flex items-center gap-2">
              <span className="p-1.5 bg-indigo-50 text-indigo-600 rounded-lg"><Flame size={18} /></span>
              {UI_TEXT.summaryName}
            </h3>
            <p className="text-[13px] text-gray-400 mt-1">汇聚餐段：{year}年{month}月 - 统一统筹合计表</p>
          </div>
          <span className="text-[15px] font-semibold text-indigo-700 bg-indigo-50 px-4 py-1.5 rounded-full">
            总预算耗资: ¥{grandTotal.toLocaleString()}
          </span>
        </div>

        {/* 全月备餐开支日耗曲线：还原此前被整体移除的"日开支走势"功能的图表样式 */}
        <div className="mb-4">
          <MonthlySpendingChart
            days={days}
            dayTotals={summaryDailyTotals}
            groupLabel={getGroupLabel(targetGroup)}
            categoryLabel=""
            activeTheme={activeTheme}
            titleOverride="全月备餐开支日耗曲线"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {categoryRows.map((row) => {
            const pct = grandTotal > 0 ? ((row.amount / grandTotal) * 100).toFixed(1) : "0.0";
            return (
              <div key={row.key} className="p-5 rounded-xl border border-gray-100 bg-gradient-to-tr from-gray-50/30 to-white flex justify-between items-center hover:shadow-xs transition-shadow">
                <div className="space-y-1">
                  <span className="text-[12px] text-gray-400 font-bold uppercase tracking-wider block">食材大类</span>
                  <span className="text-lg font-bold text-gray-800">{row.label}类别</span>
                </div>
                <div className="text-right space-y-1">
                  <span className="text-[12px] text-gray-400 block">月耗开销</span>
                  <span className="text-lg font-extrabold text-sky-600">¥{row.amount.toFixed(2)}</span>
                  <span className="text-[11px] text-gray-400 font-mono block">占比 {pct}%</span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-8 p-4 bg-yellow-50/50 border border-yellow-10 border-dashed rounded-xl flex items-start gap-2 text-[13px] text-yellow-800">
          <Check size={16} className="text-yellow-600 shrink-0 mt-0.5" />
          <p className="leading-relaxed">
            <strong>合计表业务说明：</strong>该表自动归集了当前目标受众分类（{activeGroupsList.map(g => g.label).join("、")}）在各分食材（{activeCategoriesList.map(c => c.label).join("、")}）卡片里的金额输入流。如果您需要增删或微调，请点击对应类目的标签即可下潜编辑。所有的修改都将完美自动向本表累合并瞬间落盘。
          </p>
        </div>
      </div>
    );
  };

  if (selectedCategory === null) {
    return renderCategoryCombinedSummary();
  }

  return (
    <div className="space-y-3">

      {/* 过滤条与功能操作开关 */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-gray-50 p-3 rounded-2xl border border-gray-100">
        <div className="flex flex-wrap items-center gap-3">
          {/* 搜索框 */}
          <div className="relative">
            <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-gray-400">
              <Search size={14} />
            </span>
            <input
              type="text"
              placeholder="快速检索当前页食材..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 pr-4 py-1.5 w-44 bg-white border border-gray-100 rounded-xl text-[13px] text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-sky-500 transition-all font-sans"
            />
          </div>

          {/* 导出当前客群和二级分组的月度采购细表按钮 */}
          <button
            onClick={handleExportCsv}
            type="button"
            className={`flex items-center gap-1.5 px-3 py-1.5 ${activeTheme.lightBg} border ${activeTheme.primaryText.replace("text-", "border-").replace("-700", "-200")} ${activeTheme.primaryText} text-[13px] font-bold rounded-xl transition-all cursor-pointer`}
            title="导出当前餐位二级大类当月所有的每日采购明细表 (CSV)"
          >
            <Download size={13} />
            <span>导出本月细表 (CSV)</span>
          </button>

          {/* 当前受众+当前品类的当月采购花销趋势图显示开关，默认隐藏 */}
          <button
            onClick={() => setShowSpendingChart((v) => !v)}
            type="button"
            className={`flex items-center gap-1.5 px-3 py-1.5 border text-[13px] font-bold rounded-xl transition-all cursor-pointer ${showSpendingChart
              ? `${activeTheme.lightBg} ${activeTheme.primaryText} ${activeTheme.primaryText.replace("text-", "border-").replace("-700", "-200").replace("-900", "-200")}`
              : "bg-white border-gray-100 text-gray-500 hover:text-gray-800"
              }`}
            title="展示/隐藏当前受众与品类的本月每日采购花销趋势图"
          >
            <TrendingUp size={13} />
            <span>{showSpendingChart ? "隐藏花销趋势图" : "本月花销趋势图"}</span>
          </button>

          {/* 细表样式版本切换 */}
          <div className="flex items-center gap-2 bg-white border border-gray-100 rounded-xl px-3 py-1.5 text-[13px] select-none">
            <span className="text-[11px] text-gray-400 font-bold shrink-0">样式版本:</span>
            <div className="flex gap-1.5 bg-gray-100 rounded-lg p-0.5">
              <button
                type="button" onClick={() => setUseNewStyle(true)}
                className={`px-2 py-1 rounded-md transition-all text-[11px] font-bold ${useNewStyle ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
              >
                当前样式
              </button>
              <button
                type="button" onClick={() => setUseNewStyle(false)}
                className={`px-2 py-1 rounded-md transition-all text-[11px] font-bold ${!useNewStyle ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
              >
                经典样式
              </button>
            </div>
          </div>

        </div>

        <div className="flex rounded-md bg-white p-1 border border-gray-100 text-[13px] shadow-xs">
          <button
            onClick={() => setViewMode("MATRIX")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-all cursor-pointer font-medium ${viewMode === "MATRIX" ? activeTheme.btnActive : "text-gray-500 hover:text-gray-900"
              }`}
          >
            <Grid size={13} />
            <span>EXCEL 日历总矩阵</span>
          </button>
          <button
            onClick={() => setViewMode("FOCUS")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-all cursor-pointer font-medium ${viewMode === "FOCUS" ? activeTheme.btnActive : "text-gray-500 hover:text-gray-900"
              }`}
          >
            <CalendarDays size={13} />
            <span>单日聚焦卡片 (推荐)</span>
          </button>
        </div>
      </div>

      {/* 当前受众+当前品类的当月采购花销趋势图，默认隐藏，点击上方按钮展开 */}
      {showSpendingChart && (
        <MonthlySpendingChart
          days={days}
          dayTotals={dayTotals}
          groupLabel={getGroupLabel(targetGroup)}
          categoryLabel={getCategoryLabel(selectedCategory)}
          activeTheme={activeTheme}
        />
      )}

      {filteredItems.length === 0 ? (
        <div className="py-16 text-center bg-white border border-gray-100/50 rounded-2xl text-gray-400 text-[13px] italic">
          {UI_TEXT.noDataMessage}
        </div>
      ) : (
        <>
          {/* ================ (1) 大宽表日历矩阵 ================ */}
          {viewMode === "MATRIX" && (
            <TableGridMatrixView
              days={days}
              filteredItems={filteredItems}
              dayTotals={dayTotals}
              activeTheme={activeTheme}
              selectedCategory={selectedCategory}
              useNewStyle={useNewStyle}
            />
          )}

          {/* ================ (2) 单日聚焦卡片 ================ */}
          {viewMode === "FOCUS" && (
            <TableGridFocusView
              days={days}
              filteredItems={filteredItems}
              dayTotals={dayTotals}
              activeTheme={activeTheme}
              focusDay={focusDay}
              setFocusDay={setFocusDay}
              reportYear={year}
              reportMonth={month}
            />
          )}
        </>
      )}

    </div>
  );
};
