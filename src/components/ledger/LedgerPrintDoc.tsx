/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 台账出入库凭证单的纯净打印模板组件：按食品行业规范排版出库登记表，供物理打印或导出留档使用。
 */

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Ledger } from "../../types/ledgerTypes.ts";
import { RawMaterialsDictService } from "../../services/rawMaterialDict.ts";
import { AlertCircle } from "lucide-react";
import { PrepReportService } from "../../services/store.ts";
import { FoodCategory } from "../../types/types.ts";
import { LEDGER_PRINT_OUT_CONFIG } from "../../constants/ledgerConstants.ts";

/**
 * @description 打印凭证组件入参接口
 */
interface LedgerPrintDocProps {
  /** 打印单据类型: "in" | "out" */
  printDocType: "in" | "out";
  /** 当前选定台账 */
  activeLedger: Ledger | null;
  /** 选定日期 */
  selectedDate: string;
  /** 当日有入库变动明细 */
  dailyInwardItems: any[];
  /** 当日有出库变动明细 */
  dailyOutwardItems: any[];
  /** 今日总入库金额 */
  dailyInTotalAmount: number;
  /** 关闭预览回调 */
  onClose: () => void;
  customDataRows: number;
  setCustomDataRows: (val: number) => void;
  customSupplierRows: number;
  setCustomSupplierRows: (val: number) => void;
}

/**
 * @description 入库单打印模板内容组件
 */
function PrintInDoc({
  activeLedger,
  selectedDate,
  dailyInwardItems,
  dailyInTotalAmount,
  customDataRows
}: {
  activeLedger: Ledger | null;
  selectedDate: string;
  dailyInwardItems: any[];
  dailyInTotalAmount: number;
  customDataRows: number;
}) {
  return (
    <>
      {/* 凭证大标题 */}
      <div className="text-center mb-6">
        <h2 className="text-2xl font-black tracking-widest border-b-2 border-black pb-2 inline-block">
          {activeLedger?.name}台账 —— 原料入库单
        </h2>
        <div className="flex justify-between text-xs mt-3 px-1">
          <span>日期：<strong className="underline">{selectedDate}</strong></span>
          <span>台账类别：<strong className="underline">{activeLedger?.name}</strong></span>
          <span>单据编号：<strong className="underline ">NO.{selectedDate.replace(/-/g, "")}01</strong></span>
        </div>
      </div>

      {/* 凭证明细表格 */}
      <table className="w-full text-left border-collapse border border-black text-xs mb-8">
        <thead>
          <tr className="bg-gray-100 text-center">
            <th className="border border-black px-2 py-2.5 w-12 ">序号</th>
            <th className="border border-black px-3 py-2.5 ">食品原材料品名</th>
            <th className="border border-black px-3 py-2.5 ">规格描述</th>
            <th className="border border-black px-2 py-2.5 w-16 ">单位</th>
            <th className="border border-black px-3 py-2.5 w-24 ">今日入库数</th>
            <th className="border border-black px-3 py-2.5 w-24 ">单价(元)</th>
            <th className="border border-black px-3 py-2.5 w-28 ">金额(元)</th>
            <th className="border border-black px-3 py-2.5 w-24 ">发料出库人</th>
            <th className="border border-black px-3 py-2.5 w-24 ">接收领料人</th>
            <th className="border border-black px-3 py-2.5 w-20 ">食品索证</th>
            <th className="border border-black px-3 py-2.5 w-20 ">感官性状</th>
            <th className="border border-black px-3 py-2.5 ">备注说明/去处</th>
          </tr>
        </thead>
        <tbody>
          {dailyInwardItems.length === 0 ? (
            <tr>
              <td colSpan={12} className="border border-black text-center py-6 text-gray-500 italic">
                今日无入库数据记录
              </td>
            </tr>
          ) : (
            dailyInwardItems.map((item, index) => (
              <tr key={item.id} className="hover:bg-white text-center">
                <td className="border border-black px-2 py-2 ">{index + 1}</td>
                <td className="border border-black px-3 py-2 text-left ">
                  {RawMaterialsDictService.getItems().find(d => d.name === item.name)?.name ?? item.name}
                </td>
                <td className="border border-black px-3 py-2 text-left">
                  {RawMaterialsDictService.getItems().find(d => d.name === item.name)?.remark || item.spec || ""}
                </td>
                <td className="border border-black px-2 py-2">
                  {RawMaterialsDictService.getItems().find(d => d.name === item.name)?.unit ?? item.unit}
                </td>
                <td className="border border-black px-3 py-2 text-right  ">{item.record.inQuantity}</td>
                <td className="border border-black px-3 py-2 text-right ">¥{item.record.inPrice.toFixed(2)}</td>
                <td className="border border-black px-3 py-2 text-right  ">¥{item.record.inAmount.toFixed(2)}</td>
                <td className="border border-black px-3 py-2">{item.record.outHandler || item.record.buyer || ""}</td>
                <td className="border border-black px-3 py-2">{item.record.outRecipient || item.record.inspector || ""}</td>
                <td className="border border-black px-3 py-2">{item.record.certification || ""}</td>
                <td className="border border-black px-3 py-2">{item.record.sensoryProperty || ""}</td>
                <td className="border border-black px-3 py-2 text-left">{item.record.note || ""}</td>
              </tr>
            ))
          )}

          {/* 入库单合计行 */}
          {dailyInwardItems.length > 0 && (
            <tr className="bg-white">
              <td colSpan={5} className="border border-black px-3 py-2.5  text-center">合计金额 (大写)：{new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(dailyInTotalAmount)}</td>
              <td colSpan={1} className="border border-black px-3 py-2.5  text-right">小写合计:</td>
              <td className="border border-black px-3 py-2.5 text-right  font-black text-sm text-red-600">
                ¥{dailyInTotalAmount.toFixed(2)}
              </td>
              <td colSpan={5} className="border border-black px-3 py-2"></td>
            </tr>
          )}
        </tbody>
      </table>

      {/* 入库单签章栏 */}
      <div className="grid grid-cols-3 gap-4 text-xs mt-12 px-2">
        <div><span>主管审核签字：____________________</span></div>
        <div className="text-center"><span>出库发料人签字：____________________</span></div>
        <div className="text-right"><span>接收领料人签字：____________________</span></div>
      </div>
    </>
  );
}

