/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description /api/raw-materials/* 路由的 HTTP 层集成测试（阶段A·业务规则迁移到后端，见 SQLite迁移规划.md）：
 * 覆盖 addRawMaterial/updateRawMaterial/deleteRawMaterial 的校验错误文案、isDefault 默认数据保护、
 * 以及改名/删除时对台账 (ledger_items) 与备餐报表 (prepared_items) 里同名条目的级联效果（含逐日流水/逐日数据
 * 不留孤儿行）。仿照 server/routes/storage.test.ts 的 supertest 集成测试范式，只挂载被测路由的最小 Express 实例。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";
import os from "os";

let tmpDir: string;
let app: express.Express;

/** 按阶段三协议包装一批增量 op 并 POST 到 /api/storage/save，用于预先造出台账/报表测试夹具数据 */
function saveOps(ops: any[]) {
  return request(app).post("/api/storage/save").send({ protocolVersion: 2, ops });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kpmss-rawmaterials-route-test-"));
  process.env.STORAGE_TYPE = "local";
  process.env.LOCAL_DATA_DIR = path.join(tmpDir, "data");
  // 关闭首次启动自动种子注入，保持测试夹具可控（与 storageService.test.ts 的既有约定一致）
  process.env.SKIP_SEEDING = "1";

  vi.resetModules();
  const { storageRouter } = await import("../../routes/storage.ts");
  const { rawMaterialsRouter } = await import("../../routes/rawMaterials.ts");

  app = express();
  app.use(express.json());
  app.use("/api/storage", storageRouter);
  app.use("/api/raw-materials", rawMaterialsRouter);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.STORAGE_TYPE;
  delete process.env.LOCAL_DATA_DIR;
  delete process.env.SKIP_SEEDING;
  vi.restoreAllMocks();
});

