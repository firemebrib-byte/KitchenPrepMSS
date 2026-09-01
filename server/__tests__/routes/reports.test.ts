/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description /api/groups、/api/categories 路由的 HTTP 层集成测试（阶段C·业务规则迁移到后端，
 * 见 SQLite迁移规划.md）：覆盖 saveGroup/deleteGroup/saveCategory/deleteCategory 的校验错误文案、
 * 以及人群/大类默认数据保护、跨表级联（人群↔台账、大类↔备餐细项）效果（含孤儿行清理）。
 * 仿照 server/routes/ledgers.test.ts 的 supertest 集成测试范式。
 * addPreparedItem/updateCell/deletePreparedItem/batchUpdatePriceCol 四个端点已确认为死代码一并删除。
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kpmss-reports-route-test-"));
  process.env.STORAGE_TYPE = "local";
  process.env.LOCAL_DATA_DIR = path.join(tmpDir, "data");
  process.env.SKIP_SEEDING = "1";

  vi.resetModules();
  const { storageRouter } = await import("../../routes/storage.ts");
  const { groupsRouter, categoriesRouter } = await import("../../routes/reports.ts");

  app = express();
  app.use(express.json());
  app.use("/api/storage", storageRouter);
  app.use("/api/groups", groupsRouter);
  app.use("/api/categories", categoriesRouter);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.STORAGE_TYPE;
  delete process.env.LOCAL_DATA_DIR;
  delete process.env.SKIP_SEEDING;
  vi.restoreAllMocks();
});

