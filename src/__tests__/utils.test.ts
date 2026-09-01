/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description utils.ts 通用工具函数集合的单元测试：日期计算、拼音模糊匹配、金额计算、月度汇总、CSV 导出、LogBroker 发布订阅。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getDaysInMonth,
  getDatesBetween,
  matchPinyin,
  getItemMonthlySummary,
  createSystemLog,
  convertItemsToCsv,
  computeLedgerDailyAmountsByGroup,
  computeLedgerTrueCurrentStock,
  computeLedgerDailyStockBalances,
  computeLedgerHistoricalInAmount,
  LogBroker
} from "@/src/utils.ts";
import { PreparedItem, FoodCategory, TargetGroup } from "@/src/types/types.ts";
import { LedgerItem } from "@/src/types/ledgerTypes.ts";

describe("getDaysInMonth", () => {
  it("returns 31 days for January", () => {
    expect(getDaysInMonth(2026, 1)).toHaveLength(31);
    expect(getDaysInMonth(2026, 1)[0]).toBe("1");
    expect(getDaysInMonth(2026, 1)[30]).toBe("31");
  });

  it("returns 28 days for February in a non-leap year", () => {
    expect(getDaysInMonth(2026, 2)).toHaveLength(28);
  });

  it("returns 29 days for February in a leap year", () => {
    expect(getDaysInMonth(2024, 2)).toHaveLength(29);
  });

  it("returns 30 days for April", () => {
    expect(getDaysInMonth(2026, 4)).toHaveLength(30);
  });
});

describe("computeLedgerDailyAmountsByGroup", () => {
  const makeLedgerItem = (overrides: Partial<LedgerItem> = {}): LedgerItem => ({
    id: overrides.id || "item_1",
    ledgerId: overrides.ledgerId || "KID",
    name: overrides.name || "土豆",
    unit: overrides.unit || "斤",
    initialStock: overrides.initialStock ?? 0,
    currentStock: overrides.currentStock ?? 0,
    dailyRecords: overrides.dailyRecords || {}
  });

  it("sums inAmount per day, scoped to the given group, across the valid days of the month", () => {
    const items: LedgerItem[] = [
      makeLedgerItem({
        id: "a",
        ledgerId: "KID",
        dailyRecords: {
          "2026-07-01": { inQuantity: 5, inPrice: 2, inAmount: 10, outQuantity: 0 },
          "2026-07-02": { inQuantity: 3, inPrice: 2, inAmount: 6, outQuantity: 0 }
        }
      }),
      makeLedgerItem({
        id: "b",
        ledgerId: "TEACHER",
        dailyRecords: {
          "2026-07-01": { inQuantity: 100, inPrice: 1, inAmount: 100, outQuantity: 0 }
        }
      })
    ];

    const result = computeLedgerDailyAmountsByGroup(items, "KID", 2026, 7);

    expect(result["1"]).toBe(10);
    expect(result["2"]).toBe(6);
    expect(result["3"]).toBe(0);
    expect(Object.keys(result)).toHaveLength(31);
  });

  it("includes every group's amounts when targetGroup is null", () => {
    const items: LedgerItem[] = [
      makeLedgerItem({ id: "a", ledgerId: "KID", dailyRecords: { "2026-07-01": { inQuantity: 5, inPrice: 2, inAmount: 10, outQuantity: 0 } } }),
      makeLedgerItem({ id: "b", ledgerId: "TEACHER", dailyRecords: { "2026-07-01": { inQuantity: 1, inPrice: 5, inAmount: 5, outQuantity: 0 } } })
    ];

    const result = computeLedgerDailyAmountsByGroup(items, null, 2026, 7);

    expect(result["1"]).toBe(15);
  });

  it("ignores historical dirty keys outside the requested month's valid day range", () => {
    const items: LedgerItem[] = [
      makeLedgerItem({
        ledgerId: "KID",
        dailyRecords: {
          // 历史脏键：早期版本遗留的完整日期格式落在其它月份，不应计入本月合计
          "2026-06-15": { inQuantity: 999, inPrice: 1, inAmount: 999, outQuantity: 0 },
          "2026-07-01": { inQuantity: 5, inPrice: 2, inAmount: 10, outQuantity: 0 }
        }
      })
    ];

    const result = computeLedgerDailyAmountsByGroup(items, "KID", 2026, 7);
    const total = Object.values(result).reduce((a, b) => a + b, 0);

    expect(total).toBe(10);
  });
});

