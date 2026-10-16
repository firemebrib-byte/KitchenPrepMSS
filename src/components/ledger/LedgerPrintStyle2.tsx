/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 台账"单原料日流水"（样式二）纯净打印模板：以单个原料为单位排版其在选定时间段内的逐日出入库流水，供物理打印或留档使用。
 */

import { Ledger, LedgerItem } from "../../types/ledgerTypes.ts";
import { LEDGER_PRINT_STYLE2_CONFIG } from "../../constants/ledgerConstants.ts";
import { RawMaterialsDictService } from "../../services/rawMaterialDict.ts";
import { computeLedgerDailyStockBalances } from "../../utils.ts";
import { LedgerPrintStyle2Consumable } from "./LedgerPrintStyle2Consumable.tsx";

/**
 * @description 单原料日流水打印入参接口
 */
interface LedgerPrintStyle2Props {
  /** 当前选中的台账 */
  activeLedger: Ledger | null;
  /** 当前焦点的原料项目 ID */
  activeItemId: string;
  /** 选定的日期 */
  selectedDate: string;
  /** 全量原料列表数据 */
  ledgerItems: LedgerItem[];
  /** 采购时间段 - 开始日期 */
  style2StartDate: string;
  /** 采购时间段 - 结束日期 */
  style2EndDate: string;
  /** 生成的期间每一天的日期字符串数组 */
  style2DatesArray: string[];
  /** 自定义补充空白行数 */
  customDataRows: number;
}

/**
 * @description 【图二】单原料自定义日期段流水卡片打印预览模板组件 (样式二)
 */
