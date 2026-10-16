/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 台账"样式一"总表组件：以宽表形式逐行展示当前台账全部原料的当日采购/出库明细字段，支持按名称/品类/采购员/检验员/保管员多维度筛选。
 */

import React from "react";
import { Search, Filter, X, Trash2, ChevronLeft, ChevronRight, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { LedgerItem, DailyStockRecord, LedgerSortField, LedgerSortOrder } from "../../types/ledgerTypes.ts";
import { LedgerService } from "../../services/ledgerStore.ts";
import { SearchableSelect } from "../shared/SearchableSelect.tsx";
import { RawMaterialsDictService } from "../../services/rawMaterialDict.ts";
import { PrepReportService } from "../../services/store.ts";
import { LEDGER_HEADERS } from "../../constants/ledgerConstants.ts";
import { resolveLedgerItemCategory, UNCATEGORIZED_CATEGORY_KEY, UNCATEGORIZED_CATEGORY_LABEL } from "../../constants/constants.ts";
import { HelperSelect } from "../shared/HelperSelect.tsx";
import { SensorySelector } from "../shared/SensorySelector.tsx";

interface LedgerStyle1TableProps {
  currentLedgerItems: LedgerItem[];
  filteredLedgerItems: LedgerItem[];
  selectedDate: string;
  isRecordingMode: boolean;
  draftRecords: Record<string, DailyStockRecord>;
  editingMaterialId: string | null;
  editMaterialName: string;
  editMaterialSpec: string;
  editMaterialUnit: string;
  editMaterialStock: number;
  dictOptions: any[];
  availableCategories: string[];
  availableBuyers: string[];
  availableInspectors: string[];
  availableKeepers: string[];
  filterName: string;
  filterCategory: string;
  filterBuyer: string;
  filterInspector: string;
  filterKeeper: string;
  hasActiveFilters: boolean;
  /** 当前排序字段 */
  sortField?: LedgerSortField;
  /** 当前排序方向 (asc: 顺序, desc: 逆序) */
  sortOrder?: LedgerSortOrder;
  /** 切换排序回调 */
  onToggleSort?: (field: LedgerSortField) => void;
  setFilterName: (val: string) => void;
  setFilterCategory: (val: string) => void;
  setFilterBuyer: (val: string) => void;
  setFilterInspector: (val: string) => void;
  setFilterKeeper: (val: string) => void;
  handleSaveEditMaterial: (e: React.FormEvent) => void;
  handleDeleteMaterial: (id: string) => void;
  handleDraftCellChange: (itemId: string, fields: Partial<DailyStockRecord>) => void;
  setEditingMaterialId: (val: string | null) => void;
  setEditMaterialName: (val: string) => void;
  setEditMaterialSpec: (val: string) => void;
  setEditMaterialUnit: (val: string) => void;
  setEditMaterialStock: (val: number) => void;
}

export function LedgerStyle1Table({
  currentLedgerItems,
  filteredLedgerItems,
  selectedDate,
  isRecordingMode,
  draftRecords,
  editingMaterialId,
  editMaterialName,
  editMaterialSpec,
  editMaterialUnit,
  editMaterialStock,
  dictOptions,
  availableCategories,
  availableBuyers,
  availableInspectors,
  availableKeepers,
  filterName,
  filterCategory,
  filterBuyer,
  filterInspector,
  filterKeeper,
  hasActiveFilters,
  sortField = "category",
  sortOrder = "asc",
  onToggleSort,
  setFilterName,
  setFilterCategory,
  setFilterBuyer,
  setFilterInspector,
  setFilterKeeper,
  handleSaveEditMaterial,
  handleDeleteMaterial,
  handleDraftCellChange,
  setEditingMaterialId,
  setEditMaterialName,
  setEditMaterialSpec,
  setEditMaterialUnit,
  setEditMaterialStock,
}: LedgerStyle1TableProps) {
  /**
   * @description 动态计算输入框自适应宽度（防止输入框过窄，随用户打字自适应伸展）
   */
  const getInputWidth = (val: any, placeholder?: string, isDate?: boolean) => {
    if (isDate) return "115px";
    const valStr = val === undefined || val === null ? "" : String(val);
    const content = valStr || placeholder || "";
    let charLen = 0;
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) > 127) {
        charLen += 2;
      } else {
        charLen += 1.15;
      }
    }
    const minWidth = placeholder && (placeholder.includes("0") || placeholder.includes("¥")) ? 75 : 105;
    const calculated = charLen * 7.5 + 20;
    return `${Math.max(minWidth, calculated)}px`;
  };

  /** 总表横向滚动容器引用，供左右移动按钮调用 */
  const tableScrollRef = React.useRef<HTMLDivElement>(null);
  const scrollTable = (dir: number) => {
    tableScrollRef.current?.scrollBy({ left: dir * 320, behavior: "smooth" });
  };

  /**
   * @description 渲染支持点击排序的表头单元格
   */
  const renderSortableHeader = (
    field: LedgerSortField,
    label: string,
    className: string = "",
    extraWrapClass: string = ""
  ) => {
    const isCurrentSort = sortField === field;
    const nextOrderText = isCurrentSort && sortOrder === "asc" ? "逆序 (降序)" : "顺序 (升序)";
    return (
      <th
        onClick={() => onToggleSort?.(field)}
        className={`cursor-pointer select-none group/th transition-all hover:bg-slate-100/90 ${className}`}
        title={`点击按“${label}”进行分类或${nextOrderText}排序`}
      >
        <div className={`flex items-center gap-1.5 ${extraWrapClass}`}>
          <span className="truncate">{label}</span>
          <span className="inline-flex items-center shrink-0">
            {isCurrentSort ? (
              sortOrder === "asc" ? (
                <ArrowUp size={13} className="text-emerald-600 stroke-[2.5] animate-in fade-in" />
              ) : (
                <ArrowDown size={13} className="text-emerald-600 stroke-[2.5] animate-in fade-in" />
              )
            ) : (
              <ArrowUpDown size={11} className="text-slate-300 opacity-40 group-hover/th:opacity-100 group-hover/th:text-slate-500 transition-opacity" />
            )}
          </span>
        </div>
      </th>
    );
  };

  return (
    // 根容器不能用 overflow-hidden：下方左右移动按钮的 sticky 定位需要穿透查找到最外层 LedgerSystem.tsx
    // 页面级滚动容器才能在纵向滚动时始终悬浮可见，而 overflow-hidden（即使自身从未真正溢出滚动）在 CSS
    // 规范里同样会被视为一个"滚动容器"，截断 sticky 元素继续向上查找，导致按钮定位错误、失去悬浮效果。
    // 圆角裁剪效果改为分别加在真正需要裁剪的两个子元素上（筛选栏顶部圆角、表格滚动区底部圆角）
    <div className="bg-white rounded-xl shadow-sm border border-slate-200">
      {/* ===== 多维度筛选工具栏（含样式标签，与下方筛选条件合并为单行，节省纵向空间） ===== */}
      <div className="px-3 py-2 bg-slate-50/80 border-b border-slate-100 rounded-t-xl flex flex-wrap items-center gap-2">
        {/* 样式标签 */}
        <span className="text-[12px] font-bold text-slate-500 shrink-0">【图一样式】原料购销日总表明细</span>
        {/* 名称搜索框 */}
        <div className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5">
          <Search size={12} className="text-slate-400 shrink-0" />
          <input
            type="text"
            value={filterName}
            onChange={(e) => setFilterName(e.target.value)}
            placeholder="搜索原料名称..."
            className="text-[12px] outline-none bg-transparent w-28 text-slate-700"
          />
        </div>
        {/* 品类筛选 */}
        <div className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5">
          <Filter size={12} className="text-violet-400 shrink-0" />
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="text-[12px] outline-none bg-transparent text-slate-700 cursor-pointer"
          >
            <option value="">全部品类</option>
            {availableCategories.map(cat => (
              <option key={cat} value={cat}>
                {cat === UNCATEGORIZED_CATEGORY_KEY
                  ? UNCATEGORIZED_CATEGORY_LABEL
                  : (PrepReportService.getActiveCategories().find(c => c.key === cat)?.label || cat)}
              </option>
            ))}
          </select>
        </div>
        {/* 采购员筛选 */}
        {availableBuyers.length > 0 && (
          <div className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5">
            <span className="text-[11px] text-slate-400 shrink-0">采购员:</span>
            <select value={filterBuyer} onChange={(e) => setFilterBuyer(e.target.value)} className="text-[12px] outline-none bg-transparent text-slate-700 cursor-pointer">
              <option value="">不限</option>
              {availableBuyers.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
        )}
        {/* 检验员筛选 */}
        {availableInspectors.length > 0 && (
          <div className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5">
            <span className="text-[11px] text-slate-400 shrink-0">检验员:</span>
            <select value={filterInspector} onChange={(e) => setFilterInspector(e.target.value)} className="text-[12px] outline-none bg-transparent text-slate-700 cursor-pointer">
              <option value="">不限</option>
              {availableInspectors.map(ins => <option key={ins} value={ins}>{ins}</option>)}
            </select>
          </div>
        )}
        {/* 保管员筛选 */}
        {availableKeepers.length > 0 && (
          <div className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5">
            <span className="text-[11px] text-slate-400 shrink-0">保管员:</span>
            <select value={filterKeeper} onChange={(e) => setFilterKeeper(e.target.value)} className="text-[12px] outline-none bg-transparent text-slate-700 cursor-pointer">
              <option value="">不限</option>
              {availableKeepers.map(k => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
        )}
        {/* 清空筛选按钮 */}
        {hasActiveFilters && (
          <button
            onClick={() => { setFilterName(""); setFilterCategory(""); setFilterBuyer(""); setFilterInspector(""); setFilterKeeper(""); }}
            className="flex items-center gap-1 px-2 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-600 text-[12px] font-bold rounded-lg cursor-pointer transition-all border border-rose-200"
          >
            <X size={11} />清空筛选
          </button>
        )}
        <span className="ml-auto text-[11px] text-slate-400">
          显示 <span className="font-bold text-slate-600">{filteredLedgerItems.length}</span> / {currentLedgerItems.length} 条
          {hasActiveFilters && <span className="ml-1 text-amber-600">（已过滤）</span>}
        </span>
      </div>

      <div className="relative flex-1 min-h-0 flex flex-col">
        {/* 左右移动导航栏：粘性定位随纵向滚动始终悬浮在可视区域内（与 LedgerStyle2Flow.tsx 同款方案）。
            此前用 absolute + top-1/2 -translate-y-1/2 是相对本容器自身盒子定位的，但本容器的高度会随着
            录入模式下多达数十行原料而撑到几千像素高（真正滚动发生在更外层的 LedgerSystem.tsx 页面容器），
            导致按钮被定位在整个内容区的几何中点、而非当前可视视口内，用户几乎永远看不到、够不着 */}
        <div className="sticky top-2 z-20 h-0 pointer-events-none">
          <div className="flex justify-between px-1.5 translate-y-[35vh]">
            <button
              type="button"
              onClick={() => scrollTable(-1)}
              className="pointer-events-auto p-1.5 bg-white/90 hover:bg-white border border-slate-200 rounded-full shadow-md text-slate-500 hover:text-emerald-600 cursor-pointer transition-all"
              title="向左移动查看更多字段"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => scrollTable(1)}
              className="pointer-events-auto p-1.5 bg-white/90 hover:bg-white border border-slate-200 rounded-full shadow-md text-slate-500 hover:text-emerald-600 cursor-pointer transition-all"
              title="向右移动查看更多字段"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
        <div ref={tableScrollRef} className="overflow-auto flex-1 bg-white rounded-b-xl">
          <table className="w-full text-left border-collapse text-[13px] min-w-[1380px] relative">
            <thead className="sticky top-0 z-10 shadow-sm">
              <tr className="bg-white border-b border-slate-200 text-slate-500 font-bold uppercase">
                {renderSortableHeader("materialName", LEDGER_HEADERS.materialName, "px-4 py-2.5 text-slate-600 font-bold w-44")}
                {renderSortableHeader("category", "二级品类", "px-3 py-2.5 text-violet-700 font-bold bg-violet-50/40 whitespace-nowrap", "justify-center")}
                <th className="px-3 py-2.5 text-center text-slate-600 font-bold w-20">单位</th>
                <th className="px-3 py-2.5 text-emerald-800 font-bold bg-emerald-50/30 w-28">{LEDGER_HEADERS.inQuantity}</th>
                <th className="px-3 py-2.5 text-emerald-800 font-bold bg-emerald-50/30 w-24">单价(元)</th>
                <th className="px-3 py-2.5 text-indigo-800 font-bold bg-indigo-50/30 w-28">{LEDGER_HEADERS.outQuantity}</th>
                <th className="px-3 py-2.5 text-slate-600 font-bold w-28">{LEDGER_HEADERS.certification}</th>
                <th className="px-3 py-2.5 text-slate-600 font-bold w-28">{LEDGER_HEADERS.sensoryProperty}</th>
                {renderSortableHeader("supplier", LEDGER_HEADERS.supplier, "px-3 py-2.5 text-slate-600 font-bold w-48")}
                <th className="px-3 py-2.5 text-slate-600 font-bold w-36">生产日期</th>
                <th className="px-3 py-2.5 text-slate-600 font-bold w-36">保质期</th>
                {renderSortableHeader("buyer", LEDGER_HEADERS.buyer, "px-3 py-2.5 text-slate-600 font-bold w-28")}
                {renderSortableHeader("purchaseDate", "采购/入库时间", "px-3 py-2.5 text-emerald-700 font-bold bg-emerald-50/20 w-36")}
                <th className="px-3 py-2.5 text-indigo-700 font-bold bg-indigo-50/20 w-36">出库时间</th>
                {renderSortableHeader("inspector", LEDGER_HEADERS.inspector, "px-3 py-2.5 text-slate-600 font-bold w-28")}
                {renderSortableHeader("keeper", LEDGER_HEADERS.keeper, "px-3 py-2.5 text-slate-600 font-bold w-28")}
                {renderSortableHeader("outHandler", "出库人", "px-3 py-2.5 text-indigo-700 font-bold bg-indigo-50/20 w-28")}
                {renderSortableHeader("outRecipient", "接收人", "px-3 py-2.5 text-indigo-700 font-bold bg-indigo-50/20 w-28")}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {currentLedgerItems.length === 0 ? (
                <tr>
                  <td colSpan={18} className="text-center py-12 text-slate-400 italic">
                    该台账暂无采购原料。请点击左上方“开启当日录入”进入录入模式，选择字典中的原料并填写数据即可自动添加。
                  </td>
                </tr>
              ) : filteredLedgerItems.length === 0 ? (
                <tr>
                  <td colSpan={18} className="text-center py-10 text-slate-400 italic">
                    <div className="flex flex-col items-center gap-2 py-2">
                      <Search size={26} className="text-slate-200" />
                      <span>
                        {hasActiveFilters
                          ? "未找到符合筛选条件的原料，请调整条件后重试。"
                          : "当前所选录入日期暂无任何原料的出入库记录。"}
                      </span>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredLedgerItems.map((item) => {
                  const isItemEditing = editingMaterialId === item.id;
                  const record = item.dailyRecords[selectedDate] || {
                    inQuantity: 0, inPrice: 0, inAmount: 0, outQuantity: 0, note: "",
                    certification: "", sensoryProperty: "", supplier: "", buyer: "", inspector: "", keeper: "",
                    outHandler: "", outRecipient: ""
                  };

                  if (isItemEditing) {
                    return (
                      <tr key={item.id} className="bg-emerald-50/20">
                        <td colSpan={18} className="px-4 py-2.5">
                          <form onSubmit={handleSaveEditMaterial} className="flex flex-wrap items-center gap-3">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[12px] font-bold text-slate-400">原料品名:</span>
                              <SearchableSelect
                                options={dictOptions}
                                value={editMaterialName}
                                onChange={(val, opt) => {
                                  setEditMaterialName(val);
                                  if (opt && opt.unit) {
                                    setEditMaterialUnit(opt.unit);
                                  }
                                }}
                                placeholder="选择原料"
                                className="w-28"
                              />
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[12px] font-bold text-slate-400">规格:</span>
                              <input
                                type="text" value={editMaterialSpec} onChange={(e) => setEditMaterialSpec(e.target.value)}
                                className="bg-white border border-slate-300 px-2 py-1 rounded text-[13px] w-28 outline-none"
                              />
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[12px] font-bold text-slate-400">单位:</span>
                              <input
                                type="text" value={editMaterialUnit} onChange={(e) => setEditMaterialUnit(e.target.value)}
                                className="bg-white border border-slate-300 px-2 py-1 rounded text-[13px] w-16 text-center outline-none" required
                              />
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[12px] font-bold text-slate-400">初始库存:</span>
                              <input
                                type="number" step="any" value={editMaterialStock} onChange={(e) => setEditMaterialStock(Number(e.target.value))}
                                className="bg-white border border-slate-300 px-2 py-1 rounded text-[13px] w-20 text-right outline-none" required
                              />
                            </div>
                            <button type="submit" className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-[13px] font-bold cursor-pointer">
                              保存原料参数
                            </button>
                            <button type="button" onClick={() => setEditingMaterialId(null)} className="px-3 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded text-[13px] cursor-pointer">
                              取消
                            </button>
                          </form>
                        </td>
                      </tr>
                    );
                  }

                  const draftRecord = draftRecords[item.id];
                  const recordToRender = isRecordingMode ? (draftRecord || {
                    inQuantity: 0, inPrice: 0, inAmount: 0, outQuantity: 0, note: "",
                    certification: "", sensoryProperty: "", supplier: "", buyer: "", inspector: "", keeper: "",
                    outHandler: "", outRecipient: ""
                  }) : record;

                  return (
                    <tr key={item.id} className="hover:bg-slate-50/50 group">
                      <td className="px-4 py-2.5 font-bold text-slate-800 flex justify-between items-center min-w-[150px]">
                        <div>
                          {(() => {
                            const dictItem = RawMaterialsDictService.getItems().find(d => d.name === item.name);
                            const displayName = dictItem ? dictItem.name : item.name;
                            const displayRemark = dictItem?.remark || "";
                            return (
                              <>
                                {displayName}
                                {displayRemark ? (
                                  <div className="text-[10px] text-slate-400 font-normal mt-0.5">{displayRemark}</div>
                                ) : (
                                  <div className="text-[10px] text-slate-350 font-normal mt-0.5">{item.spec || ""}</div>
                                )}
                              </>
                            );
                          })()}
                        </div>

                        {/* 悬浮删除原料采购项目按钮 */}
                        {!isRecordingMode && (
                          <button
                            onClick={() => handleDeleteMaterial(item.id)}
                            className="opacity-0 group-hover:opacity-100 p-1 bg-rose-50 hover:bg-rose-100 text-rose-600 rounded-lg cursor-pointer transition-all shrink-0 ml-2"
                            title="删除此台账原料采购项"
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </td>
                      {/* 二级品类标签列 */}
                      <td className="px-3 py-2.5 text-center bg-violet-50/30 whitespace-nowrap">
                        {(() => {
                          const cat = resolveLedgerItemCategory(item, (n) => RawMaterialsDictService.getCategoryForMaterial(n));
                          if (cat === UNCATEGORIZED_CATEGORY_KEY) {
                            return (
                              <span className="text-[11px] font-bold px-1.5 py-0.5 rounded border bg-gray-100 text-gray-500 border-gray-200" title="该原料没有分类快照（字典里查不到），已归入未分类">
                                {UNCATEGORIZED_CATEGORY_LABEL}
                              </span>
                            );
                          }
                          const activeCat = PrepReportService.getActiveCategories().find(c => c.key === cat);
                          const catLabel = activeCat ? activeCat.label : cat;
                          const colorMap: Record<string, string> = {
                            VEGETABLE: "bg-green-100 text-green-700 border-green-200",
                            GRAIN_OIL: "bg-amber-100 text-amber-700 border-amber-200",
                            SEASONING: "bg-orange-100 text-orange-700 border-orange-200",
                            MEAT: "bg-red-100 text-red-700 border-red-200",
                            LOW_CONSUMP: "bg-slate-100 text-slate-600 border-slate-200",
                            FRUIT: "bg-pink-100 text-pink-700 border-pink-200"
                          };
                          return (
                            <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded border ${colorMap[cat] || "bg-gray-100 text-gray-600 border-gray-200"}`}>
                              {catLabel}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2.5 text-center text-slate-500">
                        {RawMaterialsDictService.getItems().find(d => d.name === item.name)?.unit || item.unit}
                      </td>

                      {/* 采购数量 */}
                      <td className="px-3 py-2 bg-emerald-50/10">
                        <input
                          type="number" step="any"
                          value={recordToRender.inQuantity || ""}
                          placeholder={isRecordingMode ? "0" : "未开启录入"}
                          disabled={!isRecordingMode}
                          onChange={(e) => handleDraftCellChange(item.id, { inQuantity: Number(e.target.value) })}
                          className="bg-white disabled:bg-slate-50 disabled:text-slate-400 border border-slate-200 px-2 py-1 rounded text-right font-mono outline-none"
                          style={{ width: getInputWidth(recordToRender.inQuantity, isRecordingMode ? "0" : "未开启录入") }}
                        />
                        {(() => {
                          const dictItem = RawMaterialsDictService.getItems().find(d => d.name === item.name);
                          if (dictItem && dictItem.conversionUnit && dictItem.conversionRatio) {
                            const qty = recordToRender.inQuantity || 0;
                            const converted = qty * dictItem.conversionRatio;
                            return (
                              <div className="text-[10px] text-emerald-600 font-bold text-right mt-0.5">
                                折合: {converted.toFixed(1)} {dictItem.conversionUnit}
                              </div>
                            );
                          }
                          return null;
                        })()}
                      </td>

                      {/* 单价 */}
                      <td className="px-3 py-2 bg-emerald-50/10">
                        <input
                          type="number" step="any"
                          value={recordToRender.inPrice || ""}
                          placeholder={isRecordingMode ? "¥0.00" : "未开启录入"}
                          disabled={!isRecordingMode}
                          onChange={(e) => handleDraftCellChange(item.id, { inPrice: Number(e.target.value) })}
                          className="bg-white disabled:bg-slate-50 disabled:text-slate-400 border border-slate-200 px-2 py-1 rounded text-right font-mono outline-none"
                          style={{ width: getInputWidth(recordToRender.inPrice, isRecordingMode ? "¥0.00" : "未开启录入") }}
                        />
                      </td>

                      {/* 出库数量 */}
                      <td className="px-3 py-2 bg-indigo-50/10">
                        <input
                          type="number" step="any"
                          value={recordToRender.outQuantity || ""}
                          placeholder={isRecordingMode ? "0" : "未开启录入"}
                          disabled={!isRecordingMode}
                          onChange={(e) => handleDraftCellChange(item.id, { outQuantity: Number(e.target.value) })}
                          className="bg-white disabled:bg-slate-50 disabled:text-slate-400 border border-slate-200 px-2 py-1 rounded text-right font-mono outline-none"
                          style={{ width: getInputWidth(recordToRender.outQuantity, isRecordingMode ? "0" : "未开启录入") }}
                        />
                      </td>

                      {/* 食品索证 */}
                      <td className="px-3 py-2">
                        {isRecordingMode ? (
                          <select
                            value={recordToRender.certification || ""}
                            onChange={(e) => handleDraftCellChange(item.id, { certification: e.target.value })}
                            className="bg-white border border-slate-200 px-2 py-1 rounded outline-none w-24 text-[13px] cursor-pointer focus:border-emerald-400"
                          >
                            <option value="">-- 选择 --</option>
                            <option value="有">有</option>
                            <option value="无">无</option>
                          </select>
                        ) : (
                          <input
                            type="text"
                            value={recordToRender.certification || ""}
                            placeholder="未开启录入"
                            disabled={true}
                            className="bg-slate-50 text-slate-400 border border-slate-200 px-2 py-1 rounded outline-none"
                            style={{ width: getInputWidth(recordToRender.certification, "未开启录入") }}
                          />
                        )}
                      </td>

                      {/* 感官性状 */}
                      <td className="px-3 py-2">
                        <SensorySelector
                          value={recordToRender.sensoryProperty || ""}
                          disabled={!isRecordingMode}
                          onChange={(val) => handleDraftCellChange(item.id, { sensoryProperty: val })}
                        />
                      </td>

                      {/* 供货商及地址 */}
                      <td className="px-3 py-2">
                        <HelperSelect
                          value={recordToRender.supplier || ""}
                          options={LedgerService.getHelperDict().suppliers.map(s => s.split('|')[0])}
                          disabled={!isRecordingMode}
                          onChange={(val) => handleDraftCellChange(item.id, { supplier: val })}
                          placeholder="未开启录入"
                          className="w-48"
                        />
                      </td>

                      {/* 生产日期 */}
                      <td className="px-3 py-2">
                        <input
                          type="date"
                          value={recordToRender.produceDate || ""}
                          disabled={!isRecordingMode}
                          onChange={(e) => handleDraftCellChange(item.id, { produceDate: e.target.value })}
                          className="bg-white disabled:bg-slate-50 disabled:text-slate-300 border border-slate-200 px-1.5 py-1 rounded font-mono text-[13px] outline-none focus:border-emerald-400"
                          style={{ width: getInputWidth(recordToRender.produceDate, "", true) }}
                          title="生产日期 (选填)"
                        />
                      </td>

                      {/* 保质期 */}
                      <td className="px-3 py-2">
                        {isRecordingMode ? (
                          <select
                            value={recordToRender.shelfLife || ""}
                            onChange={(e) => handleDraftCellChange(item.id, { shelfLife: e.target.value })}
                            className="bg-white border border-slate-200 px-2 py-1 rounded outline-none w-28 text-[13px] cursor-pointer focus:border-emerald-400"
                          >
                            <option value="">-- 选择 --</option>
                            {LedgerService.getHelperDict().shelfLifeOptions.map((opt) => (
                              <option key={opt} value={opt}>{opt}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="text"
                            value={recordToRender.shelfLife || ""}
                            placeholder="未开启录入"
                            disabled={true}
                            className="bg-slate-50 text-slate-400 border border-slate-200 px-2 py-1 rounded outline-none"
                            style={{ width: getInputWidth(recordToRender.shelfLife, "未开启录入") }}
                          />
                        )}
                      </td>

                      {/* 采购员 */}
                      <td className="px-3 py-2">
                        <HelperSelect
                          value={recordToRender.buyer || ""}
                          options={LedgerService.getHelperDict().buyers}
                          disabled={!isRecordingMode}
                          onChange={(val) => handleDraftCellChange(item.id, { buyer: val })}
                          placeholder="未开启录入"
                          className="w-28"
                        />
                      </td>

                      {/* 采购/入库时间（默认选定日期，允许手动修改） */}
                      <td className="px-3 py-2 bg-emerald-50/20">
                        <input
                          type="date"
                          value={recordToRender.purchaseDate || selectedDate}
                          disabled={!isRecordingMode}
                          onChange={(e) => handleDraftCellChange(item.id, { purchaseDate: e.target.value })}
                          className="bg-white disabled:bg-slate-50 disabled:text-slate-300 border border-slate-200 px-1.5 py-1 rounded font-mono text-[13px] outline-none focus:border-emerald-400"
                          style={{ width: getInputWidth(recordToRender.purchaseDate || selectedDate, "", true) }}
                          title="采购入库时间（默认为当日，可手动修改）"
                        />
                      </td>

                      {/* 出库时间（默认选定日期，允许手动修改） */}
                      <td className="px-3 py-2 bg-indigo-50/20">
                        <input
                          type="date"
                          value={recordToRender.outDate || selectedDate}
                          disabled={!isRecordingMode}
                          onChange={(e) => handleDraftCellChange(item.id, { outDate: e.target.value })}
                          className="bg-white disabled:bg-slate-50 disabled:text-slate-300 border border-slate-200 px-1.5 py-1 rounded font-mono text-[13px] outline-none focus:border-indigo-400"
                          style={{ width: getInputWidth(recordToRender.outDate || selectedDate, "", true) }}
                          title="出库时间（默认为当日，可手动修改）"
                        />
                      </td>

                      {/* 检验员 */}
                      <td className="px-3 py-2">
                        <HelperSelect
                          value={recordToRender.inspector || ""}
                          options={LedgerService.getHelperDict().inspectors}
                          disabled={!isRecordingMode}
                          onChange={(val) => handleDraftCellChange(item.id, { inspector: val })}
                          placeholder="未开启录入"
                          className="w-28"
                        />
                      </td>

                      {/* 保管员 */}
                      <td className="px-3 py-2">
                        <HelperSelect
                          value={recordToRender.keeper || ""}
                          options={LedgerService.getHelperDict().keepers}
                          disabled={!isRecordingMode}
                          onChange={(val) => handleDraftCellChange(item.id, { keeper: val })}
                          placeholder="未开启录入"
                          className="w-28"
                        />
                      </td>

                      {/* 发料出库人 */}
                      <td className="px-3 py-2 bg-indigo-50/10">
                        <HelperSelect
                          value={recordToRender.outHandler || ""}
                          options={LedgerService.getHelperDict().outHandlers}
                          disabled={!isRecordingMode}
                          onChange={(val) => handleDraftCellChange(item.id, { outHandler: val })}
                          placeholder="未开启录入"
                          className="w-28"
                        />
                      </td>

                      {/* 领用接收人 */}
                      <td className="px-3 py-2 bg-indigo-50/10">
                        <HelperSelect
                          value={recordToRender.outRecipient || ""}
                          options={LedgerService.getHelperDict().outRecipients}
                          disabled={!isRecordingMode}
                          onChange={(val) => handleDraftCellChange(item.id, { outRecipient: val })}
                          placeholder="未开启录入"
                          className="w-28"
                        />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