describe("computeLedgerTrueCurrentStock", () => {
  const makeItem = (overrides: Partial<LedgerItem> = {}): LedgerItem => ({
    id: "item_1",
    ledgerId: "KID",
    name: "大米",
    unit: "斤",
    initialStock: overrides.initialStock ?? 0,
    currentStock: overrides.currentStock ?? 0,
    historicalTotalIn: overrides.historicalTotalIn,
    historicalTotalOut: overrides.historicalTotalOut,
    dailyRecords: overrides.dailyRecords || {}
  });

  it("uses server-side historicalTotalIn/Out when present (whole-history scope), ignoring the partially-loaded dailyRecords", () => {
    // 8 月入库 250、8 月出库 200、9 月出库 29；前端切到 9 月时 dailyRecords 只剩 9 月这一条
    const item = makeItem({
      initialStock: 0,
      historicalTotalIn: 250,
      historicalTotalOut: 229,
      dailyRecords: { "2026-09-15": { inQuantity: 0, inPrice: 0, inAmount: 0, outQuantity: 29 } }
    });
    expect(computeLedgerTrueCurrentStock(item)).toBe(21);
  });

  it("falls back to summing dailyRecords when the historical totals are absent (e.g. COS mode returns full records)", () => {
    const item = makeItem({
      initialStock: 10,
      dailyRecords: {
        "2026-07-01": { inQuantity: 5, inPrice: 1, inAmount: 5, outQuantity: 0 },
        "2026-07-02": { inQuantity: 0, inPrice: 0, inAmount: 0, outQuantity: 3 }
      }
    });
    expect(computeLedgerTrueCurrentStock(item)).toBe(12);
  });
});

describe("computeLedgerDailyStockBalances", () => {
  const makeItem = (overrides: Partial<LedgerItem> = {}): LedgerItem => ({
    id: "item_1",
    ledgerId: "KID",
    name: "大米",
    unit: "斤",
    initialStock: overrides.initialStock ?? 0,
    currentStock: overrides.currentStock ?? 0,
    historicalTotalIn: overrides.historicalTotalIn,
    historicalTotalOut: overrides.historicalTotalOut,
    dailyRecords: overrides.dailyRecords || {}
  });

  it("anchors the running balance to the true current stock even when earlier months are not in dailyRecords", () => {
    // 幼儿台账大米：8 月入库 250 斤，9 月 15 日出库 29 斤。切到 9 月查看时，dailyRecords 只含 9 月，
    // historicalTotalIn=250 / historicalTotalOut=29 反映全历史。9 月每天的当日库存不能算成负数。
    const item = makeItem({
      initialStock: 0,
      historicalTotalIn: 250,
      historicalTotalOut: 29,
      dailyRecords: { "2026-09-15": { inQuantity: 0, inPrice: 0, inAmount: 0, outQuantity: 29 } }
    });
    const dates = getDatesBetween("2026-09-14", "2026-09-16");
    const balances = computeLedgerDailyStockBalances(item, dates);

    expect(balances["2026-09-14"]).toBe(250); // 出库前仍是真实库存 250
    expect(balances["2026-09-15"]).toBe(221); // 出库 29 后 = 221（真实库存），绝不是 -29
    expect(balances["2026-09-16"]).toBe(221);
    // 区间最后一天恒等于真实当前库存
    expect(balances["2026-09-16"]).toBe(computeLedgerTrueCurrentStock(item));
  });

  it("matches the naive forward-accumulation when every record lies inside the window", () => {
    const item = makeItem({
      initialStock: 2,
      historicalTotalIn: 8,
      historicalTotalOut: 3,
      dailyRecords: {
        "2026-07-01": { inQuantity: 5, inPrice: 1, inAmount: 5, outQuantity: 0 },
        "2026-07-02": { inQuantity: 3, inPrice: 1, inAmount: 3, outQuantity: 3 }
      }
    });
    const dates = getDatesBetween("2026-07-01", "2026-07-03");
    const balances = computeLedgerDailyStockBalances(item, dates);

    expect(balances["2026-07-01"]).toBe(7); // 2 + 5
    expect(balances["2026-07-02"]).toBe(7); // 7 + 3 - 3
    expect(balances["2026-07-03"]).toBe(7);
  });
});

