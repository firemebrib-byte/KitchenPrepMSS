/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description /api/ledgers/* 与 /api/ledger-items/* 路由的 HTTP 层集成测试（阶段B·业务规则迁移到后端，见 SQLite迁移规划.md）：
 * 覆盖 updateLedger/deleteLedger/addLedgerItem/updateLedgerItem/deleteLedgerItem/updateLedgerDailyRecord 的校验错误文案、
 * 库存重算、以及台账改名/删除对餐位人群配置 (active_groups) 与月度报表 (reports/prepared_items/prepared_item_daily_data)
 * 的级联效果（含孤儿行清理）。仿照 server/routes/rawMaterials.test.ts 的 supertest 集成测试范式。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";
import os from "os";

let tmpDir: string;
let app: express.Express;

/** 按阶段三协议包装一批增量 op 并 POST 到 /api/storage/save，用于预先造出测试夹具数据 */
function saveOps(ops: any[]) {
  return request(app).post("/api/storage/save").send({ protocolVersion: 2, ops });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kpmss-ledgers-route-test-"));
  process.env.STORAGE_TYPE = "local";
  process.env.LOCAL_DATA_DIR = path.join(tmpDir, "data");
  process.env.SKIP_SEEDING = "1";

  vi.resetModules();
  const { storageRouter } = await import("../../routes/storage.ts");
  const { ledgersRouter, ledgerItemsRouter } = await import("../../routes/ledgers.ts");

  app = express();
  app.use(express.json());
  app.use("/api/storage", storageRouter);
  app.use("/api/ledgers", ledgersRouter);
  app.use("/api/ledger-items", ledgerItemsRouter);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.STORAGE_TYPE;
  delete process.env.LOCAL_DATA_DIR;
  delete process.env.SKIP_SEEDING;
  vi.restoreAllMocks();
});

