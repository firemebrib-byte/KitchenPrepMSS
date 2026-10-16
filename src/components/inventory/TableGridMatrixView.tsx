/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 备餐采购细表的"EXCEL 日历总矩阵"视图：以横向 31 天为列、纵向食材为行的大宽表形式展示每日数量/单价/金额，并在表底汇总每日与全月开销。
 */

import React, { useRef } from "react";
import { FoodCategory, PreparedItem } from "../../types/types.ts";
import { PrepReportService } from "../../services/store.ts";
import { RawMaterialsDictService } from "../../services/rawMaterialDict.ts";
import { getItemMonthlySummary } from "../../utils.ts";

/**
 * @description TableGridMatrixView 组件入参接口
 */
interface TableGridMatrixViewProps {
  /** 当月包含的日期数组 (["1", "2", ..., "31"]) */
  days: string[];
  /** 经过筛选与台账对齐后的备餐明细项列表 */
  filteredItems: PreparedItem[];
  /** 每个日期(1-31号)在该类目下的总开销汇总 */
  dayTotals: Record<string, number>;
  /** 当前激活的食材二级分类 */
  selectedCategory: FoodCategory | null;
  /** 是否使用全新实线黑边绿底样式，为false则使用经典色块样式 */
  useNewStyle?: boolean;
}

/**
 * @description EXCEL 日历总矩阵大宽表视图组件
 */
