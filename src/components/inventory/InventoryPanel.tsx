/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 原料库存总览模态面板：实时汇总全部台账下各原料的入库/出库累计与当前库存，支持按台账、分类、库存预警状态筛选及拼音模糊搜索。
 */

import { useState, useMemo, useEffect } from "react";
import { LedgerItem, Ledger } from "../../types/ledgerTypes.ts";
import { LedgerService } from "../../services/ledgerStore.ts";
import { RawMaterialsDictService } from "../../services/rawMaterialDict.ts";
import { matchPinyin } from "../../utils.ts";
import { PrepReportService } from "../../services/store.ts";
import { FoodCategory } from "../../types/types.ts";
import { resolveLedgerItemCategory, UNCATEGORIZED_CATEGORY_KEY, UNCATEGORIZED_CATEGORY_LABEL } from "../../constants/constants.ts";
import {
  X,
  Search,
  Package,
  TrendingDown,
  TrendingUp,
  AlertTriangle,
  ChevronDown,
  Layers,
  RefreshCw,
} from "lucide-react";

// ======================== 常量配置 ========================

/** 低库存预警阈值（低于此值显示橙色警告） */
const LOW_STOCK_THRESHOLD = 5;
/** 极低库存预警阈值（低于此值显示红色警告） */
const CRITICAL_STOCK_THRESHOLD = 1;

/** 库存面板支持的筛选台账选项（"ALL" 表示不限） */
const ALL_LEDGER_OPTION = "ALL";
/** 库存面板支持的筛选分类选项（"ALL" 表示不限） */
const ALL_CATEGORY_OPTION = "ALL";

// ======================== 接口定义 ========================

/**
 * @description 库存面板组件的 Props
 */
interface InventoryPanelProps {
  /** 关闭回调 */
  onClose: () => void;
}

/**
 * @description 聚合后的库存展示数据行
 */
interface InventoryRow {
  /** 原料项目ID（来自 LedgerItem.id） */
  id: string;
  /** 所属台账ID */
  ledgerId: string;
  /** 所属台账名称 */
  ledgerName: string;
  /** 原料名称 */
  name: string;
  /** 计量单位 */
  unit: string;
  /** 原料规格 */
  spec?: string;
  /** 所属二级分类（从字典中获取） */
  category: FoodCategory | null;
  /** 二级分类中文名称 */
  categoryLabel: string;
  /** 初始库存 */
  initialStock: number;
  /** 历史累计入库总量 */
  totalIn: number;
  /** 历史累计出库总量 */
  totalOut: number;
  /** 当前实时库存 */
  currentStock: number;
}

// ======================== 组件实现 ========================

/**
 * @description 原料库存总览面板，支持多维度筛选与拼音模糊搜索
 */
