/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description LedgerStyle2Flow（台账样式二·单原料日流水）组件测试：无激活原料/原料不存在时的空态、
 * 非选中日期行始终锁定只读、选中日期行在录入模式下可编辑并触发草稿回调、时间段筛选交互。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LedgerStyle2Flow } from "@/src/components/ledger/LedgerStyle2Flow.tsx";
import { LedgerService } from "@/src/services/ledgerStore.ts";
import type { LedgerItem } from "@/src/types/ledgerTypes.ts";

const makeItem = (dailyRecords: LedgerItem["dailyRecords"] = {}): LedgerItem => ({
  id: "item_1",
  ledgerId: "KID",
  name: "土豆",
  unit: "斤",
  spec: "散装",
  initialStock: 0,
  currentStock: 0,
  dailyRecords
});

const baseProps = {
  dateParts: { year: 2026, month: 7 },
  selectedDate: "2026-07-03",
  isRecordingMode: false,
  draftRecords: {},
  style2DatesArray: ["2026-07-01", "2026-07-02", "2026-07-03"],
  dailyStockBalances: {},
  handleDraftCellChange: vi.fn(),
  style2StartDate: "2026-07-01",
  style2EndDate: "2026-07-03",
  setStyle2StartDate: vi.fn(),
  setStyle2EndDate: vi.fn()
};

describe("LedgerStyle2Flow", () => {
  beforeEach(() => {
    vi.spyOn(LedgerService, "getHelperDict").mockReturnValue({
      suppliers: ["合作基地直供"],
      buyers: ["张采购"],
      inspectors: ["王检验"],
      keepers: ["李保管"],
      outHandlers: ["吴发料"],
      outRecipients: ["孙领料"],
      sensoryOptions: ["新鲜", "合格"],
      shelfLifeOptions: ["2天", "15天"]
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the empty-state hint when there is no active item id", () => {
    render(<LedgerStyle2Flow {...baseProps} activeItemId={null} ledgerItems={[]} />);
    expect(screen.getByText(/该台账暂无采购原料项目/)).toBeInTheDocument();
  });

  it("renders nothing when activeItemId does not match any item in ledgerItems", () => {
    const { container } = render(
      <LedgerStyle2Flow {...baseProps} activeItemId="missing" ledgerItems={[makeItem()]} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the active item's name/unit and the date-range filter inputs", () => {
    const item = makeItem();
    render(<LedgerStyle2Flow {...baseProps} activeItemId="item_1" ledgerItems={[item]} />);

    expect(screen.getByText("土豆 (斤)")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(1 + 3);
  });

  describe("row lock state", () => {
    it("locks every row's quantity inputs (placeholder '锁定') when not in recording mode", () => {
      const item = makeItem();
      render(<LedgerStyle2Flow {...baseProps} activeItemId="item_1" ledgerItems={[item]} isRecordingMode={false} />);

      const lockedInputs = screen.getAllByPlaceholderText("锁定");
      expect(lockedInputs.length).toBeGreaterThan(0);
      lockedInputs.forEach((input) => expect(input).toBeDisabled());
    });

    it("only unlocks the row matching selectedDate while recording, leaving other days locked", () => {
      const item = makeItem();
      render(
        <LedgerStyle2Flow
          {...baseProps}
          activeItemId="item_1"
          ledgerItems={[item]}
          isRecordingMode
          selectedDate="2026-07-02"
        />
      );

      // 三天里只有 07-02 一行可编辑，其余两行的采购数量输入仍应锁定
      expect(screen.getAllByPlaceholderText("0")).toHaveLength(2); // 采购数量 + 出库数量
      expect(screen.getAllByPlaceholderText("锁定").length).toBeGreaterThan(0);
    });
  });

  it("calls handleDraftCellChange with the new supplier value when the supplier field is edited", async () => {
    const user = userEvent.setup();
    const handleDraftCellChange = vi.fn();
    const item = makeItem();
    render(
      <LedgerStyle2Flow
        {...baseProps}
        activeItemId="item_1"
        ledgerItems={[item]}
        isRecordingMode
        handleDraftCellChange={handleDraftCellChange}
      />
    );

    const supplierInput = screen.getByPlaceholderText("如: 宾县鑫百达百货超市");
    await user.type(supplierInput, "新");

    expect(handleDraftCellChange).toHaveBeenLastCalledWith("item_1", { supplier: "新" });
  });

  it("disables the supplier/certification header fields outside recording mode", () => {
    const item = makeItem();
    render(<LedgerStyle2Flow {...baseProps} activeItemId="item_1" ledgerItems={[item]} isRecordingMode={false} />);

    const disabledFields = screen.getAllByPlaceholderText("未开启录入");
    expect(disabledFields).toHaveLength(2); // 供货商 + 索证索票
    disabledFields.forEach((field) => expect(field).toBeDisabled());
  });

  it("calls handleDraftCellChange for the editable row's quantity input on change", async () => {
    const user = userEvent.setup();
    const handleDraftCellChange = vi.fn();
    const item = makeItem();
    render(
      <LedgerStyle2Flow
        {...baseProps}
        activeItemId="item_1"
        ledgerItems={[item]}
        isRecordingMode
        selectedDate="2026-07-03"
        handleDraftCellChange={handleDraftCellChange}
      />
    );

    const [qtyInput] = screen.getAllByPlaceholderText("0");
    await user.type(qtyInput, "7");

    expect(handleDraftCellChange).toHaveBeenLastCalledWith("item_1", { inQuantity: 7 });
  });

  it("renders the running stock balance from dailyStockBalances for each day", () => {
    const item = makeItem({
      dailyRecords: {
        "2026-07-01": { inQuantity: 5 },
        "2026-07-02": { inQuantity: 3 },
        "2026-07-03": { inQuantity: 0 }
      }
    });
    render(
      <LedgerStyle2Flow
        {...baseProps}
        activeItemId="item_1"
        ledgerItems={[item]}
        dailyStockBalances={{ "2026-07-01": 5, "2026-07-02": 8, "2026-07-03": 8 }}
      />
    );

    expect(screen.getByText("5斤")).toBeInTheDocument();
    expect(screen.getAllByText("8斤")).toHaveLength(2);
  });

  it("calls setStyle2StartDate/setStyle2EndDate when the date range filter inputs change", async () => {
    const user = userEvent.setup();
    const setStyle2StartDate = vi.fn();
    const item = makeItem();
    render(
      <LedgerStyle2Flow
        {...baseProps}
        activeItemId="item_1"
        ledgerItems={[item]}
        setStyle2StartDate={setStyle2StartDate}
      />
    );

    const dateInputs = document.querySelectorAll('input[type="date"]');
    // 第一个 date input 是时间段筛选栏的开始日期（其余 date input 属于表格逐行的生产日期列）
    const startDateInput = dateInputs[0] as HTMLInputElement;
    await user.clear(startDateInput);
    await user.type(startDateInput, "2026-07-05");

    expect(setStyle2StartDate).toHaveBeenCalled();
  });
});
