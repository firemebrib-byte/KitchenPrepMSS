/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 台账"购销总表"（样式一）纯净打印模板：以食品原材料购销总表格式排版全部原料的当日出入库明细，供物理打印或留档使用。
 */

import { Ledger, LedgerItem } from "../../types/ledgerTypes.ts";
import { FoodCategory } from "../../types/types.ts";
import { LEDGER_PRINT_STYLE1_CONFIG } from "../../constants/ledgerConstants.ts";
import { resolveLedgerItemCategory } from "../../constants/constants.ts";

/**
 * @description 购销总表打印预览模板组件入参接口
 */
interface LedgerPrintStyle1Props {
  /** 当前选中的台账 */
  activeLedger: Ledger | null;
  /** 选定的日期 */
  selectedDate: string;
  /** 勾选的分类 */
  selectedPrintCategories: FoodCategory[];
  /** 当前台账的全部原料项 */
  currentLedgerItems: LedgerItem[];
  /** 从字典服务获取的所有原料项目快照 */
  dictItems: any[];
  customDataRows: number;
}

/** 数据行行高（数值形式，用于计算跨行合并单元格的总高度） */
const DATA_ROW_HEIGHT_PX = parseFloat(LEDGER_PRINT_STYLE1_CONFIG.dataRowHeight);

/**
 * @description 【图一】购销总表打印预览模板组件 (样式一)
 */
