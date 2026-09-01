/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description LedgerPrintPreviewOverlay（台账打印预览遮罩层）组件测试：聚焦“样式二·单原料日流水”的取料来源 —— 必须用
 * 未按 selectedDate 过滤的 currentLedgerItems，才能保证当聚焦原料在“采购流水时间段筛选”范围内有出入库、但恰好在
 * selectedDate 当天没有记录时，打印预览仍能正确渲染该原料的逐日流水，而不是错误地提示“请先选择需要打印的单原料明细”。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { LedgerPrintPreviewOverlay } from "@/src/components/ledger/LedgerPrintPreviewOverlay.tsx";
import { RawMaterialsDictService } from "@/src/services/rawMaterialDict.ts";
import { getDatesBetween } from "@/src/utils.ts";
import type { Ledger, LedgerItem } from "@/src/types/ledgerTypes.ts";

const ledger: Ledger = { id: "KID", name: "幼儿备餐", createdAt: "2026-01-01T00:00:00.000Z" };

const PLACEHOLDER = /请先在系统里选择需要打印的单原料明细/;

const makeItem = (dailyRecords: LedgerItem["dailyRecords"]): LedgerItem => ({
  id: "item_1",
  ledgerId: "KID",
  name: "大米",
  unit: "斤",
  spec: "25kg/袋",
  initialStock: 0,
  currentStock: 0,
  dailyRecords
});

const baseProps = {
  printPreviewStyle: "style2" as const,
  setPrintPreviewStyle: () => {},
  activeLedger: ledger,
  selectedPrintCategories: [],
  activeItemId: "item_1",
  style2StartDate: "2026-07-01",
  style2EndDate: "2026-07-31",
  style2DatesArray: getDatesBetween("2026-07-01", "2026-07-31"),
  customDataRows: 15,
  setCustomDataRows: () => {}
};

describe("LedgerPrintPreviewOverlay · 样式二取料来源", () => {
  beforeEach(() => {
    vi.spyOn(RawMaterialsDictService, "getItems").mockReturnValue([
      { name: "大米", category: "GRAIN_OIL", unit: "斤", remark: "25kg/袋" }
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the focused item's flow when it has activity inside the filter range but no record on selectedDate", () => {
    // 聚焦原料 7 月 10 日有入库，但当前“同步日期”是 7 月 1 日（当天无记录）
    const item = makeItem({
      "2026-07-10": { inQuantity: 5, inPrice: 2, inAmount: 10, outQuantity: 0 }
    });

    render(
      <LedgerPrintPreviewOverlay
        {...baseProps}
        selectedDate="2026-07-01"
        // ledgerItems 模拟 sortedFilteredLedgerItems：已按 selectedDate 过滤掉了该原料
        ledgerItems={[]}
        // currentLedgerItems 是未按日期过滤的本台账原料，样式二打印应当以它取料
        currentLedgerItems={[item]}
      />
    );

    expect(screen.queryByText(PLACEHOLDER)).not.toBeInTheDocument();
    // 打印标题里的时间段与“采购流水时间段筛选”一致
    expect(screen.getByText(/2026-07-01/)).toBeInTheDocument();
    expect(screen.getByText(/2026-07-31/)).toBeInTheDocument();
    // 7 月 10 日的入库数量应出现在流水表里
    expect(screen.getByText("2026-07-10")).toBeInTheDocument();
  });

  it("still shows the placeholder only when the focused item truly does not exist in the ledger", () => {
    render(
      <LedgerPrintPreviewOverlay
        {...baseProps}
        selectedDate="2026-07-01"
        activeItemId="missing_item"
        ledgerItems={[]}
        currentLedgerItems={[makeItem({})]}
      />
    );

    expect(screen.getByText(PLACEHOLDER)).toBeInTheDocument();
  });
});