export function InventoryPanel({ onClose }: InventoryPanelProps) {
  // ========== 状态声明 ==========

  /** 所有台账列表 */
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  /** 所有原料列表 */
  const [ledgerItems, setLedgerItems] = useState<LedgerItem[]>([]);

  /** 文字搜索查询词（支持拼音 / 汉字） */
  const [searchQuery, setSearchQuery] = useState<string>("");
  /** 选中的台账过滤项（"ALL" 表示不限） */
  const [selectedLedger, setSelectedLedger] = useState<string>(ALL_LEDGER_OPTION);
  /** 选中的二级分类过滤项（"ALL" 表示不限） */
  const [selectedCategory, setSelectedCategory] = useState<string>(ALL_CATEGORY_OPTION);
  /** 是否仅展示库存低于预警线的原料 */
  const [showLowStockOnly, setShowLowStockOnly] = useState<boolean>(false);
  /** 排序字段 */
  const [sortField, setSortField] = useState<"name" | "currentStock" | "totalIn" | "totalOut">("name");
  /** 排序方向 */
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // ========== 数据加载 ==========

  useEffect(() => {
    /** 订阅台账数据，实现实时刷新 */
    const unsubscribe = LedgerService.subscribe((ls, items) => {
      setLedgers(ls);
      setLedgerItems(items);
    });
    return () => unsubscribe();
  }, []);

  // ========== 派生数据：聚合并转换 InventoryRow ==========

  /**
   * @description 将 LedgerItem 列表转换为库存展示行数据
   */
  const inventoryRows = useMemo<InventoryRow[]>(() => {
    // [字典与台账解耦] 不再要求原料存在于字典——库存总览展示所有台账原料项。
    return ledgerItems
      .map((item) => {
        // 分类走 item.category 快照，缺失回退字典、再缺失归“未分类”
        const resolved = resolveLedgerItemCategory(item, (n) => RawMaterialsDictService.getCategoryForMaterial(n));
        const category = resolved === UNCATEGORIZED_CATEGORY_KEY ? null : resolved;
        const dynamicLabel = PrepReportService.getActiveCategories().find(c => c.key === category)?.label;
        const categoryLabel = category
          ? (dynamicLabel || "未知分类")
          : UNCATEGORIZED_CATEGORY_LABEL;

        // 读取后端直接发来的历史累计总和（不受懒加载被截断月份影响）
        const totalIn = item.historicalTotalIn ?? 0;
        const totalOut = item.historicalTotalOut ?? 0;

        // 台账名称
        const ledger = ledgers.find((l) => l.id === item.ledgerId);
        const ledgerName = ledger?.name ?? item.ledgerId;

        return {
          id: item.id,
          ledgerId: item.ledgerId,
          ledgerName,
          name: item.name,
          unit: item.unit,
          spec: item.spec,
          category,
          categoryLabel,
          initialStock: item.initialStock,
          totalIn: Math.round(totalIn * 100) / 100,
          totalOut: Math.round(totalOut * 100) / 100,
          currentStock: item.currentStock,
        } satisfies InventoryRow;
      });
  }, [ledgerItems, ledgers]);

  // ========== 筛选 + 搜索 + 排序后的数据 ==========

  /** 经过全部过滤器处理后的最终展示数据 */
  const filteredRows = useMemo<InventoryRow[]>(() => {
    let result = [...inventoryRows];

    // 按台账过滤
    if (selectedLedger !== ALL_LEDGER_OPTION) {
      result = result.filter((r) => r.ledgerId === selectedLedger);
    }

    // 按二级分类过滤
    if (selectedCategory !== ALL_CATEGORY_OPTION) {
      result = result.filter((r) => r.category === selectedCategory);
    }

    // 低库存预警过滤
    if (showLowStockOnly) {
      result = result.filter((r) => r.currentStock <= LOW_STOCK_THRESHOLD);
    }

    // 关键词搜索（支持拼音）
    if (searchQuery.trim()) {
      result = result.filter(
        (r) =>
          matchPinyin(r.name, searchQuery) ||
          matchPinyin(r.ledgerName, searchQuery) ||
          matchPinyin(r.categoryLabel, searchQuery)
      );
    }

    // 排序
    result.sort((a, b) => {
      let valA: string | number;
      let valB: string | number;
      switch (sortField) {
        case "currentStock":
          valA = a.currentStock;
          valB = b.currentStock;
          break;
        case "totalIn":
          valA = a.totalIn;
          valB = b.totalIn;
          break;
        case "totalOut":
          valA = a.totalOut;
          valB = b.totalOut;
          break;
        default:
          valA = a.name;
          valB = b.name;
      }
      if (typeof valA === "string" && typeof valB === "string") {
        return sortDir === "asc" ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      return sortDir === "asc" ? (valA as number) - (valB as number) : (valB as number) - (valA as number);
    });

    return result;
  }, [inventoryRows, selectedLedger, selectedCategory, showLowStockOnly, searchQuery, sortField, sortDir]);

  // ========== 统计汇总指标 ==========

  /** 当前视图下低库存原料数量 */
  const lowStockCount = useMemo(
    () => filteredRows.filter((r) => r.currentStock > 0 && r.currentStock <= LOW_STOCK_THRESHOLD).length,
    [filteredRows]
  );
  /** 当前视图下极低/归零原料数量 */
  const criticalStockCount = useMemo(
    () => filteredRows.filter((r) => r.currentStock <= CRITICAL_STOCK_THRESHOLD).length,
    [filteredRows]
  );
  /** 当前视图下总原料种数 */
  const totalItemCount = filteredRows.length;

  // ========== 切换排序 ==========

  /**
   * @description 点击表头切换排序字段与方向
   * @param field 排序字段
   */
  const handleSort = (field: typeof sortField) => {
    if (sortField === field) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  /**
   * @description 获取库存状态的样式 class
   */
  const getStockStyle = (stock: number): string => {
    if (stock <= CRITICAL_STOCK_THRESHOLD) return "text-rose-600 font-black";
    if (stock <= LOW_STOCK_THRESHOLD) return "text-amber-600 font-bold";
    return "text-emerald-700 font-bold";
  };

  /**
   * @description 获取库存状态标签
   */
  const getStockBadge = (stock: number) => {
    if (stock <= CRITICAL_STOCK_THRESHOLD)
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-rose-100 text-rose-700 text-[9px] font-black rounded-full border border-rose-200">
          <AlertTriangle size={8} />
          极低
        </span>
      );
    if (stock <= LOW_STOCK_THRESHOLD)
      return (
        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-amber-100 text-amber-700 text-[9px] font-bold rounded-full border border-amber-200">
          <AlertTriangle size={8} />
          偏低
        </span>
      );
    return null;
  };

  // ========== 渲染 ==========

  return (
    /* 全屏遮罩层 */
    <div className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm z-[1000] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-6xl max-h-[92vh] flex flex-col overflow-hidden">

        {/* ===== 顶部标题栏 ===== */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-gradient-to-br from-emerald-500 to-teal-500 rounded-xl flex items-center justify-center shadow-md shadow-emerald-200">
              <Package size={18} className="text-white" />
            </div>
            <div>
              <h2 className="text-sm font-black text-slate-800 leading-tight">原料库存总览</h2>
              <p className="text-[10px] text-slate-400 font-medium">实时库存监控 · 支持拼音模糊搜索</p>
            </div>
          </div>

          {/* 汇总统计卡片 */}
          <div className="hidden sm:flex items-center gap-3">
            <div className="text-center bg-slate-50 rounded-xl px-4 py-2 border border-slate-100">
              <div className="text-lg font-black text-slate-800 leading-none">{totalItemCount}</div>
              <div className="text-[9px] text-slate-400 font-bold mt-0.5">当前品种</div>
            </div>
            <div className="text-center bg-amber-50 rounded-xl px-4 py-2 border border-amber-100">
              <div className="text-lg font-black text-amber-600 leading-none">{lowStockCount}</div>
              <div className="text-[9px] text-amber-500 font-bold mt-0.5">库存偏低</div>
            </div>
            <div className="text-center bg-rose-50 rounded-xl px-4 py-2 border border-rose-100">
              <div className="text-lg font-black text-rose-600 leading-none">{criticalStockCount}</div>
              <div className="text-[9px] text-rose-500 font-bold mt-0.5">极低/归零</div>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-700 transition-colors cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        {/* ===== 筛选工具栏 ===== */}
        <div className="px-6 py-3 border-b border-slate-100 bg-slate-50/50 shrink-0">
          <div className="flex flex-wrap items-center gap-3">

            {/* 全文搜索框 */}
            <div className="relative flex-1 min-w-40">
              <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索原料名称 / 拼音首字母..."
                className="w-full pl-8 pr-3 py-2 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-100 transition-all placeholder-slate-300"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500 cursor-pointer"
                >
                  <X size={11} />
                </button>
              )}
            </div>

            {/* 台账筛选 */}
            <div className="relative">
              <select
                value={selectedLedger}
                onChange={(e) => setSelectedLedger(e.target.value)}
                className="appearance-none pl-3 pr-7 py-2 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:border-emerald-400 cursor-pointer text-slate-700 font-medium transition-all"
              >
                <option value={ALL_LEDGER_OPTION}>全部台账</option>
                {ledgers.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            </div>

            {/* 分类筛选 */}
            <div className="relative">
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="appearance-none pl-3 pr-7 py-2 text-xs bg-white border border-slate-200 rounded-lg outline-none focus:border-emerald-400 cursor-pointer text-slate-700 font-medium transition-all"
              >
                <option value={ALL_CATEGORY_OPTION}>全部分类</option>
                {PrepReportService.getActiveCategories().map((cat) => (
                  <option key={cat.key} value={cat.key}>
                    {cat.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            </div>

            {/* 低库存预警快捷切换 */}
            <button
              onClick={() => setShowLowStockOnly((v) => !v)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-bold rounded-lg border transition-all cursor-pointer ${showLowStockOnly
                ? "bg-amber-500 text-white border-amber-500 shadow-sm shadow-amber-200"
                : "bg-white text-slate-600 border-slate-200 hover:border-amber-300 hover:text-amber-600"
                }`}
            >
              <AlertTriangle size={12} />
              仅看预警
            </button>

            {/* 重置筛选器 */}
            <button
              onClick={() => {
                setSearchQuery("");
                setSelectedLedger(ALL_LEDGER_OPTION);
                setSelectedCategory(ALL_CATEGORY_OPTION);
                setShowLowStockOnly(false);
              }}
              className="flex items-center gap-1 px-2.5 py-2 text-[11px] font-bold rounded-lg border border-slate-200 bg-white text-slate-400 hover:text-slate-600 hover:border-slate-300 transition-all cursor-pointer"
              title="重置所有筛选条件"
            >
              <RefreshCw size={11} />
              重置
            </button>
          </div>
        </div>

        {/* ===== 数据表格区 ===== */}
        <div className="flex-1 overflow-auto">
          {filteredRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full py-20 text-slate-300">
              <Layers size={48} strokeWidth={1} className="mb-3" />
              <p className="text-sm font-bold text-slate-400">暂无符合条件的原料库存数据</p>
              <p className="text-xs text-slate-300 mt-1">请检查筛选条件，或前往台账录入数据</p>
            </div>
          ) : (
            <table className="w-full text-left border-collapse text-xs">
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-900 text-white">
                  <th className="px-4 py-3 text-[10px] font-bold w-10 text-center text-slate-400">#</th>

                  {/* 原料名称（可排序） */}
                  <th
                    className="px-4 py-3 text-[10px] font-bold cursor-pointer hover:bg-slate-800 transition-colors select-none"
                    onClick={() => handleSort("name")}
                  >
                    <span className="flex items-center gap-1">
                      原料名称
                      {sortField === "name" && (
                        <span className="text-emerald-400">{sortDir === "asc" ? "↑" : "↓"}</span>
                      )}
                    </span>
                  </th>

                  <th className="px-3 py-3 text-[10px] font-bold text-slate-300 whitespace-nowrap">所属分类</th>
                  <th className="px-3 py-3 text-[10px] font-bold text-slate-300 whitespace-nowrap">台账归属</th>
                  <th className="px-3 py-3 text-[10px] font-bold text-slate-300 whitespace-nowrap">规格</th>
                  <th className="px-3 py-3 text-[10px] font-bold text-slate-300 whitespace-nowrap text-center">单位</th>

                  {/* 入库累计（可排序） */}
                  <th
                    className="px-4 py-3 text-[10px] font-bold cursor-pointer hover:bg-slate-800 transition-colors select-none text-right"
                    onClick={() => handleSort("totalIn")}
                  >
                    <span className="flex items-center justify-end gap-1">
                      <TrendingUp size={10} className="text-emerald-400" />
                      入库累计
                      {sortField === "totalIn" && (
                        <span className="text-emerald-400">{sortDir === "asc" ? "↑" : "↓"}</span>
                      )}
                    </span>
                  </th>

                  {/* 出库累计（可排序） */}
                  <th
                    className="px-4 py-3 text-[10px] font-bold cursor-pointer hover:bg-slate-800 transition-colors select-none text-right"
                    onClick={() => handleSort("totalOut")}
                  >
                    <span className="flex items-center justify-end gap-1">
                      <TrendingDown size={10} className="text-rose-400" />
                      出库累计
                      {sortField === "totalOut" && (
                        <span className="text-emerald-400">{sortDir === "asc" ? "↑" : "↓"}</span>
                      )}
                    </span>
                  </th>

                  {/* 当前库存（可排序） */}
                  <th
                    className="px-4 py-3 text-[10px] font-bold cursor-pointer hover:bg-slate-800 transition-colors select-none text-right"
                    onClick={() => handleSort("currentStock")}
                  >
                    <span className="flex items-center justify-end gap-1">
                      当前库存
                      {sortField === "currentStock" && (
                        <span className="text-emerald-400">{sortDir === "asc" ? "↑" : "↓"}</span>
                      )}
                    </span>
                  </th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-50">
                {filteredRows.map((row, index) => {
                  const isLow = row.currentStock <= LOW_STOCK_THRESHOLD && row.currentStock > CRITICAL_STOCK_THRESHOLD;
                  const isCritical = row.currentStock <= CRITICAL_STOCK_THRESHOLD;
                  const rowBg = isCritical
                    ? "bg-rose-50/60 hover:bg-rose-50"
                    : isLow
                      ? "bg-amber-50/40 hover:bg-amber-50/80"
                      : "bg-white hover:bg-slate-50/50";

                  return (
                    <tr key={row.id} className={`transition-colors ${rowBg}`}>
                      {/* 序号 */}
                      <td className="px-4 py-3 text-slate-400 font-mono text-[10px] text-center">{index + 1}</td>

                      {/* 原料名称 + 状态标签 */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-800">{row.name}</span>
                          {getStockBadge(row.currentStock)}
                        </div>
                      </td>

                      {/* 所属分类 */}
                      <td className="px-3 py-3">
                        <span className="px-2 py-0.5 bg-slate-100 text-slate-600 text-[10px] font-bold rounded-md">
                          {row.categoryLabel}
                        </span>
                      </td>

                      {/* 台账归属 */}
                      <td className="px-3 py-3">
                        <span className="text-slate-500 font-medium">{row.ledgerName}</span>
                      </td>

                      {/* 规格 */}
                      <td className="px-3 py-3 text-slate-400">{row.spec || ""}</td>

                      {/* 单位 */}
                      <td className="px-3 py-3 text-center text-slate-500 font-medium">{row.unit}</td>

                      {/* 入库累计 */}
                      <td className="px-4 py-3 text-right">
                        <span className="text-emerald-700 font-mono font-bold">+{row.totalIn}</span>
                      </td>

                      {/* 出库累计 */}
                      <td className="px-4 py-3 text-right">
                        <span className="text-slate-500 font-mono">-{row.totalOut}</span>
                      </td>

                      {/* 当前库存 */}
                      <td className="px-4 py-3 text-right">
                        <span className={`font-mono text-sm ${getStockStyle(row.currentStock)}`}>
                          {row.currentStock}
                        </span>
                        <span className="text-slate-400 text-[10px] ml-0.5">{row.unit}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ===== 底部状态栏 ===== */}
        <div className="px-6 py-3 border-t border-slate-100 bg-slate-50/50 shrink-0 flex items-center justify-between">
          <div className="text-[10px] text-slate-400 font-medium">
            共展示 <span className="font-black text-slate-700">{filteredRows.length}</span> 条原料库存记录
            {(selectedLedger !== ALL_LEDGER_OPTION || selectedCategory !== ALL_CATEGORY_OPTION || showLowStockOnly || searchQuery) && (
              <span className="ml-1 text-emerald-600">（已筛选）</span>
            )}
          </div>
          <div className="flex items-center gap-3 text-[10px] font-bold">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 bg-emerald-400 rounded-full"></span>
              <span className="text-slate-400">库存充足</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 bg-amber-400 rounded-full"></span>
              <span className="text-slate-400">库存偏低 (≤{LOW_STOCK_THRESHOLD})</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 bg-rose-400 rounded-full"></span>
              <span className="text-slate-400">极低/归零 (≤{CRITICAL_STOCK_THRESHOLD})</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