describe("computeLedgerHistoricalInAmount", () => {
  const makeItem = (overrides: Partial<LedgerItem> = {}): LedgerItem => ({
    id: overrides.id || "item_1",
    ledgerId: overrides.ledgerId || "KID",
    name: overrides.name || "大米",
    unit: overrides.unit || "斤",
    initialStock: overrides.initialStock ?? 0,
    currentStock: overrides.currentStock ?? 0,
    historicalTotalInAmount: overrides.historicalTotalInAmount,
    dailyRecords: overrides.dailyRecords || {}
  });

  it("uses server-side historicalTotalInAmount when present, ignoring the partially-loaded dailyRecords", () => {
    // 内存里只有 9 月一天的记录（¥58），但服务端预聚合的全历史入库金额是 ¥1234.5
    const items: LedgerItem[] = [
      makeItem({
        historicalTotalInAmount: 1234.5,
        dailyRecords: { "2026-09-03": { inQuantity: 2, inPrice: 29, inAmount: 58, outQuantity: 0 } }
      })
    ];
    expect(computeLedgerHistoricalInAmount(items, "KID")).toBe(1234.5);
  });

  it("falls back to summing dailyRecords inAmount when historicalTotalInAmount is absent (COS mode)", () => {
    const items: LedgerItem[] = [
      makeItem({
        dailyRecords: {
          "2026-07-01": { inQuantity: 5, inPrice: 2, inAmount: 10, outQuantity: 0 },
          "2026-08-02": { inQuantity: 3, inPrice: 4, inAmount: 12, outQuantity: 0 }
        }
      })
    ];
    expect(computeLedgerHistoricalInAmount(items, "KID")).toBe(22);
  });

  it("only counts items belonging to the given ledgerId", () => {
    const items: LedgerItem[] = [
      makeItem({ id: "a", ledgerId: "KID", historicalTotalInAmount: 100 }),
      makeItem({ id: "b", ledgerId: "TEACHER", historicalTotalInAmount: 999 }),
      makeItem({ id: "c", ledgerId: "KID", historicalTotalInAmount: 50 })
    ];
    expect(computeLedgerHistoricalInAmount(items, "KID")).toBe(150);
  });

  it("treats a legit zero historicalTotalInAmount as authoritative (does not fall back)", () => {
    const items: LedgerItem[] = [
      makeItem({ historicalTotalInAmount: 0, dailyRecords: { "2026-09-01": { inQuantity: 0, inPrice: 0, inAmount: 99, outQuantity: 0 } } })
    ];
    expect(computeLedgerHistoricalInAmount(items, "KID")).toBe(0);
  });
});

describe("getDatesBetween", () => {
  it("returns a single date when start equals end", () => {
    expect(getDatesBetween("2026-07-03", "2026-07-03")).toEqual(["2026-07-03"]);
  });

  it("returns an inclusive range across days", () => {
    expect(getDatesBetween("2026-07-01", "2026-07-03")).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03"
    ]);
  });

  it("crosses a month boundary correctly", () => {
    const dates = getDatesBetween("2026-06-29", "2026-07-02");
    expect(dates).toEqual(["2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02"]);
  });

  it("crosses a year boundary correctly", () => {
    const dates = getDatesBetween("2025-12-30", "2026-01-02");
    expect(dates).toEqual(["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"]);
  });

  it("returns an empty array when either date is missing", () => {
    expect(getDatesBetween("", "2026-07-03")).toEqual([]);
    expect(getDatesBetween("2026-07-03", "")).toEqual([]);
  });

  it("returns an empty array when either date is invalid", () => {
    expect(getDatesBetween("not-a-date", "2026-07-03")).toEqual([]);
    expect(getDatesBetween("2026-07-03", "not-a-date")).toEqual([]);
  });

  it("returns an empty array when start is after end", () => {
    expect(getDatesBetween("2026-07-05", "2026-07-01")).toEqual([]);
  });
});

describe("matchPinyin", () => {
  it("matches on empty query (matches everything)", () => {
    expect(matchPinyin("大米", "")).toBe(true);
    expect(matchPinyin("大米", "   ")).toBe(true);
  });

  it("matches literal Chinese substring", () => {
    expect(matchPinyin("大米", "大米")).toBe(true);
    expect(matchPinyin("大米粥", "大米")).toBe(true);
  });

  it("matches full pinyin", () => {
    expect(matchPinyin("大米", "dami")).toBe(true);
  });

  it("matches pinyin first-letter abbreviation", () => {
    expect(matchPinyin("大米", "dm")).toBe(true);
  });

  it("is case-insensitive for the query", () => {
    expect(matchPinyin("大米", "DM")).toBe(true);
  });

  it("returns false for a non-matching query", () => {
    expect(matchPinyin("大米", "xyz")).toBe(false);
  });
});

describe("getItemMonthlySummary", () => {
  const makeItem = (dailyData: PreparedItem["dailyData"]): PreparedItem => ({
    id: "item_1",
    name: "土豆",
    category: "VEGETABLE",
    targetGroup: "KID",
    unit: "斤",
    dailyData
  });

  it("sums quantity and amount across the given days", () => {
    const item = makeItem({
      "1": { quantity: 2, price: 3, amount: 6 },
      "2": { quantity: 1, price: 3, amount: 3 }
    });
    expect(getItemMonthlySummary(item, ["1", "2"])).toEqual({ totalQty: 3, totalCost: 9 });
  });

  it("skips days with no entry", () => {
    const item = makeItem({ "1": { quantity: 2, price: 3, amount: 6 } });
    expect(getItemMonthlySummary(item, ["1", "2", "3"])).toEqual({ totalQty: 2, totalCost: 6 });
  });

  it("returns zero totals when there is no data at all", () => {
    const item = makeItem({});
    expect(getItemMonthlySummary(item, ["1", "2"])).toEqual({ totalQty: 0, totalCost: 0 });
  });
});