/**
 * @description 按每页固定行数(rowsPerPage)对品类分组做贪心装箱分页：品类组整体不跨页拆分（组内条目一律移到下一页），
 * 仅当单个品类组自身条目数就超过整页容量时才在组内部拆分并标记续页(continued)——这种极端情况在当前原料字典规模下基本不会触发，
 * 但仍需正确处理避免死循环或数据丢失。
 */
function paginateGroupedItems(
  groups: Array<{ categoryLabel: string; items: Array<{ item: any; rowIndex: number }> }>,
  rowsPerPage: number
): Array<Array<{ categoryLabel: string; items: Array<{ item: any; rowIndex: number }>; continued: boolean }>> {
  const pages: Array<Array<{ categoryLabel: string; items: Array<{ item: any; rowIndex: number }>; continued: boolean }>> = [];
  let currentPage: Array<{ categoryLabel: string; items: Array<{ item: any; rowIndex: number }>; continued: boolean }> = [];
  let currentRows = 0;

  groups.forEach((group) => {
    let remainingItems = group.items;
    let isFirstSlice = true;

    while (remainingItems.length > 0) {
      const spaceLeft = rowsPerPage - currentRows;

      if (remainingItems.length <= spaceLeft) {
        // 当前页容得下整组（或该组尚未渲染的剩余部分）
        currentPage.push({ categoryLabel: group.categoryLabel, items: remainingItems, continued: !isFirstSlice });
        currentRows += remainingItems.length;
        remainingItems = [];
      } else if (currentRows === 0) {
        // 当前页是全新空页，但整组仍放不下一整页——单组行数超过整页容量的兜底分支，此时才允许组内拆分
        const slice = remainingItems.slice(0, rowsPerPage);
        currentPage.push({ categoryLabel: group.categoryLabel, items: slice, continued: !isFirstSlice });
        remainingItems = remainingItems.slice(rowsPerPage);
        pages.push(currentPage);
        currentPage = [];
        currentRows = 0;
        isFirstSlice = false;
      } else {
        // 当前页已有内容且放不下整组剩余部分——整组（不拆分）移到下一页
        pages.push(currentPage);
        currentPage = [];
        currentRows = 0;
      }
    }
  });

  if (currentPage.length > 0 || pages.length === 0) {
    pages.push(currentPage);
  }

  return pages;
}

/**
 * @description 新版出库单打印模板内容组件（按图片样式：按品类合并行展示；[V5.73.0] 支持超出单页容量时自动分页续排）
 */