export function TableGridMatrixView({
  days,
  filteredItems,
  dayTotals,
  selectedCategory,
  useNewStyle = true
}: TableGridMatrixViewProps) {
  /** @description 左右拖拽滚动的容器引用 */
  const containerRef = useRef<HTMLDivElement>(null);
  /** @description 是否处于鼠标按下拖拽中 */
  const isDownRef = useRef<boolean>(false);
  /** @description 鼠标按下时的初始横向坐标 */
  const startXRef = useRef<number>(0);
  /** @description 鼠标按下时的初始滚动位置 */
  const scrollLeftRef = useRef<number>(0);

  /**
   * @description 处理鼠标按下事件，初始化拖拽滚动
   * @param e 鼠标事件
   */
  const handleMouseDown = (e: React.MouseEvent) => {
    // 仅响应鼠标左键按下
    if (e.button !== 0) return;

    // 避免在按钮、输入框等交互元素上触发拖拽
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("input") || target.closest("select") || target.closest("a")) {
      return;
    }

    if (!containerRef.current) return;
    isDownRef.current = true;
    containerRef.current.classList.remove("cursor-grab");
    containerRef.current.classList.add("cursor-grabbing");
    startXRef.current = e.pageX - containerRef.current.offsetLeft;
    scrollLeftRef.current = containerRef.current.scrollLeft;
  };

  /**
   * @description 处理鼠标离开容器事件，终止拖拽
   */
  const handleMouseLeave = () => {
    isDownRef.current = false;
    if (containerRef.current) {
      containerRef.current.classList.remove("cursor-grabbing");
      containerRef.current.classList.add("cursor-grab");
    }
  };

  /**
   * @description 处理鼠标抬起事件，终止拖拽
   */
  const handleMouseUp = () => {
    isDownRef.current = false;
    if (containerRef.current) {
      containerRef.current.classList.remove("cursor-grabbing");
      containerRef.current.classList.add("cursor-grab");
    }
  };

  /**
   * @description 处理鼠标移动事件，按拖动偏移更新滚动位置
   * @param e 鼠标事件
   */
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDownRef.current || !containerRef.current) return;
    e.preventDefault();
    const x = e.pageX - containerRef.current.offsetLeft;
    // 1.5倍滚动灵敏度系数
    const walk = (x - startXRef.current) * 1.5;
    containerRef.current.scrollLeft = scrollLeftRef.current - walk;
  };

  return (
    // 去掉 resize-x，改用固定外框与鼠标左右拖拽滚动
    <div className="overflow-hidden w-full select-none">
      <p className="text-[11px] text-gray-400 mb-1.5 select-none">提示：可在下方的表格区域内按住鼠标左右拖动查看不同日期的明细数据</p>
      <div className="bg-white rounded-2xl border border-gray-100 shadow-xs overflow-hidden">
        <div
          ref={containerRef}
          onMouseDown={handleMouseDown}
          onMouseLeave={handleMouseLeave}
          onMouseUp={handleMouseUp}
          onMouseMove={handleMouseMove}
          className="overflow-x-auto scrollbar-thin scrollbar-thumb-gray-200 scrollbar-track-transparent cursor-grab active:cursor-grabbing"
        >
          <table className={`w-full border-collapse text-left text-[13px] text-gray-500 ${useNewStyle ? "matrix-table" : ""}`}>
            <thead className="text-[12px] font-semibold">
              {/* 一级头: 日期编号 */}
              <tr className={useNewStyle ? "bg-[#75BD42] text-white" : "bg-slate-50 text-slate-800 border-b-2 border-black"}>
                <th className={`p-3 sticky left-0 z-20 min-w-[124px] ${useNewStyle ? "border border-black bg-[#75BD42]" : "border-r-2 border-black bg-slate-100"}`}>日期/品类</th>
                {days.map((day) => {
                  return (
                    <th
                      key={`col-day-${day}`}
                      colSpan={3}
                      className={`px-2 py-1.5 text-center ${useNewStyle ? "border border-black" : "border-r-2 border-black"}`}
                    >
                      <div className="flex items-center justify-center">
                        <span>{day}号</span>
                      </div>
                    </th>
                  );
                })}
                <th colSpan={2} className={`p-3 text-center font-extrabold ${useNewStyle ? "border border-black" : "border-b-2 border-l-2 border-black"}`}>全月累加</th>
              </tr>

              {/* 二级头: [数量/单价/金额] 三胞胎 */}
              <tr className={useNewStyle ? "bg-[#75BD42] text-white text-[11px] font-bold" : "bg-slate-100 text-[11px] text-slate-700 font-bold border-b-2 border-black"}>
                <th className={`p-2.5 sticky left-0 z-20 ${useNewStyle ? "border border-black bg-[#75BD42]" : "border-r-2 border-black bg-slate-200"}`}>食材细分项目</th>
                {days.map((day) => {
                  const isOdd = parseInt(day, 10) % 2 !== 0;
                  return (
                    <React.Fragment key={`sub-dt-${day}`}>
                      <th className={`px-1.5 py-1 text-center whitespace-nowrap font-semibold ${useNewStyle ? "border border-black" : "border-b-2 border-r border-slate-300"}`}>数量</th>
                      <th className={`px-1.5 py-1 text-center whitespace-nowrap font-semibold ${useNewStyle ? "border border-black" : "border-b-2 border-r border-slate-300"}`}>单价</th>
                      <th className={`px-1.5 py-1 text-center whitespace-nowrap font-black ${useNewStyle ? "border border-black" : `border-b-2 border-r-2 border-black ${isOdd ? "bg-amber-200 text-amber-950" : "bg-teal-200 text-teal-950"}`}`}>金额</th>
                    </React.Fragment>
                  );
                })}
                <th className={`p-2 text-center font-bold ${useNewStyle ? "border border-black" : "border-b-2 border-r-2 border-black bg-slate-100 text-slate-800"}`}>月总用量</th>
                <th className={`p-2 text-center font-black ${useNewStyle ? "border border-black" : "border-b-2 border-r-2 border-black text-indigo-900 bg-indigo-100"}`}>月总开销</th>
              </tr>
            </thead>

            <tbody className={useNewStyle ? "" : "divide-y-2 divide-black"}>
              {filteredItems.map((item) => {
                const monthlySummary = getItemMonthlySummary(item, days);
                return (
                  <tr key={item.id} className={`hover:bg-slate-50 transition-colors ${useNewStyle ? "" : "border-b-2 border-black"}`}>

                    {/* 粘性冷冻首列：细分菜名，高负荷滑动不丢失行上下文 */}
                    <td className={`px-3 py-1.5 sticky left-0 z-10 font-extrabold group/cell min-w-[150px] shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)] ${useNewStyle ? "bg-[#75BD42] border border-black text-black" : "bg-white border-r-2 border-black text-slate-900"}`}>
                      <span className="truncate max-w-[110px] text-[13px] font-bold" title={item.name}>
                        {(() => {
                          const dictItem = RawMaterialsDictService.getItems().find(d => d.name === item.name);
                          const displayName = dictItem ? dictItem.name : item.name;
                          const displayUnit = dictItem ? dictItem.unit : item.unit;
                          const displayRemark = dictItem?.remark || "";
                          return (
                            <>
                              <span className={`text-[13px] font-black ${useNewStyle ? "text-black" : "text-slate-900"}`}>{displayName}</span>
                              <span className={`text-[11px] font-bold block mt-0.5 ${useNewStyle ? "text-black" : "text-slate-600"}`}>
                                单位: {displayUnit} {displayRemark && `(${displayRemark})`}
                              </span>
                            </>
                          );
                        })()}
                      </span>
                    </td>

                    {/* 渲染31天每日录入小卡格 */}
                    {days.map((day) => {
                      const entry = item.dailyData[day] || { quantity: 0, price: 0, amount: 0 };
                      const isOdd = parseInt(day, 10) % 2 !== 0;
                      return (
                        <React.Fragment key={`cell-${item.id}-${day}`}>
                          <td className={`px-2 py-1 min-w-[48px] text-center font-mono text-[13px] font-semibold text-slate-900 ${useNewStyle ? "border border-black bg-white" : `border-b-2 border-r border-slate-300 ${isOdd ? "bg-amber-50" : "bg-teal-50"}`}`}>
                            {entry.quantity || ""}
                          </td>
                          <td className={`px-2 py-1 min-w-[48px] text-center font-mono text-[13px] font-semibold text-slate-900 ${useNewStyle ? "border border-black bg-white" : `border-b-2 border-r border-slate-300 ${isOdd ? "bg-amber-100/50" : "bg-teal-100/50"}`}`}>
                            {entry.price ? `¥${entry.price}` : ""}
                          </td>
                          <td className={`px-2 py-1 min-w-[56px] text-center text-[13px] font-black font-mono ${useNewStyle ? "border border-black bg-green-200 text-green-950" : `border-b-2 border-r-2 border-black ${isOdd ? "bg-amber-200/50 text-amber-950" : "bg-teal-200/50 text-teal-950"}`}`}>
                            {entry.amount > 0 ? `¥${entry.amount}` : ""}
                          </td>
                        </React.Fragment>
                      );
                    })}

                    {/* 全月累加列 */}
                    <td className={`p-2.5 text-center font-black font-mono text-[13px] text-slate-900 ${useNewStyle ? "border border-black bg-white" : "border-r-2 border-black bg-slate-100/60"}`}>
                      {monthlySummary.totalQty || ""} {monthlySummary.totalQty ? item.unit : ""}
                    </td>
                    <td className={`p-2.5 text-center font-black font-mono text-[13px] ${useNewStyle ? "border border-black bg-green-100/50 text-green-900" : "text-indigo-950 bg-indigo-100/50"}`}>
                      {monthlySummary.totalCost ? `¥${monthlySummary.totalCost}` : ""}
                    </td>

                  </tr>
                );
              })}

              {/* 表底累加汇总：各单日大类整体耗资 */}
              <tr className={`font-extrabold text-slate-900 ${useNewStyle ? "bg-gray-100 border-t-2 border-black" : "bg-slate-200 border-t-2 border-black"}`}>
                <td className={`px-3 py-1.5 sticky left-0 font-black shadow-[2px_0_5px_-2px_rgba(0,0,0,0.15)] text-[13px] ${useNewStyle ? "bg-[#75BD42] text-black border border-black" : "bg-slate-200 text-slate-900 border-r-2 border-black"}`}>
                  【{PrepReportService.getActiveCategories().find(c => c.key === selectedCategory)?.label || selectedCategory}】每日开支合计
                </td>
                {days.map((day) => {
                  const isOdd = parseInt(day, 10) % 2 !== 0;
                  return (
                    <React.Fragment key={`tot-cell-${day}`}>
                      <td colSpan={2} className={`px-1 py-3 text-[11px] text-slate-500 text-center font-bold uppercase whitespace-nowrap ${useNewStyle ? "border border-black bg-white" : `border-r border-slate-300 ${isOdd ? "bg-amber-50" : "bg-teal-50"}`}`}>合计金额:</td>
                      <td className={`px-1 py-3 text-center text-[13px] font-black font-mono ${useNewStyle ? "border border-black bg-green-100 text-green-950" : `border-r-2 border-black ${isOdd ? "bg-amber-200 text-amber-950" : "bg-teal-200 text-teal-950"}`}`}>
                        {dayTotals[day] > 0 ? `¥${dayTotals[day]}` : ""}
                      </td>
                    </React.Fragment>
                  );
                })}
                <th colSpan={2} className={`p-3 text-center font-black text-[13px] ${useNewStyle ? "border border-black bg-green-200/50 text-green-950" : "text-indigo-950 bg-indigo-200/50"}`}>
                  {Math.round(Object.values(dayTotals).reduce((s, v) => s + v, 0) * 100) / 100 > 0 ? `¥${Math.round(Object.values(dayTotals).reduce((s, v) => s + v, 0) * 100) / 100}` : ""}
                </th>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