describe("createSystemLog", () => {
  it("assembles a SystemLog object with the given fields", () => {
    const log = createSystemLog("INFO", "TestModule", "hello");
    expect(log.level).toBe("INFO");
    expect(log.module).toBe("TestModule");
    expect(log.message).toBe("hello");
    expect(log.details).toBeUndefined();
    expect(log.id).toMatch(/^log_/);
    expect(() => new Date(log.timestamp).toISOString()).not.toThrow();
  });

  it("includes details when provided", () => {
    const log = createSystemLog("ERROR", "TestModule", "boom", "stack trace here");
    expect(log.details).toBe("stack trace here");
  });

  it("generates unique ids across calls", () => {
    const a = createSystemLog("INFO", "M", "a");
    const b = createSystemLog("INFO", "M", "b");
    expect(a.id).not.toBe(b.id);
  });
});

describe("convertItemsToCsv", () => {
  const makeItem = (name: string, dailyData: PreparedItem["dailyData"]): PreparedItem => ({
    id: `item_${name}`,
    name,
    category: "VEGETABLE",
    targetGroup: "KID",
    unit: "斤",
    dailyData
  });

  it("starts with a UTF-8 BOM to prevent Excel garbling", () => {
    const csv = convertItemsToCsv([], ["1"], "蔬菜");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("includes a header row with per-day columns and totals", () => {
    const csv = convertItemsToCsv([], ["1", "2"], "蔬菜");
    const lines = csv.split("\n");
    expect(lines[0]).toContain("1号");
    expect(lines[0]).toContain("2号");
    expect(lines[0]).toContain("总数量");
    expect(lines[1]).toContain("数量");
    expect(lines[1]).toContain("单价");
    expect(lines[1]).toContain("金额(元)");
  });

  it("renders one data row per item with row totals", () => {
    const item = makeItem("土豆", { "1": { quantity: 2, price: 3, amount: 6 } });
    const csv = convertItemsToCsv([item], ["1"], "蔬菜");
    const lines = csv.split("\n");
    expect(lines[2]).toContain("土豆 (斤)");
    expect(lines[2]).toContain("2");
    expect(lines[2]).toContain("6");
  });

  it("escapes embedded double quotes in cell content", () => {
    const item = makeItem('特殊"名称', {});
    const csv = convertItemsToCsv([item], ["1"], "蔬菜");
    expect(csv).toContain('特殊""名称');
  });

  it("treats missing daily entries as zero without throwing", () => {
    const item = makeItem("柿子", {});
    expect(() => convertItemsToCsv([item], ["1", "2"], "蔬菜")).not.toThrow();
  });
});

describe("LogBroker", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("delivers published logs to subscribed listeners", () => {
    const received: string[] = [];
    const unsubscribe = LogBroker.subscribe((log) => received.push(log.message));

    LogBroker.publish("INFO", "TestModule", "first message");

    expect(received).toEqual(["first message"]);
    unsubscribe();
  });

  it("stops delivering to a listener after it unsubscribes", () => {
    const received: string[] = [];
    const unsubscribe = LogBroker.subscribe((log) => received.push(log.message));
    unsubscribe();

    LogBroker.publish("INFO", "TestModule", "should not arrive");

    expect(received).toEqual([]);
  });

  it("does not let one listener's exception block the others", () => {
    const received: string[] = [];
    const unsubscribeBad = LogBroker.subscribe(() => {
      throw new Error("listener boom");
    });
    const unsubscribeGood = LogBroker.subscribe((log) => received.push(log.message));

    expect(() => LogBroker.publish("INFO", "TestModule", "still arrives")).not.toThrow();
    expect(received).toEqual(["still arrives"]);

    unsubscribeBad();
    unsubscribeGood();
  });

  it("forwards the published log to the backend via POST /api/log", () => {
    LogBroker.publish("ERROR", "TestModule", "failure happened", "stack details");

    expect(fetch).toHaveBeenCalledWith(
      "/api/log",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" }
      })
    );
    const [, options] = (fetch as any).mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.level).toBe("ERROR");
    expect(body.category).toBe("TestModule");
    expect(body.message).toContain("failure happened");
    expect(body.message).toContain("stack details");
  });

  it("does not throw when the backend log upload fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(() => LogBroker.publish("WARN", "TestModule", "network will fail")).not.toThrow();
    // 等待被 .catch() 内部吞掉的拒绝落地，避免出现未处理的 rejection 警告
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