export function LedgerPrintStyle1({
  activeLedger,
  selectedDate,
  selectedPrintCategories,
  currentLedgerItems,
  dictItems,
  customDataRows
}: LedgerPrintStyle1Props) {
  // 根据用户勾选的二级分类过滤打印原料，并且只保留在"选定日期当天"实际发生过入库或出库的原料——
  // currentLedgerItems 是本台账历史上出现过的全部原料名录（一旦某原料被加入台账就会一直留在名录里），
  // 若只按分类过滤，会把该分类下"曾经采购过但当天毫无动静"的原料也当作空白行打印出来，
  // 导致登记总表看起来像是把整个分类的全部历史原料都列了出来，而非当天真实发生的记账内容
  const toPrintItems = currentLedgerItems.filter((item) => {
    // [字典与台账解耦] 分类走 item.category 快照，字典查不到归“未分类”；只有勾选了对应大类才打印。
    const cat = resolveLedgerItemCategory(item, (n) => dictItems.find(d => d.name === n)?.category ?? null);
    if (!selectedPrintCategories.includes(cat)) return false;
    const record = item.dailyRecords[selectedDate];
    return !!record && (record.inQuantity > 0 || record.outQuantity > 0);
  });

  const rowsPerPage = customDataRows;
  const pages: Array<typeof toPrintItems> = [];
  if (toPrintItems.length === 0) {
    pages.push([]);
  } else {
    for (let i = 0; i < toPrintItems.length; i += rowsPerPage) {
      pages.push(toPrintItems.slice(i, i + rowsPerPage));
    }
  }
  const totalPages = pages.length;

  /**
   * @description 渲染合并单元格内的多行文本，内容定位在单元格纵向前 1/3 处（而非居中），便于跨行阅读定位
   */
  const renderMergedCell = (values: string[], mergedCellHeightPx: number, maxChars: number = 8) => {
    if (values.length === 0) return "";
    return (
      <div
        className="flex flex-col items-center gap-0.5"
        style={{ height: `${mergedCellHeightPx}px`, paddingTop: `${mergedCellHeightPx / 5}px`, boxSizing: "border-box" }}
      >
        {values.map((v, i) => {
          const fs = v.length > maxChars ? "11px" : LEDGER_PRINT_STYLE1_CONFIG.dataFontSize;
          const lh = v.length > maxChars ? "1.2" : "normal";
          return <div key={i} style={{ fontSize: fs, lineHeight: lh }}>{v}</div>;
        })}
      </div>
    );
  };

  return (
    <div
      style={{
        fontFamily: LEDGER_PRINT_STYLE1_CONFIG.fontFamily,
        fontSize: LEDGER_PRINT_STYLE1_CONFIG.dataFontSize,
        color: "#000",
        // 左右两侧各收回 6mm，在当前打印容器边距基础上腾出装订空间
        marginLeft: "6mm",
        marginRight: "6mm"
      }}
      className="text-center"
    >
      {/* 提取共有样式至全局 */}
      <style>{`
        .ledger-print-style1-table, .ledger-print-style1-table th, .ledger-print-style1-table td {
          border: 1px solid #000000 !important;
        }
        .ledger-print-style1-table thead th {
          background-color: #ffffff !important;
        }
        @media print {
          .ledger-print-style1-table, .ledger-print-style1-table th, .ledger-print-style1-table td {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
            border-color: #000000 !important;
          }
        }
        .ledger-print-style1-table td {
          word-break: break-all !important;
          white-space: normal !important;
        }
        @page {
          margin: 12mm 18mm;
        }
      `}</style>
      {pages.map((pageItems, pageIndex) => {
        const isLastPage = pageIndex === totalPages - 1;
        const filledCount = pageItems.length;
        const emptyRowsCount = Math.max(0, rowsPerPage - filledCount);
        const totalRows = Math.max(rowsPerPage, filledCount + emptyRowsCount);
        const mergedCellHeightPx = totalRows * DATA_ROW_HEIGHT_PX;

        const getUniqueFieldValues = (extractor: (record: any) => string) => {
          const list = toPrintItems.map(item => {
            const record = item.dailyRecords[selectedDate];
            return record ? extractor(record) : "";
          }).filter(Boolean);
          return Array.from(new Set(list));
        };

        const suppliers = getUniqueFieldValues(r => r.supplier || "");
        const purchaseDates = getUniqueFieldValues(r => {
          if (!(r.inQuantity > 0)) return "";
          const base = r.purchaseDate || selectedDate;
          const d = new Date(`${base}T00:00:00`);
          d.setDate(d.getDate() - 1);
          const yyyy = d.getFullYear();
          const mm = String(d.getMonth() + 1).padStart(2, "0");
          const dd = String(d.getDate()).padStart(2, "0");
          return `${yyyy}-${mm}-${dd}`;
        });
        const buyers = getUniqueFieldValues(r => r.buyer || "");
        const inspectors = getUniqueFieldValues(r => r.inspector || "");
        const inDates = getUniqueFieldValues(r => r.inQuantity > 0 ? (r.purchaseDate || selectedDate) : "");
        const outDates = getUniqueFieldValues(r => r.outQuantity > 0 ? (r.outDate || selectedDate) : "");
        const keepers = getUniqueFieldValues(r => r.keeper || "");

        return (
          <div key={pageIndex}>
            <div style={{ position: "relative" }}>
              <table className="w-full border-collapse mb-0" style={{ tableLayout: "fixed" }}>
                <tbody>
                  <tr>
                    <td style={{ border: "none", padding: "12px 0 4px", textAlign: "center" }}>
                      <div style={{ fontSize: LEDGER_PRINT_STYLE1_CONFIG.titleFontSize, fontWeight: "bold", textDecoration: "underline" }}>
                        {LEDGER_PRINT_STYLE1_CONFIG.titlePrefix}
                      </div>
                      <div style={{ fontSize: LEDGER_PRINT_STYLE1_CONFIG.subtitleFontSize, marginTop: "2px" }}>
                        {activeLedger?.name || ""}
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>

              <table className="ledger-print-style1-table w-full border-collapse text-center" style={{ tableLayout: "fixed" }}>
                <colgroup>
                  <col style={{ width: "8%" }} />
                  <col style={{ width: "8%" }} />
                  <col style={{ width: "6%" }} />
                  <col style={{ width: "16%" }} />
                  <col style={{ width: "16%" }} />
                  <col style={{ width: "8%" }} />
                  <col style={{ width: "8%" }} />
                  <col style={{ width: "8%" }} />
                  <col style={{ width: "7%" }} />
                  <col style={{ width: "7%" }} />
                  <col style={{ width: "8%" }} />
                </colgroup>

                <thead>
                  <tr className=" bg-white" style={{ fontSize: LEDGER_PRINT_STYLE1_CONFIG.headerFontSize }}>
                    <th rowSpan={2} className="border border-black px-1 py-2 align-middle">原材料<br />名称</th>
                    <th rowSpan={2} className="border border-black px-1 py-2 align-middle">数量</th>
                    <th rowSpan={2} className="border border-black px-1 py-2 align-middle">食品<br />索证</th>
                    <th rowSpan={2} className="border border-black px-1 py-2 align-middle">感官性状</th>
                    <th rowSpan={2} className="border border-black px-1 py-2 align-middle">供货商<br />及地址</th>
                    <th rowSpan={2} className="border border-black px-1 py-2 align-middle">采购时间</th>
                    <th rowSpan={2} className="border border-black px-1 py-2 align-middle">采购员</th>
                    <th rowSpan={2} className="border border-black px-1 py-2 align-middle">检验员</th>
                    <th colSpan={2} className="border border-black px-1 py-1 align-middle">出入库时间</th>
                    <th rowSpan={2} className="border border-black px-1 py-2 align-middle">保管员</th>
                  </tr>
                  <tr className=" bg-white" style={{ fontSize: LEDGER_PRINT_STYLE1_CONFIG.headerFontSize }}>
                    <th className="border border-black px-1 py-1 align-middle">入库</th>
                    <th className="border border-black px-1 py-1 align-middle">出库</th>
                  </tr>
                </thead>

                <tbody>
                  {pageItems.length === 0 ? (
                    /* 当无明细时，至少渲染 15 行空行，并且后 7 列合并为一个大空单元格 */
                    Array.from({ length: customDataRows }).map((_, i) => (
                      <tr key={`empty-all-${i}`} style={{ height: LEDGER_PRINT_STYLE1_CONFIG.dataRowHeight, fontSize: LEDGER_PRINT_STYLE1_CONFIG.dataFontSize }}>
                        <td className="border border-black"></td>
                        <td className="border border-black"></td>
                        <td className="border border-black"></td>
                        <td className="border border-black"></td>
                        {i === 0 && (
                          <>
                            <td className="border border-black align-middle" rowSpan={customDataRows}></td>
                            <td className="border border-black align-middle" rowSpan={customDataRows}></td>
                            <td className="border border-black align-middle" rowSpan={customDataRows}></td>
                            <td className="border border-black align-middle" rowSpan={customDataRows}></td>
                            <td className="border border-black align-middle" rowSpan={customDataRows}></td>
                            <td className="border border-black align-middle" rowSpan={customDataRows}></td>
                            <td className="border border-black align-middle" rowSpan={customDataRows}></td>
                          </>
                        )}
                      </tr>
                    ))
                  ) : (
                    <>
                      {pageItems.map((item, idx) => {
                        const record = item.dailyRecords[selectedDate] || {
                          inQuantity: 0, inPrice: 0, inAmount: 0, outQuantity: 0,
                          certification: "", sensoryProperty: "", supplier: "",
                          purchaseDate: "", buyer: "", inspector: "", keeper: "", outDate: ""
                        };

                        const isFirstRow = idx === 0;

                        // 数量列：优先展示换算后的数量与换算单位，无换算配置时展示原始数量与默认单位
                        const dictItem = dictItems.find(d => d.name === item.name);
                        const hasConversion = !!(dictItem && dictItem.conversionUnit && dictItem.conversionRatio);
                        const displayUnit = hasConversion ? dictItem.conversionUnit : (dictItem?.unit || item.unit);
                        const displayQty = record.inQuantity > 0
                          ? (hasConversion ? Number((record.inQuantity * dictItem.conversionRatio).toFixed(2)) : record.inQuantity)
                          : "";

                        const nameFontSize = item.name.length > 5 ? "11px" : LEDGER_PRINT_STYLE1_CONFIG.dataFontSize;
                        const nameLineHeight = item.name.length > 5 ? "1.2" : "normal";
                        const cert = record.certification || "";
                        const certFontSize = cert.length > 4 ? "11px" : LEDGER_PRINT_STYLE1_CONFIG.dataFontSize;
                        const certLineHeight = cert.length > 4 ? "1.2" : "normal";
                        const sensory = record.sensoryProperty || "";
                        const sensoryFontSize = sensory.length > 10 ? "11px" : LEDGER_PRINT_STYLE1_CONFIG.dataFontSize;
                        const sensoryLineHeight = sensory.length > 10 ? "1.2" : "normal";

                        return (
                          <tr key={item.id} style={{ height: LEDGER_PRINT_STYLE1_CONFIG.dataRowHeight, fontSize: LEDGER_PRINT_STYLE1_CONFIG.dataFontSize }}>
                            <td className="border border-black px-1 py-1 text-center" style={{ fontSize: nameFontSize, lineHeight: nameLineHeight }}>{item.name}</td>
                            <td className="border border-black px-1 py-1">
                              {displayQty !== "" ? `${displayQty}${displayUnit}` : ""}
                            </td>
                            <td className="border border-black px-1 py-1" style={{ fontSize: certFontSize, lineHeight: certLineHeight }}>{cert}</td>
                            <td className="border border-black px-1 py-1" style={{ fontSize: sensoryFontSize, lineHeight: sensoryLineHeight }}>{sensory}</td>
                            {isFirstRow && (
                              <>
                                <td className="border border-black px-1 py-1 text-center align-top" rowSpan={totalRows}>
                                  {renderMergedCell(suppliers, mergedCellHeightPx, 10)}
                                </td>
                                <td className="border border-black px-1 py-1  align-top" rowSpan={totalRows}>
                                  {renderMergedCell(purchaseDates, mergedCellHeightPx, 8)}
                                </td>
                                <td className="border border-black px-1 py-1 align-top" rowSpan={totalRows}>
                                  {renderMergedCell(buyers, mergedCellHeightPx, 5)}
                                </td>
                                <td className="border border-black px-1 py-1 align-top" rowSpan={totalRows}>
                                  {renderMergedCell(inspectors, mergedCellHeightPx, 5)}
                                </td>
                                <td className="border border-black px-1 py-1  align-top" rowSpan={totalRows}>
                                  {renderMergedCell(inDates, mergedCellHeightPx, 8)}
                                </td>
                                <td className="border border-black px-1 py-1  align-top" rowSpan={totalRows}>
                                  {renderMergedCell(outDates, mergedCellHeightPx, 8)}
                                </td>
                                <td className="border border-black px-1 py-1 align-top" rowSpan={totalRows}>
                                  {renderMergedCell(keepers, mergedCellHeightPx, 5)}
                                </td>
                              </>
                            )}
                          </tr>
                        );
                      })}

                      {/* 补充空行，只渲染前 4 列，后 7 列由首行 rowSpan 覆盖 */}
                      {Array.from({ length: emptyRowsCount }).map((_, i) => (
                        <tr key={`empty-${i}`} style={{ height: LEDGER_PRINT_STYLE1_CONFIG.dataRowHeight, fontSize: LEDGER_PRINT_STYLE1_CONFIG.dataFontSize }}>
                          <td className="border border-black"></td>
                          <td className="border border-black"></td>
                          <td className="border border-black"></td>
                          <td className="border border-black"></td>
                          {pageItems.length === 0 && i === 0 && (
                            <>
                              <td className="border border-black align-middle" rowSpan={totalRows}></td>
                              <td className="border border-black align-middle" rowSpan={totalRows}></td>
                              <td className="border border-black align-middle" rowSpan={totalRows}></td>
                              <td className="border border-black align-middle" rowSpan={totalRows}></td>
                              <td className="border border-black align-middle" rowSpan={totalRows}></td>
                              <td className="border border-black align-middle" rowSpan={totalRows}></td>
                              <td className="border border-black align-middle" rowSpan={totalRows}></td>
                            </>
                          )}
                        </tr>
                      ))}
                    </>
                  )}
                </tbody>
              </table>
            </div>
            {!isLastPage && <div style={{ breakAfter: "page", pageBreakAfter: "always", height: 0, overflow: "hidden" }}></div>}
          </div>
        );
      })}
    </div>
  );
}