describe("PUT /api/groups/:key", () => {
  it("creates a new group, seeds a current-month report, and cascades to create a matching ledger", async () => {
    const res = await request(app).put("/api/groups/teacher").send({ label: "教师备餐", emoji: "👩‍🏫" });
    expect(res.status).toBe(200);
    expect(res.body.group).toMatchObject({ key: "TEACHER", label: "教师备餐", emoji: "👩‍🏫" });

    const loadRes = await request(app).get("/api/storage/load");
    expect(loadRes.body.activeGroups.find((g: any) => g.key === "TEACHER")).toBeDefined();
    const now = new Date();
    expect(loadRes.body.reports.some((r: any) => r.targetGroup === "TEACHER" && r.year === now.getFullYear() && r.month === now.getMonth() + 1)).toBe(true);
    expect(loadRes.body.ledgers.find((l: any) => l.id === "TEACHER")).toMatchObject({ name: "教师备餐" });
  });

  it("edits an existing group while preserving isDefault, and renames its existing ledger", async () => {
    await saveOps([
      { entity: "activeGroup", op: "upsert", key: "KID", data: { key: "KID", label: "旧名字", emoji: "👶", isDefault: true } },
      { entity: "ledger", op: "upsert", key: "KID", data: { id: "KID", name: "旧名字", createdAt: "2026-01-01T00:00:00.000Z" } }
    ]);

    const res = await request(app).put("/api/groups/kid").send({ label: "幼儿新名字", emoji: "👶" });
    expect(res.body.group).toMatchObject({ key: "KID", label: "幼儿新名字", isDefault: true });

    const loadRes = await request(app).get("/api/storage/load");
    expect(loadRes.body.ledgers.find((l: any) => l.id === "KID").name).toBe("幼儿新名字");
  });

  it("rejects an empty key or label", async () => {
    let res = await request(app).put("/api/groups/%20").send({ label: "名字", emoji: "🍽️" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("人群标识键不能为空");

    res = await request(app).put("/api/groups/teacher").send({ label: "  ", emoji: "🍽️" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("人群名称标签不能为空");
  });
});

describe("DELETE /api/groups/:key", () => {
  it("refuses to delete a default group", async () => {
    await saveOps([{ entity: "activeGroup", op: "upsert", key: "KID", data: { key: "KID", label: "幼儿", emoji: "👶", isDefault: true } }]);

    const res = await request(app).delete("/api/groups/KID");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/系统默认人群，不允许删除/);
  });

  it("deletes a non-default group, cascades to its reports, and to its matching ledger + ledger items", async () => {
    await saveOps([
      { entity: "activeGroup", op: "upsert", key: "CUSTOM", data: { key: "CUSTOM", label: "自定义群体", emoji: "🍽️", isDefault: false } },
      { entity: "activeGroup", op: "upsert", key: "ANCHOR", data: { key: "ANCHOR", label: "占位人群", emoji: "🍽️", isDefault: true } },
      { entity: "report", op: "upsert", key: { targetGroup: "CUSTOM", year: 2026, month: 7 } },
      { entity: "ledger", op: "upsert", key: "CUSTOM", data: { id: "CUSTOM", name: "自定义群体", createdAt: "2026-01-01T00:00:00.000Z" } },
      { entity: "ledgerItem", op: "upsert", key: "li_1", data: { id: "li_1", ledgerId: "CUSTOM", name: "土豆", unit: "斤", spec: "", initialStock: 0, currentStock: 0 } }
    ]);

    const res = await request(app).delete("/api/groups/CUSTOM");
    expect(res.status).toBe(200);

    const loadRes = await request(app).get("/api/storage/load");
    expect(loadRes.body.activeGroups.find((g: any) => g.key === "CUSTOM")).toBeUndefined();
    expect(loadRes.body.reports.find((r: any) => r.targetGroup === "CUSTOM")).toBeUndefined();
    expect(loadRes.body.ledgers.find((l: any) => l.id === "CUSTOM")).toBeUndefined();
    expect(loadRes.body.ledgerItems.find((i: any) => i.id === "li_1")).toBeUndefined();
  });

  it("actually removes a group whose stored key is not upper-case (deletes by the real row key, not a re-cased guess)", async () => {
    await saveOps([
      { entity: "activeGroup", op: "upsert", key: "night", data: { key: "night", label: "幼儿晚餐", emoji: "🌙", isDefault: false } },
      { entity: "activeGroup", op: "upsert", key: "ANCHOR", data: { key: "ANCHOR", label: "占位人群", emoji: "🍽️", isDefault: true } },
      { entity: "ledger", op: "upsert", key: "night", data: { id: "night", name: "幼儿晚餐", createdAt: "2026-01-01T00:00:00.000Z" } }
    ]);

    const res = await request(app).delete("/api/groups/NIGHT"); // 大写请求，行里存的是小写
    expect(res.status).toBe(200);

    const loadRes = await request(app).get("/api/storage/load");
    expect(loadRes.body.activeGroups.find((g: any) => g.key.toUpperCase() === "NIGHT")).toBeUndefined();
    expect(loadRes.body.ledgers.find((l: any) => l.id.toUpperCase() === "NIGHT")).toBeUndefined();
  });
});

describe("PUT /api/categories/:key", () => {
  it("creates a new category", async () => {
    const res = await request(app).put("/api/categories/dessert").send({ label: "甜品" });
    expect(res.status).toBe(200);
    expect(res.body.category).toMatchObject({ key: "DESSERT", label: "甜品" });
  });

  it("edits an existing category while preserving isDefault", async () => {
    await saveOps([{ entity: "activeCategory", op: "upsert", key: "VEGETABLE", data: { key: "VEGETABLE", label: "旧名字", isDefault: true } }]);
    const res = await request(app).put("/api/categories/vegetable").send({ label: "新名字" });
    expect(res.body.category).toMatchObject({ key: "VEGETABLE", label: "新名字", isDefault: true });
  });

  it("rejects an empty key or label", async () => {
    let res = await request(app).put("/api/categories/%20").send({ label: "甜品" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("大类标识键不能为空");

    res = await request(app).put("/api/categories/dessert").send({ label: "  " });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("大类名称标签不能为空");
  });
});

describe("DELETE /api/categories/:key", () => {
  it("refuses to delete a default category", async () => {
    await saveOps([{ entity: "activeCategory", op: "upsert", key: "VEGETABLE", data: { key: "VEGETABLE", label: "蔬菜", isDefault: true } }]);
    const res = await request(app).delete("/api/categories/VEGETABLE");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/系统默认大类，不允许删除/);
  });

  it("deletes a non-default category and strips matching items from every report, leaving unrelated items intact", async () => {
    await saveOps([
      { entity: "activeCategory", op: "upsert", key: "CUSTOM", data: { key: "CUSTOM", label: "自定义大类", isDefault: false } },
      { entity: "report", op: "upsert", key: { targetGroup: "KID", year: 2026, month: 7 } },
      { entity: "preparedItem", op: "upsert", key: "a", data: { id: "a", reportTargetGroup: "KID", reportYear: 2026, reportMonth: 7, name: "自定义食材", category: "CUSTOM", targetGroup: "KID", unit: "斤" } },
      { entity: "preparedItem", op: "upsert", key: "b", data: { id: "b", reportTargetGroup: "KID", reportYear: 2026, reportMonth: 7, name: "土豆", category: "VEGETABLE", targetGroup: "KID", unit: "斤" } }
    ]);

    const res = await request(app).delete("/api/categories/CUSTOM");
    expect(res.status).toBe(200);

    const loadRes = await request(app).get("/api/storage/load");
    expect(loadRes.body.activeCategories.find((c: any) => c.key === "CUSTOM")).toBeUndefined();
    const report = loadRes.body.reports.find((r: any) => r.targetGroup === "KID");
    expect(report.items.map((i: any) => i.id)).toEqual(["b"]);
  });
});
