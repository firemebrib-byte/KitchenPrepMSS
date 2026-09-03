/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 台账打印前的二级分类勾选控制弹窗：允许用户在打印总表前选择需要包含的食材大类范围。
 */

import { Printer, X } from "lucide-react";
import { FoodCategory } from "../../types/types.ts";
import { PrepReportService } from "../../services/store.ts";
import { UNCATEGORIZED_CATEGORY_KEY, UNCATEGORIZED_CATEGORY_LABEL } from "../../constants/constants.ts";

/** 打印勾选弹窗里可选的大类（6 个默认大类 + “未分类”兜底桶） */
const PRINTABLE_CATEGORY_KEYS = [
  "VEGETABLE", "GRAIN_OIL", "SEASONING", "MEAT", "LOW_CONSUMP", "FRUIT", UNCATEGORIZED_CATEGORY_KEY
];

interface LedgerPrintModalProps {
  isOpen: boolean;
  selectedPrintCategories: FoodCategory[];
  setSelectedPrintCategories: (cats: FoodCategory[]) => void;
  setPrintPreviewStyle: (style: "style1" | "style2") => void;
  printableCategories: Set<FoodCategory>;
  onClose: () => void;
}

export function LedgerPrintModal({
  isOpen,
  selectedPrintCategories,
  setSelectedPrintCategories,
  setPrintPreviewStyle,
  printableCategories,
  onClose
}: LedgerPrintModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-[999] p-4">
      <div className="bg-white rounded-2xl shadow-xl border border-slate-100 max-w-md w-full p-6 space-y-4">
        <div className="flex justify-between items-center border-b border-slate-100 pb-3">
          <h3 className="text-sm font-black text-slate-800 flex items-center gap-1.5">
            <Printer size={16} className="text-slate-600" />
            <span>选择要打印的二级分类数据</span>
          </h3>
          <button 
            onClick={onClose} 
            className="text-slate-400 hover:text-slate-600 cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <span className="text-[11px] text-slate-400 font-bold uppercase tracking-wider">二级食材分类范围</span>
            <div className="flex gap-2 text-[10px] font-bold">
              <button
                type="button"
                onClick={() => setSelectedPrintCategories(
                  PRINTABLE_CATEGORY_KEYS.filter((cat) => printableCategories.has(cat))
                )}
                className="text-emerald-600 hover:text-emerald-700 underline cursor-pointer"
              >
                全选
              </button>
              <span className="text-slate-200">|</span>
              <button 
                type="button"
                onClick={() => setSelectedPrintCategories([])}
                className="text-rose-600 hover:text-rose-700 underline cursor-pointer"
              >
                清空
              </button>
            </div>
          </div>

          {/* 多选勾选区 */}
          <div className="grid grid-cols-2 gap-3 py-2">
            {[
              { key: "VEGETABLE", label: PrepReportService.getActiveCategories().find(c => c.key === "VEGETABLE")?.label || "VEGETABLE", color: "accent-green-600" },
              { key: "GRAIN_OIL", label: PrepReportService.getActiveCategories().find(c => c.key === "GRAIN_OIL")?.label || "GRAIN_OIL", color: "accent-amber-600" },
              { key: "SEASONING", label: PrepReportService.getActiveCategories().find(c => c.key === "SEASONING")?.label || "SEASONING", color: "accent-orange-600" },
              { key: "MEAT", label: PrepReportService.getActiveCategories().find(c => c.key === "MEAT")?.label || "MEAT", color: "accent-red-600" },
              { key: "LOW_CONSUMP", label: PrepReportService.getActiveCategories().find(c => c.key === "LOW_CONSUMP")?.label || "LOW_CONSUMP", color: "accent-slate-600" },
              { key: "FRUIT", label: PrepReportService.getActiveCategories().find(c => c.key === "FRUIT")?.label || "FRUIT", color: "accent-pink-600" },
              { key: UNCATEGORIZED_CATEGORY_KEY, label: UNCATEGORIZED_CATEGORY_LABEL, color: "accent-gray-500" }
            ].map((item) => {
              const isChecked = selectedPrintCategories.includes(item.key);
              const isPrintable = printableCategories.has(item.key);
              return (
                <label
                  key={item.key}
                  className={`flex items-center gap-2.5 p-2.5 rounded-lg border select-none transition-all ${
                    !isPrintable
                      ? "border-slate-100 text-slate-300 opacity-50 cursor-not-allowed"
                      : isChecked
                      ? "bg-slate-50 border-slate-300 font-bold text-slate-800 cursor-pointer"
                      : "border-slate-100 text-slate-400 hover:bg-slate-50/50 cursor-pointer"
                  }`}
                  title={isPrintable ? undefined : "本台账暂无该大类的采购原料，无内容可打印"}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    disabled={!isPrintable}
                    onChange={() => {
                      if (isChecked) {
                        setSelectedPrintCategories(selectedPrintCategories.filter(c => c !== item.key));
                      } else {
                        setSelectedPrintCategories([...selectedPrintCategories, item.key]);
                      }
                    }}
                    className={`w-3.5 h-3.5 ${item.color} ${isPrintable ? "cursor-pointer" : "cursor-not-allowed"}`}
                  />
                  <span className="text-xs">{item.label}{!isPrintable ? "（无数据）" : ""}</span>
                </label>
              );
            })}
          </div>

          <div className="text-[10px] text-slate-400 font-bold leading-normal bg-slate-50 p-2.5 rounded-lg border border-slate-100/50">
            ⚠️ 提示：系统将为您在登记总表预览中，过滤并排版展示属于以上已选定大类的台账明细，多选分类支持同时合并在一张表格中输出。
          </div>

          <div className="flex gap-2 pt-2">
            <button 
              onClick={() => {
                onClose();
                setPrintPreviewStyle("style1");
              }}
              disabled={selectedPrintCategories.length === 0}
              className="flex-1 py-2 bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white font-bold text-xs rounded-lg transition-colors cursor-pointer text-center font-bold"
            >
              预览登记总表
            </button>
            <button 
              onClick={onClose}
              className="flex-1 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs rounded-lg transition-colors cursor-pointer text-center font-bold"
            >
              取消
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