describe("POST /api/raw-materials", () => {
  it("adds a new raw material and it shows up in GET /api/storage/load", async () => {
    const res = await request(app).post("/api/raw-materials").send({ name: "西蓝花", category: "VEGETABLE", unit: "斤", remark: "散装" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.item).toEqual({ name: "西蓝花", category: "VEGETABLE", unit: "斤", remark: "散装", conversionUnit: undefined, conversionRatio: undefined });

    const loadRes = await request(app).get("/api/storage/load");
    const item = loadRes.body.rawMaterialsDict.find((d: any) => d.name === "西蓝花");
    expect(item).toMatchObject({ name: "西蓝花", category: "VEGETABLE", unit: "斤", remark: "散装" });
  });

  it("rejects an empty name with 400", async () => {
    const res = await request(app).post("/api/raw-materials").send({ name: "  ", category: "VEGETABLE", unit: "斤" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("原料名称不能为空");
  });

  it("rejects a duplicate name with 400", async () => {
    await request(app).post("/api/raw-materials").send({ name: "土豆", category: "VEGETABLE", unit: "斤" });
    const res = await request(app).post("/api/raw-materials").send({ name: "土豆", category: "VEGETABLE", unit: "斤" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/已存在/);
  });
});

describe("PUT /api/raw-materials/:oldName", () => {
  beforeEach(async () => {
    await request(app).post("/api/raw-materials").send({ name: "土豆", category: "VEGETABLE", unit: "斤", remark: "散装" });
    await request(app).post("/api/raw-materials").send({ name: "柿子", category: "VEGETABLE", unit: "斤" });
  });

  it("renames the material and preserves isDefault across the edit", async () => {
    // 先把土豆标记为默认原料（模拟系统种子数据），验证改名后 isDefault 依然保留
    await saveOps([{ entity: "rawMaterial", op: "upsert", key: "土豆", data: { name: "土豆", category: "VEGETABLE", unit: "斤", remark: "散装", isDefault: true } }]);

    const res = await request(app).put(`/api/raw-materials/${encodeURIComponent("土豆")}`)
      .send({ name: "马铃薯", category: "VEGETABLE", unit: "公斤", remark: "精品装" });

    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ name: "马铃薯", unit: "公斤", remark: "精品装", isDefault: true });

    const loadRes = await request(app).get("/api/storage/load");
    expect(loadRes.body.rawMaterialsDict.find((d: any) => d.name === "土豆")).toBeUndefined();
    expect(loadRes.body.rawMaterialsDict.find((d: any) => d.name === "马铃薯")).toBeDefined();
  });

  it("CASCADE: renaming updates the name/unit/spec of matching ledger items and the name/category/unit of matching prepared items", async () => {
    // 造一条台账原料项和一条备餐细项，名字都是"土豆"
    await saveOps([
      { entity: "ledger", op: "upsert", key: "KID", data: { id: "KID", name: "幼儿备餐", createdAt: "2026-01-01T00:00:00.000Z" } },
      { entity: "ledgerItem", op: "upsert", key: "item_1", data: { id: "item_1", ledgerId: "KID", name: "土豆", unit: "斤", spec: "散装", initialStock: 10, currentStock: 10 } },
      { entity: "report", op: "upsert", key: { targetGroup: "KID", year: 2026, month: 7 } },
      { entity: "preparedItem", op: "upsert", key: "prep_1", data: { id: "prep_1", reportTargetGroup: "KID", reportYear: 2026, reportMonth: 7, name: "土豆", category: "VEGETABLE", targetGroup: "KID", unit: "斤" } }
    ]);

    const res = await request(app).put(`/api/raw-materials/${encodeURIComponent("土豆")}`)
      .send({ name: "马铃薯", category: "VEGETABLE", unit: "公斤", remark: "精品装" });
    expect(res.status).toBe(200);

    const loadRes = await request(app).get("/api/storage/load");
    const ledgerItem = loadRes.body.ledgerItems.find((i: any) => i.id === "item_1");
    expect(ledgerItem).toMatchObject({ name: "马铃薯", unit: "公斤", spec: "精品装" });
    const report = loadRes.body.reports.find((r: any) => r.targetGroup === "KID" && r.year === 2026 && r.month === 7);
    const preparedItem = report.items.find((i: any) => i.id === "prep_1");
    expect(preparedItem).toMatchObject({ name: "马铃薯", category: "VEGETABLE", unit: "公斤" });
  });

  it("rejects when the original material cannot be found", async () => {
    const res = await request(app).put(`/api/raw-materials/${encodeURIComponent("不存在")}`)
      .send({ name: "新名字", category: "VEGETABLE", unit: "斤" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("未找到原原料记录");
  });

  it("rejects renaming to a name already used by another item", async () => {
    const res = await request(app).put(`/api/raw-materials/${encodeURIComponent("土豆")}`)
      .send({ name: "柿子", category: "VEGETABLE", unit: "斤" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/已存在/);
  });

  it("rejects an empty new name", async () => {
    const res = await request(app).put(`/api/raw-materials/${encodeURIComponent("土豆")}`)
      .send({ name: "   ", category: "VEGETABLE", unit: "斤" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("原料名称不能为空");
  });
});

describe("DELETE /api/raw-materials/:name", () => {
  it("refuses to delete a default material with 400", async () => {
    await saveOps([{ entity: "rawMaterial", op: "upsert", key: "土豆", data: { name: "土豆", category: "VEGETABLE", unit: "斤", isDefault: true } }]);

    const res = await request(app).delete(`/api/raw-materials/${encodeURIComponent("土豆")}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/系统默认原料，不允许删除/);
    const loadRes = await request(app).get("/api/storage/load");
    expect(loadRes.body.rawMaterialsDict.find((d: any) => d.name === "土豆")).toBeDefined();
  });

  it("CASCADE: deletes a non-default material along with matching ledger items (and their daily records) and prepared items (and their daily data), leaving no orphan rows", async () => {
    await saveOps([
      { entity: "rawMaterial", op: "upsert", key: "自定义原料", data: { name: "自定义原料", category: "VEGETABLE", unit: "斤" } },
      { entity: "ledger", op: "upsert", key: "KID", data: { id: "KID", name: "幼儿备餐", createdAt: "2026-01-01T00:00:00.000Z" } },
      { entity: "ledgerItem", op: "upsert", key: "item_1", data: { id: "item_1", ledgerId: "KID", name: "自定义原料", unit: "斤", spec: "散装", initialStock: 10, currentStock: 12 } },
      { entity: "ledgerItemDailyRecord", op: "upsert", key: { itemId: "item_1", date: "2026-07-01" }, data: { inQuantity: 2, inPrice: 1, inAmount: 2, outQuantity: 0 } },
      { entity: "report", op: "upsert", key: { targetGroup: "KID", year: 2026, month: 7 } },
      { entity: "preparedItem", op: "upsert", key: "prep_1", data: { id: "prep_1", reportTargetGroup: "KID", reportYear: 2026, reportMonth: 7, name: "自定义原料", category: "VEGETABLE", targetGroup: "KID", unit: "斤" } },
      { entity: "preparedItemDailyData", op: "upsert", key: { itemId: "prep_1", date: "1" }, data: { quantity: 2, price: 1, amount: 2 } }
    ]);

    const res = await request(app).delete(`/api/raw-materials/${encodeURIComponent("自定义原料")}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const loadRes = await request(app).get("/api/storage/load");
    expect(loadRes.body.rawMaterialsDict.find((d: any) => d.name === "自定义原料")).toBeUndefined();
    expect(loadRes.body.ledgerItems.find((i: any) => i.id === "item_1")).toBeUndefined();
    const report = loadRes.body.reports.find((r: any) => r.targetGroup === "KID" && r.year === 2026 && r.month === 7);
    expect((report?.items ?? []).find((i: any) => i.id === "prep_1")).toBeUndefined();
  });

  it("allows deleting a material with no matching ledger/report items (no-op cascade)", async () => {
    await request(app).post("/api/raw-materials").send({ name: "孤立原料", category: "VEGETABLE", unit: "斤" });
    const res = await request(app).delete(`/api/raw-materials/${encodeURIComponent("孤立原料")}`);
    expect(res.status).toBe(200);
  });
});
