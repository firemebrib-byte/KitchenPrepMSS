/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 台账打印预览的遮罩层容器：根据当前选定的打印样式（总表/单原料流水）渲染 LedgerPrintStyle1 或 LedgerPrintStyle2 对应的纯净打印模板。
 */

import { AlertCircle } from "lucide-react";
import { Ledger, LedgerItem } from "../../types/ledgerTypes.ts";
import { FoodCategory } from "../../types/types.ts";
import { RawMaterialsDictService } from "../../services/rawMaterialDict.ts";
import { createPortal } from "react-dom";
import { LedgerPrintStyle1 } from "./LedgerPrintStyle1.tsx";
import { LedgerPrintStyle2 } from "./LedgerPrintStyle2.tsx";
import { LedgerPrintStyle3Purchase } from "./LedgerPrintStyle3Purchase.tsx";

interface LedgerPrintPreviewOverlayProps {
  printPreviewStyle: "style1" | "style2" | "style3";
  setPrintPreviewStyle: (val: null | "style1" | "style2" | "style3") => void;
  activeLedger: Ledger | null;
  selectedDate: string;
  selectedPrintCategories: FoodCategory[];
  currentLedgerItems: LedgerItem[];
  activeItemId: string;
  ledgerItems: LedgerItem[];
  style2StartDate: string;
  style2EndDate: string;
  style2DatesArray: string[];
  customDataRows: number;
  setCustomDataRows: (val: number) => void;
}

export function LedgerPrintPreviewOverlay({
  printPreviewStyle,
  setPrintPreviewStyle,
  activeLedger,
  selectedDate,
  selectedPrintCategories,
  currentLedgerItems,
  activeItemId,
  ledgerItems,
  style2StartDate,
  style2EndDate,
  style2DatesArray,
  customDataRows,
  setCustomDataRows
}: LedgerPrintPreviewOverlayProps) {
  const isPrintStyle1 = printPreviewStyle === "style1";
  const isPrintStyle2 = printPreviewStyle === "style2";
  const isPrintStyle3 = printPreviewStyle === "style3";
  const dictItems = RawMaterialsDictService.getItems();

  return createPortal(
    <div className="ledger-print-preview-overlay fixed inset-0 bg-white z-[9999] overflow-auto p-8 font-sans text-black leading-relaxed">
      <style>{`
        @media print {
          #root {
            display: none !important;
          }
          .ledger-print-preview-overlay {
            position: static !important;
            overflow: visible !important;
            height: auto !important;
            max-height: none !important;
            padding: 0 !important;
            box-sizing: border-box !important;
          }
        }
      `}</style>
      {/* 顶部退出预览条 */}
      <div className="mb-6 flex flex-col md:flex-row justify-between items-start md:items-center border-b border-gray-200 pb-4 gap-4 print:hidden">
        <span className="text-sm text-gray-600 flex items-center gap-2 shrink-0">
          <AlertCircle size={16} className="text-amber-500" />
          <span className="font-bold">【打印预览模式】确认无误后请点击右侧“立即打印”。</span>
        </span>
        <div className="flex gap-4 items-center">
          <div className="flex items-center gap-2">
            <label className="text-[11px] font-bold text-slate-500 whitespace-nowrap">补充空白数据行数</label>
            <div className="flex items-center bg-slate-50 border border-slate-200 rounded overflow-hidden">
              <button
                className="px-2.5 py-1 text-xs hover:bg-slate-200 cursor-pointer text-slate-600 font-bold transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={() => setCustomDataRows(Math.max(2, customDataRows - 1))}
                disabled={customDataRows <= 2}
              >-</button>
              <div className="w-8 text-center text-xs text-slate-800 font-bold">{customDataRows}</div>
              <button
                className="px-2.5 py-1 text-xs hover:bg-slate-200 cursor-pointer text-slate-600 font-bold transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={() => setCustomDataRows(Math.min(40, customDataRows + 1))}
                disabled={customDataRows >= 40}
              >+</button>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => window.print()}
              className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded shadow cursor-pointer transition-all"
            >
              立即打印
            </button>
            <button
              onClick={() => setPrintPreviewStyle(null)}
              className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold rounded shadow cursor-pointer transition-all"
            >
              返回系统
            </button>
          </div>
        </div>
      </div>

      {isPrintStyle1 && (
        <LedgerPrintStyle1
          activeLedger={activeLedger}
          selectedDate={selectedDate}
          selectedPrintCategories={selectedPrintCategories}
          currentLedgerItems={currentLedgerItems}
          dictItems={dictItems}
          customDataRows={customDataRows}
        />
      )}
      
      {isPrintStyle2 && (
        <LedgerPrintStyle2
          activeLedger={activeLedger}
          activeItemId={activeItemId}
          selectedDate={selectedDate}
          /* 样式二按“采购流水时间段筛选”(style2StartDate~style2EndDate) 打印单个原料的逐日流水，
             取料必须用未按 selectedDate 过滤的 currentLedgerItems —— 若沿用 ledgerItems(=sortedFilteredLedgerItems，
             仅含在 selectedDate 当天有记录的原料)，当聚焦原料在时间段内有出入库、但恰好在 selectedDate 当天没有记录时，
             会被过滤掉导致找不到 activeItem，预览错误地提示“请先选择需要打印的单原料明细”。 */
          ledgerItems={currentLedgerItems}
          style2StartDate={style2StartDate}
          style2EndDate={style2EndDate}
          style2DatesArray={style2DatesArray}
          customDataRows={customDataRows}
        />
      )}

      {isPrintStyle3 && (
        <LedgerPrintStyle3Purchase
          activeLedger={activeLedger}
          selectedDate={selectedDate}
          ledgerItems={ledgerItems}
          customDataRows={customDataRows}
        />
      )}
    </div>,
    document.body
  );
}