describe("PUT /api/ledgers/:id", () => {
  beforeEach(async () => {
    await saveOps([
      { entity: "ledger", op: "upsert", key: "KID", data: { id: "KID", name: "幼儿备餐", createdAt: "2026-01-01T00:00:00.000Z" } },
      { entity: "ledger", op: "upsert", key: "STU", data: { id: "STU", name: "在校生备餐", createdAt: "2026-01-01T00:00:00.000Z" } }
    ]);
  });

  it("renames the ledger", async () => {
    const res = await request(app).put("/api/ledgers/KID").send({ name: "幼儿新名字" });
    expect(res.status).toBe(200);
    expect(res.body.ledger).toEqual({ id: "KID", name: "幼儿新名字", createdAt: "2026-01-01T00:00:00.000Z" });

    const loadRes = await request(app).get("/api/storage/load");
    expect(loadRes.body.ledgers.find((l: any) => l.id === "KID").name).toBe("幼儿新名字");
  });

  it("CASCADE: renames the matching active_groups label when a group already exists for this ledger id", async () => {
    await saveOps([{ entity: "activeGroup", op: "upsert", key: "KID", data: { key: "KID", label: "幼儿备餐", emoji: "👶", isDefault: true } }]);

    await request(app).put("/api/ledgers/KID").send({ name: "幼儿新名字" });

    const loadRes = await request(app).get("/api/storage/load");
    const group = loadRes.body.activeGroups.find((g: any) => g.key === "KID");
    expect(group).toMatchObject({ label: "幼儿新名字", isDefault: true });
  });

  it("CASCADE: creates a missing active_groups entry and a current-month report if none existed yet", async () => {
    // 不预先造 activeGroup，模拟"台账存在但对应人群配置缺失"的极端情形
    await request(app).put("/api/ledgers/KID").send({ name: "幼儿新名字" });

    const loadRes = await request(app).get("/api/storage/load");
    expect(loadRes.body.activeGroups.find((g: any) => g.key === "KID")).toMatchObject({ label: "幼儿新名字" });
    const now = new Date();
    const report = loadRes.body.reports.find((r: any) => r.targetGroup === "KID" && r.year === now.getFullYear() && r.month === now.getMonth() + 1);
    expect(report).toBeDefined();
  });

  it("rejects an empty name", async () => {
    const res = await request(app).put("/api/ledgers/KID").send({ name: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("台账名称不能为空");
  });

  it("rejects when the ledger does not exist", async () => {
    const res = await request(app).put("/api/ledgers/NOPE").send({ name: "新名字" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("找不到该台账");
  });

  it("rejects renaming to a name already used by another ledger", async () => {
    const res = await request(app).put("/api/ledgers/KID").send({ name: "在校生备餐" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/已存在/);
  });

  it("CASCADE (casing): links to an existing group whose key differs only in case — updates it, never creates a duplicate", async () => {
    // 模拟历史遗留：台账 id 与人群 key 大小写不一致（updateLedger 曾用精确匹配，会误判成“人群不存在”而新建重复行）
    await saveOps([
      { entity: "ledger", op: "upsert", key: "night", data: { id: "night", name: "幼儿晚餐", createdAt: "2026-01-01T00:00:00.000Z" } },
      { entity: "activeGroup", op: "upsert", key: "NIGHT", data: { key: "NIGHT", label: "幼儿晚餐", emoji: "🌙" } }
    ]);

    const res = await request(app).put("/api/ledgers/night").send({ name: "幼儿加餐" });
    expect(res.status).toBe(200);

    const loadRes = await request(app).get("/api/storage/load");
    const nightGroups = loadRes.body.activeGroups.filter((g: any) => g.key.toUpperCase() === "NIGHT");
    expect(nightGroups).toHaveLength(1);               // 没有产生重复人群行
    expect(nightGroups[0].key).toBe("NIGHT");          // 沿用人群原有 key，不猜测重新大小写
    expect(nightGroups[0].label).toBe("幼儿加餐");      // 名称已同步
  });
});

describe("DELETE /api/ledgers/:id", () => {
  // 每个用例都额外保留一本不相关的台账，避免删除目标台账后数据库变为完全空表——规范化表结构下
  // "完全没有数据"与"曾经保存过但现在都删空了"无法区分（已知边界行为，详见 storageService.test.ts 的
  // KNOWN EDGE CASE 用例），那样 GET /load 会退化返回首启空壳 {}，无法验证"确实只删了目标台账"

  it("deletes the ledger", async () => {
    await saveOps([
      { entity: "ledger", op: "upsert", key: "KID", data: { id: "KID", name: "幼儿备餐", createdAt: "2026-01-01T00:00:00.000Z" } },
      { entity: "ledger", op: "upsert", key: "ANCHOR", data: { id: "ANCHOR", name: "占位台账", createdAt: "2026-01-01T00:00:00.000Z" } }
    ]);

    const res = await request(app).delete("/api/ledgers/KID");
    expect(res.status).toBe(200);

    const loadRes = await request(app).get("/api/storage/load");
    expect(loadRes.body.ledgers.find((l: any) => l.id === "KID")).toBeUndefined();
  });

  it("CASCADE: deletes matching ledger items (with their daily records), the active_groups entry, and every month's report (with its prepared items and daily data), leaving no orphan rows", async () => {
    await saveOps([
      { entity: "ledger", op: "upsert", key: "KID", data: { id: "KID", name: "幼儿备餐", createdAt: "2026-01-01T00:00:00.000Z" } },
      { entity: "ledger", op: "upsert", key: "ANCHOR", data: { id: "ANCHOR", name: "占位台账", createdAt: "2026-01-01T00:00:00.000Z" } },
      { entity: "ledgerItem", op: "upsert", key: "item_1", data: { id: "item_1", ledgerId: "KID", name: "土豆", unit: "斤", spec: "散装", initialStock: 10, currentStock: 12 } },
      { entity: "ledgerItemDailyRecord", op: "upsert", key: { itemId: "item_1", date: "2026-07-01" }, data: { inQuantity: 2, inPrice: 1, inAmount: 2, outQuantity: 0 } },
      { entity: "activeGroup", op: "upsert", key: "KID", data: { key: "KID", label: "幼儿备餐", emoji: "👶", isDefault: true } },
      { entity: "report", op: "upsert", key: { targetGroup: "KID", year: 2026, month: 7 } },
      { entity: "preparedItem", op: "upsert", key: "prep_1", data: { id: "prep_1", reportTargetGroup: "KID", reportYear: 2026, reportMonth: 7, name: "土豆", category: "VEGETABLE", targetGroup: "KID", unit: "斤" } },
      { entity: "preparedItemDailyData", op: "upsert", key: { itemId: "prep_1", date: "1" }, data: { quantity: 2, price: 1, amount: 2 } }
    ]);

    const res = await request(app).delete("/api/ledgers/KID");
    expect(res.status).toBe(200);

    const loadRes = await request(app).get("/api/storage/load");
    expect(loadRes.body.ledgerItems.find((i: any) => i.id === "item_1")).toBeUndefined();
    expect(loadRes.body.activeGroups.find((g: any) => g.key === "KID")).toBeUndefined();
    expect(loadRes.body.reports.find((r: any) => r.targetGroup === "KID")).toBeUndefined();
  });

  it("does not remove items/groups/reports belonging to a different ledger", async () => {
    await saveOps([
      { entity: "ledger", op: "upsert", key: "KID", data: { id: "KID", name: "幼儿备餐", createdAt: "2026-01-01T00:00:00.000Z" } },
      { entity: "ledger", op: "upsert", key: "STU", data: { id: "STU", name: "在校生备餐", createdAt: "2026-01-01T00:00:00.000Z" } },
      { entity: "ledgerItem", op: "upsert", key: "item_2", data: { id: "item_2", ledgerId: "STU", name: "胡萝卜", unit: "斤", spec: "散装", initialStock: 5, currentStock: 5 } },
      { entity: "activeGroup", op: "upsert", key: "STU", data: { key: "STU", label: "在校生备餐", emoji: "🎓", isDefault: true } }
    ]);

    await request(app).delete("/api/ledgers/KID");

    const loadRes = await request(app).get("/api/storage/load");
    expect(loadRes.body.ledgerItems.find((i: any) => i.id === "item_2")).toBeDefined();
    expect(loadRes.body.activeGroups.find((g: any) => g.key === "STU")).toBeDefined();
  });

  it("rejects when the ledger does not exist", async () => {
    const res = await request(app).delete("/api/ledgers/NOPE");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("找不到待删除的台账");
  });
});

describe("POST /api/ledgers/:ledgerId/items", () => {
  beforeEach(async () => {
    await saveOps([{ entity: "ledger", op: "upsert", key: "KID", data: { id: "KID", name: "幼儿备餐", createdAt: "2026-01-01T00:00:00.000Z" } }]);
  });

  it("adds a new ledger item with initial stock mirrored into current stock", async () => {
    const res = await request(app).post("/api/ledgers/KID/items").send({ name: "土豆", unit: "斤", spec: "散装", initialStock: 10 });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ ledgerId: "KID", name: "土豆", unit: "斤", spec: "散装", initialStock: 10, currentStock: 10, dailyRecords: {} });
  });

  it("rejects an empty name", async () => {
    const res = await request(app).post("/api/ledgers/KID/items").send({ name: "  ", unit: "斤", spec: "散装", initialStock: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("原料名称不能为空");
  });

  it("rejects when the ledger does not exist", async () => {
    const res = await request(app).post("/api/ledgers/NOPE/items").send({ name: "土豆", unit: "斤", spec: "散装", initialStock: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("关联的台账不存在");
  });

  it("rejects a duplicate name within the same ledger", async () => {
    await request(app).post("/api/ledgers/KID/items").send({ name: "土豆", unit: "斤", spec: "散装", initialStock: 10 });
    const res = await request(app).post("/api/ledgers/KID/items").send({ name: "土豆", unit: "斤", spec: "散装", initialStock: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/已有名为/);
  });
});

describe("PUT /api/ledger-items/:id", () => {
  it("updates fields and recalculates current stock from the existing daily records", async () => {
    await saveOps([
      { entity: "ledger", op: "upsert", key: "KID", data: { id: "KID", name: "幼儿备餐", createdAt: "2026-01-01T00:00:00.000Z" } },
      { entity: "ledgerItem", op: "upsert", key: "item_1", data: { id: "item_1", ledgerId: "KID", name: "土豆", unit: "斤", spec: "散装", initialStock: 10, currentStock: 10 } },
      { entity: "ledgerItemDailyRecord", op: "upsert", key: { itemId: "item_1", date: "2026-07-01" }, data: { inQuantity: 5, inPrice: 1, inAmount: 5, outQuantity: 2 } }
    ]);

    const res = await request(app).put("/api/ledger-items/item_1").send({ name: "新土豆", unit: "公斤", spec: "精品", initialStock: 100 });
    expect(res.status).toBe(200);
    // 100 (新初始库存) + 5 (入库) - 2 (出库) = 103
    expect(res.body.item).toMatchObject({ name: "新土豆", unit: "公斤", spec: "精品", initialStock: 100, currentStock: 103 });
  });

  it("rejects when the item does not exist", async () => {
    const res = await request(app).put("/api/ledger-items/nope").send({ name: "x", unit: "斤", spec: "y", initialStock: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("找不到该采购原料项目");
  });

  it("rejects a rename that collides with another item in the same ledger", async () => {
    await saveOps([
      { entity: "ledger", op: "upsert", key: "KID", data: { id: "KID", name: "幼儿备餐", createdAt: "2026-01-01T00:00:00.000Z" } },
      { entity: "ledgerItem", op: "upsert", key: "item_1", data: { id: "item_1", ledgerId: "KID", name: "土豆", unit: "斤", spec: "散装", initialStock: 10, currentStock: 10 } },
      { entity: "ledgerItem", op: "upsert", key: "item_2", data: { id: "item_2", ledgerId: "KID", name: "柿子", unit: "斤", spec: "散装", initialStock: 5, currentStock: 5 } }
    ]);

    const res = await request(app).put("/api/ledger-items/item_1").send({ name: "柿子", unit: "斤", spec: "散装", initialStock: 10 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/已有名为/);
  });
});

describe("DELETE /api/ledger-items/:id", () => {
  it("deletes the item and its daily records, leaving no orphan rows", async () => {
    await saveOps([
      { entity: "ledger", op: "upsert", key: "KID", data: { id: "KID", name: "幼儿备餐", createdAt: "2026-01-01T00:00:00.000Z" } },
      { entity: "ledgerItem", op: "upsert", key: "item_1", data: { id: "item_1", ledgerId: "KID", name: "土豆", unit: "斤", spec: "散装", initialStock: 10, currentStock: 12 } },
      { entity: "ledgerItemDailyRecord", op: "upsert", key: { itemId: "item_1", date: "2026-07-01" }, data: { inQuantity: 2, inPrice: 1, inAmount: 2, outQuantity: 0 } }
    ]);

    const res = await request(app).delete("/api/ledger-items/item_1");
    expect(res.status).toBe(200);

    const loadRes = await request(app).get("/api/storage/load");
    expect(loadRes.body.ledgerItems.find((i: any) => i.id === "item_1")).toBeUndefined();
  });

  it("rejects when the item does not exist", async () => {
    const res = await request(app).delete("/api/ledger-items/nope");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("找不到要删除的原料项目");
  });
});

describe("PUT /api/ledger-items/:id/daily/:date", () => {
  beforeEach(async () => {
    await saveOps([
      { entity: "ledger", op: "upsert", key: "KID", data: { id: "KID", name: "幼儿备餐", createdAt: "2026-01-01T00:00:00.000Z" } },
      { entity: "ledgerItem", op: "upsert", key: "item_1", data: { id: "item_1", ledgerId: "KID", name: "土豆", unit: "斤", spec: "散装", initialStock: 100, currentStock: 100 } }
    ]);
  });

  it("merges fields into a new daily record and recalculates inAmount and currentStock", async () => {
    const res = await request(app).put("/api/ledger-items/item_1/daily/2026-07-03").send({ inQuantity: 3, inPrice: 2 });
    expect(res.status).toBe(200);
    expect(res.body.mergedRecord).toMatchObject({ inQuantity: 3, inPrice: 2, inAmount: 6 });
    expect(res.body.item.currentStock).toBe(103);

    const loadRes = await request(app).get("/api/storage/load");
    const item = loadRes.body.ledgerItems.find((i: any) => i.id === "item_1");
    expect(item.dailyRecords["2026-07-03"]).toMatchObject({ inQuantity: 3, inPrice: 2, inAmount: 6 });
  });

  it("clamps negative quantities/prices to zero", async () => {
    const res = await request(app).put("/api/ledger-items/item_1/daily/2026-07-03").send({ inQuantity: -5, inPrice: -2, outQuantity: -1, certification: "有" });
    expect(res.body.mergedRecord).toMatchObject({ inQuantity: 0, inPrice: 0, outQuantity: 0 });
  });

  it("deletes the daily record once every field is emptied out (hasData guard)", async () => {
    await request(app).put("/api/ledger-items/item_1/daily/2026-07-03").send({ inQuantity: 3, inPrice: 2 });
    await request(app).put("/api/ledger-items/item_1/daily/2026-07-03").send({ inQuantity: 0, inPrice: 0 });

    const loadRes = await request(app).get("/api/storage/load");
    const item = loadRes.body.ledgerItems.find((i: any) => i.id === "item_1");
    expect(item.dailyRecords["2026-07-03"]).toBeUndefined();
  });

  it("rejects when the item does not exist", async () => {
    const res = await request(app).put("/api/ledger-items/nope/daily/2026-07-03").send({ inQuantity: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("找不到对应的采购原料项目");
  });
});