function PrintOutDoc({
  activeLedger,
  selectedDate,
  dailyOutwardItems,
  customDataRows,
  customSupplierRows
}: {
  activeLedger: Ledger | null;
  selectedDate: string;
  dailyOutwardItems: any[];
  customDataRows: number;
  customSupplierRows: number;
}) {
  /**
   * @description 按食品大类对出库条目进行分组，并匹配对应的品类中文标签
   */
  const groupedByCategory: Array<{
    categoryLabel: string;
    items: Array<{ item: any; rowIndex: number }>;
  }> = [];

  // 统计每个 category 的所有原料条目
  const categoryMap = new Map<string, any[]>();
  dailyOutwardItems.forEach(item => {
    const dictItem = RawMaterialsDictService.getItems().find(d => d.name === item.name);
    const catKey = dictItem?.category ?? "其他";
    if (!categoryMap.has(catKey)) {
      categoryMap.set(catKey, []);
    }
    categoryMap.get(catKey)!.push(item);
  });

  let globalIndex = 1;
  // 按照 FoodCategory 枚举顺序排列输出，保证类别顺序稳定
  const categoryOrder = [
    "VEGETABLE",
    "GRAIN_OIL",
    "SEASONING",
    "MEAT",
    "LOW_CONSUMP",
    "FRUIT"
  ];

  categoryOrder.forEach(catKey => {
    const items = categoryMap.get(catKey);
    if (items && items.length > 0) {
      const dynamicLabel = PrepReportService.getActiveCategories().find(c => c.key === catKey)?.label;
      groupedByCategory.push({
        categoryLabel: dynamicLabel || catKey,
        items: items.map(item => ({ item, rowIndex: globalIndex++ }))
      });
    }
  });

  // 还有不在枚举里的分类（兜底）
  categoryMap.forEach((items, catKey) => {
    if (!categoryOrder.includes(catKey as FoodCategory)) {
      groupedByCategory.push({
        categoryLabel: String(catKey),
        items: items.map(item => ({ item, rowIndex: globalIndex++ }))
      });
    }
  });

  // ==== 分页：出库单表格每页固定 customDataRows 行，超出部分按品类整体移到下一页（[V5.73.0]） ====
  const rowsPerPage = customDataRows;
  const rowPages = groupedByCategory.length > 0 ? paginateGroupedItems(groupedByCategory, rowsPerPage) : [];

  // ==== 日期解析：自动填入完整年月日 ====
  const dateParts = selectedDate.split("-");
  const printYear = dateParts[0] || "";
  /** 去掉前缀零的月份，如 "06" → "6" */
  const printMonth = dateParts[1] ? String(parseInt(dateParts[1])) : "";
  /** 去掉前缀零的日期，如 "01" → "1" */
  const printDay = dateParts[2] ? String(parseInt(dateParts[2])) : "";

  // ==== 动态供货商提取：将每个出库条目对应的供货商按名称分组，并汇总每个供货商负责的二级品类 ====
  /**
   * @description supplierToCategoriesMap: key=供货商名称, value=该供货商对应的所有出库原料所属二级品类标签列表
   */
  const supplierToCategoriesMap = new Map<string, string[]>();

  dailyOutwardItems.forEach(item => {
    // 仅读取当日出库记录中的供货商字段，不回落扫描历史记录
    const supplier: string = item.record.supplier || "";

    // 没有供货商信息的条目跳过
    if (!supplier) return;

    // 只展示原料所属的二级品类，不展示具体原料名称
    const dictItem = RawMaterialsDictService.getItems().find(d => d.name === item.name);
    if (!dictItem) return;
    const dynamicLabel = PrepReportService.getActiveCategories().find(c => c.key === dictItem.category)?.label;
    const catLabel = dynamicLabel || dictItem.category;

    if (!supplierToCategoriesMap.has(supplier)) {
      supplierToCategoriesMap.set(supplier, []);
    }
    const existingCategories = supplierToCategoriesMap.get(supplier)!;
    if (!existingCategories.includes(catLabel)) {
      existingCategories.push(catLabel);
    }
  });

  /**
   * @description 将供货商映射表转换为打印行文本数组
   * 格式： 供货商：【供货商名称】（二级品类1、二级品类2…）
   */
  const dynamicSupplierLines: string[] = [];
  supplierToCategoriesMap.forEach((catLabels, supplierName) => {
    dynamicSupplierLines.push(`供货商：${supplierName}（${catLabels.join("、")}）`);
  });

  // ==== 供货商信息分页：首页容量动态伸缩，超出部分另起续页（[V5.77.1]） ====
  const isPlaceholderSuppliers = dynamicSupplierLines.length === 0;
  const supplierDisplayLines = isPlaceholderSuppliers
    ? Array.from({ length: customSupplierRows }, () => "")
    : dynamicSupplierLines;
  const maxSuppliersPerPage = customSupplierRows;
  const maxCapacity = rowsPerPage + maxSuppliersPerPage;

  // 获取最后一页的已用记录行数（如果是空表，则已用行数为 0）
  const lastRowPage = rowPages[rowPages.length - 1];
  const rowsUsedOnLastPage = lastRowPage ? lastRowPage.reduce((sum, g) => sum + g.items.length, 0) : 0;

  // 首个供货商块能容纳的数量：最大极限容量 - 已使用的记录行数（最少为 maxSuppliersPerPage）
  const firstChunkCapacity = Math.max(maxSuppliersPerPage, maxCapacity - rowsUsedOnLastPage);

  const supplierChunks: string[][] = [];
  let remainingSuppliers = supplierDisplayLines;

  if (remainingSuppliers.length > 0) {
    supplierChunks.push(remainingSuppliers.slice(0, firstChunkCapacity));
    remainingSuppliers = remainingSuppliers.slice(firstChunkCapacity);
  } else {
    supplierChunks.push([]);
  }

  // 剩余的供货商放入纯续页，纯续页全是供货商，理论上可以放满满载容量 maxCapacity
  while (remainingSuppliers.length > 0) {
    supplierChunks.push(remainingSuppliers.slice(0, maxCapacity));
    remainingSuppliers = remainingSuppliers.slice(maxCapacity);
  }

  const firstSupplierChunk = supplierChunks[0];
  const extraSupplierChunks = supplierChunks.slice(1);

  // 总页数：行数据表页数（当日无数据时仍固定展示 1 页空表）+ 供货商续页数
  const totalPages = Math.max(rowPages.length, 1) + extraSupplierChunks.length;

  /**
   * @description 渲染每一页顶部重复的标题+日期栏；总页数大于 1 时额外展示"第 N / 共 M 页"，供货商续页额外标注
   */
  const renderTitleBlock = (pageIndex: number, isSupplierContinuationPage: boolean) => (
    <table className="w-full border-collapse mb-2" style={{ tableLayout: "fixed" }}>
      <tbody>
        <tr>
          <td className="py-2 px-0 text-center relative" style={{ border: "none" }}>
            <div>
              <span style={{ fontSize: LEDGER_PRINT_OUT_CONFIG.outDocTitleFontSize, fontWeight: "bold" }}>
                {LEDGER_PRINT_OUT_CONFIG.outDocTitle}
              </span>
              <span style={{ fontSize: LEDGER_PRINT_OUT_CONFIG.outDocSubTitleFontSize, fontWeight: "bold" }}>
                （{activeLedger?.name}{isSupplierContinuationPage ? "·供货商续页" : ""}）
              </span>
            </div>
            <div
              style={{
                position: "absolute",
                right: "4em",
                bottom: "2px",
                fontSize: LEDGER_PRINT_OUT_CONFIG.outDocSubTitleFontSize,
                fontWeight: "bold"
              }}
            >
              {printYear}年{printMonth}月{printDay}日
            </div>
            {totalPages > 1 && (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  bottom: "2px",
                  fontSize: LEDGER_PRINT_OUT_CONFIG.outDocSubTitleFontSize,
                  fontWeight: "normal",
                  color: "#444"
                }}
              >
                第 {pageIndex + 1} / {totalPages} 页
              </div>
            )}
          </td>
        </tr>
      </tbody>
    </table>
  );

  /**
   * @description 渲染底部供货商信息栏；无真实供货商数据时展示灰色占位提示文案（保持原有行为不变）
   */
  const renderSupplierFooter = (lines: string[]) => (
    <div className="mt-2 text-black leading-6" style={{ fontSize: LEDGER_PRINT_OUT_CONFIG.outDocDataFontSize }}>
      {lines.map((line, i) => (
        <div key={i} className={isPlaceholderSuppliers ? "text-gray-400" : undefined}>
          {isPlaceholderSuppliers ? `${line}（请在出库记录中填写对应供货商）` : line}
        </div>
      ))}
    </div>
  );

  /**
   * @description 每页内容外层容器：除首页外，打印时强制插入分页符另起一页（page-break，含新旧两种 CSS 属性兜底浏览器兼容性）；
   * 屏幕预览（非打印态）下额外展示浅色分页提示，方便操作员在打印前确认断页位置
   */
  const renderPageWrapper = (pageIndex: number, children: ReactNode) => (
    <div
      key={`print-page-${pageIndex}`}
      style={{
        breakBefore: pageIndex === 0 ? "auto" : "page",
        pageBreakBefore: pageIndex === 0 ? "auto" : "always"
      }}
    >
      {pageIndex > 0 && (
        <div className="print:hidden text-center text-[11px] text-gray-400 my-3 select-none">
          －－－ 以下另起第 {pageIndex + 1} 页打印 －－－
        </div>
      )}
      {children}
    </div>
  );

  /** 主表格固定列宽 colgroup + 表头，各页共用，避免重复书写导致后续调整列宽时遗漏某一页 */
  const renderTableHead = () => (
    <>
      <colgroup>
        <col style={{ width: "14%" }} />
        <col style={{ width: "8%" }} />
        <col style={{ width: "19%" }} />
        <col style={{ width: "11%" }} />
        <col style={{ width: "24%" }} />
        <col style={{ width: "24%" }} />
      </colgroup>
      <thead>
        <tr className="bg-white text-center " style={{ height: "42px", fontSize: LEDGER_PRINT_OUT_CONFIG.outDocHeaderFontSize }}>
          <th className="border border-black px-1">类别</th>
          <th className="border border-black px-1">序号</th>
          <th className="border border-black px-1">品名</th>
          <th className="border border-black px-1">数量</th>
          <th className="border border-black px-1">出库人</th>
          <th className="border border-black px-1">接收人</th>
        </tr>
      </thead>
    </>
  );

  return (
    <div style={{ fontFamily: LEDGER_PRINT_OUT_CONFIG.outDocFontFamily, fontSize: LEDGER_PRINT_OUT_CONFIG.outDocDataFontSize, color: "#000", marginLeft: "6mm", marginRight: "6mm" }}>
      {/* 线框颜色/粗细通过下方 <style> 强制统一为纯黑细线，避免打印时因子像素反锯齿呈现偏蓝色调、粗细不一，与图一/图二打印样式保持一致；
          同时声明 A4 纸张与页边距，配合各页容器的强制分页符，保证内容行数/供货商条数超出单页容量时完整续排到下一页，不再被物理纸张边缘截断 */}
      <style>{`
        .ledger-print-out-table, .ledger-print-out-table th, .ledger-print-out-table td {
          border: 1px solid #000000 !important;
        }
        @page {
          size: A4;
        }
          /* 干掉 index.html 的表头全局灰色 */
.ledger-print-doc-overlay thead th {
  background-color: #ffffff !important;
}
        /* 强制允许换行，超出长度时在渲染节点内动态缩小字号 */
        .ledger-print-out-table td {
          word-break: break-all !important;
          white-space: normal !important;
        }
        @media print {
          .ledger-print-out-table, .ledger-print-out-table th, .ledger-print-out-table td {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
            border-color: #000000 !important;
          }
        }
      `}</style>

      {rowPages.length === 0 ? (
        // 当日无任何出库数据：保持原有单页空表展示（不涉及分页），仅在末尾追加供货商信息栏
        renderPageWrapper(0, (
          <>
            {renderTitleBlock(0, extraSupplierChunks.length > 0)}
            <table className="ledger-print-out-table w-full border-collapse" style={{ tableLayout: "fixed" }}>
              {renderTableHead()}
              <tbody>
                {(() => {
                  const emptyRowCount = Math.max(0, customDataRows + customSupplierRows - firstSupplierChunk.length);
                  return Array.from({ length: emptyRowCount }).map((_, i) => (
                    <tr key={`empty-all-${i}`} style={{ height: LEDGER_PRINT_OUT_CONFIG.outDocDataRowHeight, fontSize: LEDGER_PRINT_OUT_CONFIG.outDocDataFontSize }} className="text-center">
                      {i === 0 ? (
                        <>
                          <td className="border border-black" rowSpan={emptyRowCount}>-</td>
                          <td className="border border-black"></td>
                          <td className="border border-black"></td>
                          <td className="border border-black"></td>
                          <td className="border border-black" rowSpan={emptyRowCount}>-</td>
                          <td className="border border-black" rowSpan={emptyRowCount}>-</td>
                        </>
                      ) : (
                        <>
                          <td className="border border-black"></td>
                          <td className="border border-black"></td>
                          <td className="border border-black"></td>
                        </>
                      )}
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
            {renderSupplierFooter(firstSupplierChunk)}
          </>
        ))
      ) : (
        rowPages.map((pageGroups, pageIndex) => {
          const rowsUsedOnThisPage = pageGroups.reduce((sum, g) => sum + g.items.length, 0);
          const isLastRowPage = pageIndex === rowPages.length - 1;

          // [V5.77.0] 动态计算补全空行：保证记录和供货商在一页内，且供货商恰好置底
          let pageEmptyRowsCount = 0;
          if (isLastRowPage) {
            const suppliersCount = firstSupplierChunk.length;
            const maxCapacity = rowsPerPage + maxSuppliersPerPage;
            pageEmptyRowsCount = Math.max(0, maxCapacity - rowsUsedOnThisPage - suppliersCount);
          } else {
            pageEmptyRowsCount = Math.max(0, rowsPerPage - rowsUsedOnThisPage);
          }

          return renderPageWrapper(pageIndex, (
            <>
              {renderTitleBlock(pageIndex, false)}
              <table className="ledger-print-out-table w-full border-collapse" style={{ tableLayout: "fixed" }}>
                {renderTableHead()}
                <tbody>
                  {/* 按品类分组渲染，类别格、出库人、接收人做 rowSpan 合并（合并范围限定在当前页内这一组的切片行数，不跨页） */}
                  {pageGroups.map((group, groupIdx) => {
                    // [V5.77.0] 提前计算该品类在全天记录中的所有出库人（去重）和接收人（去重），避免跨页时取不到首条记录导致空缺
                    const fullGroup = groupedByCategory.find(g => g.categoryLabel === group.categoryLabel);
                    const itemsSource = fullGroup ? fullGroup.items : group.items;

                    const handlers = Array.from(
                      new Set(
                        itemsSource
                          .map(({ item }) => item.record.outHandler || "")
                          .filter(Boolean)
                      )
                    ).join("、") || "";

                    const recipients = Array.from(
                      new Set(
                        itemsSource
                          .map(({ item }) => item.record.outRecipient || "")
                          .filter(Boolean)
                      )
                    ).join("、") || "";

                    const handlersFontSize = handlers.length > 10 ? "11px" : LEDGER_PRINT_OUT_CONFIG.outDocDataFontSize;
                    const handlersLineHeight = handlers.length > 10 ? "1.2" : "normal";

                    const recipientsFontSize = recipients.length > 15 ? "11px" : LEDGER_PRINT_OUT_CONFIG.outDocDataFontSize;
                    const recipientsLineHeight = recipients.length > 15 ? "1.2" : "normal";

                    return group.items.map(({ item, rowIndex }, idx) => {
                      const isFirstInGroup = idx === 0;
                      const dictItem = RawMaterialsDictService.getItems().find(d => d.name === item.name);
                      const displayName = dictItem?.name ?? item.name;
                      const displayUnit = dictItem?.unit ?? item.unit;

                      /**
                       * @description 判断当前原料是否设置了有效的换算单位与换算比例
                       */
                      const hasConversion = !!(dictItem && dictItem.conversionUnit && dictItem.conversionRatio);
                      /** 优先展示换算单位，若无则展示普通单位 */
                      const displayPrintUnit = hasConversion ? dictItem.conversionUnit : displayUnit;
                      /** 优先展示换算计算后的数量，若无则展示普通出库数量 */
                      const displayPrintQty = (hasConversion && item.record.outQuantity)
                        ? Number((item.record.outQuantity * dictItem.conversionRatio).toFixed(2))
                        : (item.record.outQuantity || "");

                      const nameText = `${displayName}（${displayPrintUnit}）`;
                      const nameFontSize = nameText.length > 8 ? "11px" : LEDGER_PRINT_OUT_CONFIG.outDocDataFontSize;
                      const nameLineHeight = nameText.length > 8 ? "1.2" : "normal";

                      return (
                        <tr key={`${item.id}-p${pageIndex}g${groupIdx}`} style={{ height: LEDGER_PRINT_OUT_CONFIG.outDocDataRowHeight }} className="text-center">
                          {isFirstInGroup && (
                            <td
                              className="border border-black "
                              rowSpan={group.items.length}
                              style={{ verticalAlign: "middle", fontSize: LEDGER_PRINT_OUT_CONFIG.outDocDataFontSize }}
                            >
                              {group.categoryLabel}{group.continued ? "（续）" : ""}
                            </td>
                          )}
                          <td className="border border-black " style={{ fontSize: LEDGER_PRINT_OUT_CONFIG.outDocDataFontSize }}>{rowIndex}</td>
                          <td className="border border-black text-center px-1" style={{ fontSize: nameFontSize, lineHeight: nameLineHeight }}>
                            {nameText}
                          </td>
                          <td className="border border-black  " style={{ fontSize: LEDGER_PRINT_OUT_CONFIG.outDocDataFontSize }}>
                            {displayPrintQty}
                          </td>
                          {isFirstInGroup && (
                            <td
                              className="border border-black "
                              rowSpan={group.items.length}
                              style={{ verticalAlign: "middle", fontSize: handlersFontSize, lineHeight: handlersLineHeight }}
                            >
                              {handlers}
                            </td>
                          )}
                          {isFirstInGroup && (
                            <td
                              className="border border-black "
                              rowSpan={group.items.length}
                              style={{ verticalAlign: "middle", fontSize: recipientsFontSize, lineHeight: recipientsLineHeight }}
                            >
                              {recipients}
                            </td>
                          )}
                        </tr>
                      );
                    });
                  })}

                  {/* 补充空行至本页固定行数 */}
                  {Array.from({ length: pageEmptyRowsCount }).map((_, i) => (
                    <tr key={`empty-${pageIndex}-${i}`} style={{ height: LEDGER_PRINT_OUT_CONFIG.outDocDataRowHeight, fontSize: LEDGER_PRINT_OUT_CONFIG.outDocDataFontSize }}>
                      <td className="border border-black"></td>
                      <td className="border border-black"></td>
                      <td className="border border-black"></td>
                      <td className="border border-black"></td>
                      <td className="border border-black"></td>
                      <td className="border border-black"></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {isLastRowPage && renderSupplierFooter(firstSupplierChunk)}
            </>
          ));
        })
      )}

      {/* 供货商信息超过每页上限时的续页：仅展示标题与剩余供货商信息，不重复行数据表格 */}
      {extraSupplierChunks.map((chunk, chunkIdx) => {
        const pageIndex = Math.max(rowPages.length, 1) + chunkIdx;
        return renderPageWrapper(pageIndex, (
          <>
            {renderTitleBlock(pageIndex, true)}
            {renderSupplierFooter(chunk)}
          </>
        ));
      })}
    </div>
  );
}

/**
 * @description 当日入库单/出库单物理凭证的纯净打印模板组件
 * （出库单采用新版按类别合并行样式；入库单保持原有样式）
 */
export function LedgerPrintDoc({
  printDocType,
  activeLedger,
  selectedDate,
  dailyInwardItems,
  dailyOutwardItems,
  dailyInTotalAmount,
  customDataRows,
  setCustomDataRows,
  customSupplierRows,
  setCustomSupplierRows,
  onClose
}: LedgerPrintDocProps) {
  const isPrintIn = printDocType === "in";

  // 修复分页打印失效问题（根因分两层，缺一不可）：
  // 1) 本组件原先直接嵌在 App 主界面的 DOM 树里（#root 内部），外层还套着好几层 h-screen/overflow-hidden 的布局容器；
  //    这些祖先容器平时不影响它——因为它自身是 position:fixed，视觉上能"跳出"祖先的裁剪覆盖满全屏——但打印引擎在决定
  //    分页范围时，仍然只按它在文档流里"物理所处的那个位置与可用高度"来处理，祖先的 overflow:hidden/固定高度依旧会把
  //    它限制在一屏之内，导致哪怕内部分页符正确，也只有第一页能被打印引擎"看见"。
  // 2) 即使解决了祖先裁剪问题，本容器自身平时也用 position:fixed + overflow:auto 让预览区域能在屏幕上独立滚动——这类
  //    "定高可滚动"容器在打印时同样会被引擎当成一个固定尺寸的单页画框，内部超出可视高度的部分直接被丢弃。
  // 解决方式：用 createPortal 把整个打印预览挂到 document.body 下（彻底跳出 #root 及其所有 overflow-hidden 祖先），
  // 再配合 @media print 规则：打印时把 #root（承载头部导航栏等其余界面）整体隐藏，避免其内容穿透进打印输出；
  // 同时把这个 portal 容器自身在打印时强制退回普通文档流（position:static + overflow:visible + 高度自适应），
  // 使其随多页内容自然撑高，分页符才能在真实的分页布局里生效，多页内容才能完整续排打印。
  // 3) [V5.78.0] 修复"系统预览显示1页，实际打印显示2页"的残留偏差：本容器平时用 p-8（2rem，且会随全局
  //    字号无障碍设置等比放大到 37px/43px）作为屏幕预览的视觉留白，但打印页边距已经由 PrintOutDoc 内部的
  //    `@page { margin: 12mm }` 单独声明——两者叠加相当于每页上下各多出约 64px（字号放大时更多）的重复边距，
  //    恰好蚕食掉"每页 minPrintRows 行 + maxSuppliersPerPage 条供货商"这套行数预算原本预留的余量，导致内容
  //    在物理纸张上比行数预算计算时更容易溢出到下一页。打印时把该容器的上下内边距清零，只保留 @page margin
  //    这一份纵向页边距来源，行数预算与实际物理可用高度才能真正对齐。
  // 4) [V5.80.0] 修复右侧内容贴边溢出问题：上一步把左右内边距也一并清零后，表格横向只剩 @page 的 12mm
  //    页边距兜底，没有任何额外缓冲——不同打印机的硬件不可打印区域往往比 CSS `@page margin` 声明的更大，
  //    导致表格右边缘在真实纸张上出现被裁切/贴边的观感。左右内边距恢复为一个较小的安全值（不使用会随字号
  //    无障碍设置放大的 p-8/rem 单位，改用固定的 mm 物理单位，与 @page margin 的度量方式保持一致），
  //    纵向内边距依旧保持清零，避免重新引入分页行数预算的偏差。
  return createPortal(
    <div className="ledger-print-doc-overlay fixed inset-0 bg-white z-[9999] overflow-auto p-8 font-sans text-black leading-relaxed">
      <style>{`
        @media print {
          #root {
            display: none !important;
          }
          .ledger-print-doc-overlay {
            position: static !important;
            overflow: visible !important;
            height: auto !important;
            max-height: none !important;
            padding: 0 6mm !important;
            box-sizing: border-box !important;
          }
        }
      `}</style>
      {/* 顶部退出预览条（打印时自动隐藏） */}
      <div className="mb-6 flex flex-col md:flex-row justify-between items-start md:items-center border-b border-gray-200 pb-4 gap-4 print:hidden">
        <span className="text-sm text-gray-500 flex items-center gap-1.5 shrink-0">
          <AlertCircle size={16} />
          温馨提示：下方为打印预览，请按 Ctrl + P / Cmd + P 或点击右侧“立即打印”。
        </span>
        <div className="flex gap-4 items-center flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-[11px] font-bold text-slate-500 whitespace-nowrap">补充空白数据行数</label>
            <div className="flex items-center bg-slate-50 border border-slate-200 rounded overflow-hidden">
              <button
                className="px-2.5 py-1 text-xs hover:bg-slate-200 cursor-pointer text-slate-600 font-bold transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={() => setCustomDataRows(Math.max(5, customDataRows - 1))}
                disabled={customDataRows <= 5}
              >-</button>
              <div className="w-8 text-center text-xs text-slate-800 font-bold">{customDataRows}</div>
              <button
                className="px-2.5 py-1 text-xs hover:bg-slate-200 cursor-pointer text-slate-600 font-bold transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={() => setCustomDataRows(Math.min(50, customDataRows + 1))}
                disabled={customDataRows >= 50}
              >+</button>
            </div>
          </div>
          {!isPrintIn && (
            <div className="flex items-center gap-2">
              <label className="text-[11px] font-bold text-slate-500 whitespace-nowrap">补充空白供货商行数</label>
              <div className="flex items-center bg-slate-50 border border-slate-200 rounded overflow-hidden">
                <button
                  className="px-2.5 py-1 text-xs hover:bg-slate-200 cursor-pointer text-slate-600 font-bold transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  onClick={() => setCustomSupplierRows(Math.max(2, customSupplierRows - 1))}
                  disabled={customSupplierRows <= 2}
                >-</button>
                <div className="w-8 text-center text-xs text-slate-800 font-bold">{customSupplierRows}</div>
                <button
                  className="px-2.5 py-1 text-xs hover:bg-slate-200 cursor-pointer text-slate-600 font-bold transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  onClick={() => setCustomSupplierRows(Math.min(40, customSupplierRows + 1))}
                  disabled={customSupplierRows >= 40}
                >+</button>
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => window.print()}
              className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded cursor-pointer transition-all shadow"
            >
              立即打印
            </button>
            <button
              onClick={onClose}
              className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold rounded cursor-pointer transition-all shadow"
            >
              返回
            </button>
          </div>
        </div>
      </div>

      {/* 根据类型渲染不同模板 */}
      {isPrintIn ? (
        <PrintInDoc
          activeLedger={activeLedger}
          selectedDate={selectedDate}
          dailyInwardItems={dailyInwardItems}
          dailyInTotalAmount={dailyInTotalAmount}
          customDataRows={customDataRows}
        />
      ) : (
        <PrintOutDoc
          activeLedger={activeLedger}
          selectedDate={selectedDate}
          dailyOutwardItems={dailyOutwardItems}
          customDataRows={customDataRows}
          customSupplierRows={customSupplierRows}
        />
      )}
    </div>,
    document.body
  );
}