export function LedgerPrintStyle2({
  activeLedger,
  activeItemId,
  selectedDate,
  ledgerItems,
  style2StartDate,
  style2EndDate,
  style2DatesArray,
  customDataRows
}: LedgerPrintStyle2Props) {
  const activeItem = ledgerItems.find((i) => i.id === activeItemId);
  if (!activeItem) {
    return <div className="text-center p-12 text-slate-400">请先在系统里选择需要打印的单原料明细。</div>;
  }

  // 所选采购项目属于"低耗品"大类时，改用贴合纸质消耗品台账格式的专属打印模板，不与其余大类共用本样式
  const dictItem = RawMaterialsDictService.getItems().find((d) => d.name === activeItem.name);
  if (dictItem?.category === "LOW_CONSUMP") {
    return (
      <LedgerPrintStyle2Consumable
        activeLedger={activeLedger}
        activeItem={activeItem}
        style2StartDate={style2StartDate}
        style2EndDate={style2EndDate}
        style2DatesArray={style2DatesArray}
        customDataRows={customDataRows}
      />
    );
  }

  // 提取有记录的供货商作为本单打印头部显示
  const sampleRecord = Object.entries(activeItem.dailyRecords).find(
    ([, rec]) => rec.supplier || rec.certification
  )?.[1] || { supplier: "", certification: "" };

  const recordForSelectedDate = activeItem.dailyRecords[selectedDate] || ({} as any);
  const printSupplier = recordForSelectedDate.supplier || sampleRecord.supplier || "宾县鑫百达百货超市";
  const printCert = recordForSelectedDate.certification || sampleRecord.certification || "";

  // 采购数量列：优先展示换算后的数量与换算单位，无换算配置时展示原始数量与默认单位
  const hasConversion = !!(dictItem && dictItem.conversionUnit && dictItem.conversionRatio);
  const displayUnit = hasConversion ? dictItem!.conversionUnit : (dictItem?.unit || activeItem.unit);

  // 当日结余库存：锚定在“真实当前库存”（基于服务端全历史累计的 historicalTotalIn/Out）上，不再从
  // “早于 style2StartDate 的内存 dailyRecords”反推期初——跨月/跨区间打印时那些更早的记录会被按月懒加载
  // 排除，导致结余算成错误的负数（见 utils.ts computeLedgerDailyStockBalances）。
  const stockByDay = computeLedgerDailyStockBalances(activeItem, style2DatesArray);

  const activeDays = style2DatesArray.map((dStr) => {
    const record = activeItem.dailyRecords[dStr];
    const hasActivity = record && ((record.inQuantity || 0) > 0 || (record.outQuantity || 0) > 0);
    return { dStr, record, hasActivity };
  }).filter(d => d.hasActivity && d.record);

  const rowsPerPage = customDataRows;
  const pages: Array<typeof activeDays> = [];
  if (activeDays.length === 0) {
    pages.push([]);
  } else {
    for (let i = 0; i < activeDays.length; i += rowsPerPage) {
      pages.push(activeDays.slice(i, i + rowsPerPage));
    }
  }

  const totalPages = pages.length;

  return (
    <div
      style={{
        fontFamily: LEDGER_PRINT_STYLE2_CONFIG.fontFamily,
        fontSize: LEDGER_PRINT_STYLE2_CONFIG.dataFontSize,
        color: "#000",
        marginLeft: "6mm",
        marginRight: "6mm"
      }}
      className="text-center"
    >
      {/* 提取共有样式至全局，避免每页重复定义 */}
      <style>{`
        .ledger-print-style2-table, .ledger-print-style2-table th, .ledger-print-style2-table td {
          border: 1px solid #000000 !important;
        }
        .ledger-print-style2-table thead th {
          background-color: #ffffff !important;
        }
        /* 强制允许换行，超出长度时在渲染节点内动态缩小字号 */
        .ledger-print-style2-table td {
          word-break: break-all !important;
          white-space: normal !important;
        }
        @media print {
          .ledger-print-style2-table, .ledger-print-style2-table th, .ledger-print-style2-table td {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
            border-color: #000000 !important;
          }
        }
        @page {
          margin: 12mm 18mm;
        }
      `}</style>

      {pages.map((pageData, pageIndex) => {
        const isLastPage = pageIndex === totalPages - 1;
        const emptyRowsCount = Math.max(0, rowsPerPage - pageData.length);

        const nameText = activeItem.name || "";
        const nameFontSize = nameText.length > 10 ? "11px" : "inherit";
        const nameLineHeight = nameText.length > 10 ? "1.2" : "normal";

        const suppText = printSupplier || "";
        const suppFontSize = suppText.length > 20 ? "11px" : "inherit";
        const suppLineHeight = suppText.length > 20 ? "1.2" : "normal";

        const certText = printCert || "";
        const certFontSize = certText.length > 17 ? "11px" : "inherit";
        const certLineHeight = certText.length > 17 ? "1.2" : "normal";

        return (
          <div key={pageIndex}>
            <div style={{ position: "relative" }}>
            {/* 标题区：标题+日期作为一个整体块居中摆放 */}
            <div className="mb-3 relative" style={{ display: "flex", justifyContent: "center" }}>
              <div className="text-left">
                <div style={{ fontSize: LEDGER_PRINT_STYLE2_CONFIG.titleFontSize, fontWeight: "bold" }} className="tracking-widest">
                  {LEDGER_PRINT_STYLE2_CONFIG.titlePrefix}
                </div>
                {/* 日期与受众副标题同一行 */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: "2px" }}>
                  <div style={{ fontSize: LEDGER_PRINT_STYLE2_CONFIG.dateFontSize, fontWeight: "bold", marginLeft: "28px" }}>
                    日期：（  {style2StartDate} 至 {style2EndDate}  ）
                  </div>
                  <div style={{ fontSize: LEDGER_PRINT_STYLE2_CONFIG.subtitleFontSize, whiteSpace: "nowrap", marginRight: "52px" }}>
                    {activeLedger?.name || ""}
                  </div>
                </div>
              </div>
              {/* 多页时显示页码，位于左下角 */}
              {totalPages > 1 && (
                <div style={{ position: "absolute", left: 0, bottom: "2px", fontSize: "12px", color: "#444" }}>
                  第 {pageIndex + 1} / {totalPages} 页
                </div>
              )}
            </div>

            <table className="ledger-print-style2-table w-full text-center border-collapse mb-6" style={{ tableLayout: "fixed" }}>
              <colgroup>
                <col style={{ width: "8%" }} />
                <col style={{ width: "7%" }} />
                <col style={{ width: "7%" }} />
                <col style={{ width: "8%" }} />
                <col style={{ width: "6%" }} />
                <col style={{ width: "13%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "5%" }} />
                <col style={{ width: "5%" }} />
                <col style={{ width: "25%" }} />
              </colgroup>

              <thead style={{ fontSize: LEDGER_PRINT_STYLE2_CONFIG.headerFontSize }}>
                {/* 表头第一行：基础信息 */}
                <tr style={{ height: "28px" }}>
                  <th colSpan={2} className="border border-black px-1 bg-white whitespace-nowrap">采购项目</th>
                  <th colSpan={2} className="border border-black px-1 text-center" style={{ fontSize: nameFontSize, lineHeight: nameLineHeight }}>{nameText}</th>
                  <th colSpan={1} className="border border-black px-1 bg-white whitespace-nowrap">经销商</th>
                  <th colSpan={2} className="border border-black px-1 font-normal text-center" style={{ fontSize: suppFontSize, lineHeight: suppLineHeight }}>{suppText}</th>
                  <th colSpan={2} className="border border-black px-1 bg-white whitespace-nowrap">索证索票</th>
                  <th colSpan={1} className="border border-black px-1 font-normal text-center" style={{ fontSize: certFontSize, lineHeight: certLineHeight }}>{certText}</th>
                </tr>

                {/* 表头第二行：大分类（入库/出库） */}
                <tr style={{ height: "24px" }} className="bg-white ">
                  <th colSpan={7} className="border border-black">入库</th>
                  <th colSpan={3} className="border border-black">出库</th>
                </tr>

                {/* 表头第三行：明细列头 */}
                <tr style={{ height: "24px" }} className="bg-white ">
                  <th className="border border-black">日期</th>
                  <th className="border border-black">
                    <div>采购</div>
                    <div>数量</div>
                  </th>
                  <th className="border border-black">采购员</th>
                  <th className="border border-black">
                    <div>生产</div>
                    <div>日期</div>
                  </th>
                  <th className="border border-black">保质期</th>
                  <th className="border border-black">感官性状</th>
                  <th className="border border-black">检验员</th>
                  <th className="border border-black">
                    <div>出库</div>
                    <div>数量</div>
                  </th>
                  <th className="border border-black">
                    <div>当日</div>
                    <div>库存</div>
                  </th>
                  <th className="border border-black">保管员</th>
                </tr>
              </thead>

              <tbody>
                {pageData.map(({ dStr, record }) => {
                  const balance = stockByDay[dStr];
                  // 数量显示逻辑：配置了换算单位则计算换算后数值，否则使用原始数值
                  const displayQty = record!.inQuantity > 0
                    ? (hasConversion ? Number((record!.inQuantity * dictItem!.conversionRatio!).toFixed(2)) : record!.inQuantity)
                    : "";
                  const displayOutQty = record!.outQuantity > 0 
                    ? (hasConversion ? Number((record!.outQuantity * dictItem!.conversionRatio!).toFixed(2)) : record!.outQuantity)
                    : "";
                  const displayBalance = hasConversion ? Number((balance * dictItem!.conversionRatio!).toFixed(2)) : balance;

                  const buyer = record!.buyer || "";
                  const buyerFontSize = buyer.length > 4 ? "11px" : LEDGER_PRINT_STYLE2_CONFIG.dataFontSize;
                  const buyerLineHeight = buyer.length > 4 ? "1.2" : "normal";

                  const shelfLife = record!.shelfLife || "";
                  const shelfFontSize = shelfLife.length > 4 ? "11px" : LEDGER_PRINT_STYLE2_CONFIG.dataFontSize;
                  const shelfLineHeight = shelfLife.length > 4 ? "1.2" : "normal";

                  const sensory = record!.sensoryProperty || "";
                  const sensoryFontSize = sensory.length > 9 ? "11px" : LEDGER_PRINT_STYLE2_CONFIG.dataFontSize;
                  const sensoryLineHeight = sensory.length > 9 ? "1.2" : "normal";

                  const inspector = record!.inspector || "";
                  const inspectorFontSize = inspector.length > 11 ? "11px" : LEDGER_PRINT_STYLE2_CONFIG.dataFontSize;
                  const inspectorLineHeight = inspector.length > 11 ? "1.2" : "normal";

                  const keeper = record!.keeper || "";
                  const keeperFontSize = keeper.length > 17 ? "11px" : LEDGER_PRINT_STYLE2_CONFIG.dataFontSize;
                  const keeperLineHeight = keeper.length > 17 ? "1.2" : "normal";

                  return (
                    <tr key={dStr} style={{ height: "28px", fontSize: LEDGER_PRINT_STYLE2_CONFIG.dataFontSize }}>
                      <td className="border border-black  ">{dStr}</td>
                      <td className="border border-black ">{displayQty !== "" ? `${displayQty}${displayUnit}` : ""}</td>
                      <td className="border border-black" style={{ fontSize: buyerFontSize, lineHeight: buyerLineHeight }}>{buyer}</td>
                      <td className="border border-black  ">{record!.produceDate || ""}</td>
                      <td className="border border-black " style={{ fontSize: shelfFontSize, lineHeight: shelfLineHeight }}>{shelfLife}</td>
                      <td className="border border-black" style={{ fontSize: sensoryFontSize, lineHeight: sensoryLineHeight }}>{sensory}</td>
                      <td className="border border-black" style={{ fontSize: inspectorFontSize, lineHeight: inspectorLineHeight }}>{inspector}</td>
                      <td className="border border-black ">{displayOutQty !== "" ? `${displayOutQty}${displayUnit}` : ""}</td>
                      <td className="border border-black  ">{displayBalance}{displayUnit}</td>
                      <td className="border border-black" style={{ fontSize: keeperFontSize, lineHeight: keeperLineHeight }}>{keeper}</td>
                    </tr>
                  );
                })}
                
                {Array.from({ length: emptyRowsCount }).map((_, i) => (
                  <tr key={`empty-${i}`} style={{ height: "28px", fontSize: LEDGER_PRINT_STYLE2_CONFIG.dataFontSize }}>
                    {Array.from({ length: 10 }).map((_, j) => (
                      <td key={j} className="border border-black"></td>
                    ))}
                  </tr>
                ))}
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
