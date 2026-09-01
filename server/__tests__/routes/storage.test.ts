/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description /api/storage/* 路由的 HTTP 层集成测试：不改动 server.ts 本身（其顶层直接 dotenv.config() + bootstrap() 里 app.listen()，import 即产生副作用，不适合直接拿来测），
 * 而是在测试文件内按 server.ts 相同的挂载方式新建一个只挂载 storageRouter 的最小 Express 实例，用 supertest 发真实 HTTP 请求覆盖 load/save 两个端点。
 * 阶段三·增量写协议：POST /api/storage/save 的请求体固定为 { protocolVersion: 2, ops: SyncOp[] }，不再是此前的"整体状态"JSON。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";
import os from "os";

let tmpDir: string;
let app: express.Express;

/** 按新协议包装一批增量 op 并 POST 到 /api/storage/save */
function saveOps(ops: any[]) {
  return request(app).post("/api/storage/save").send({ protocolVersion: 2, ops });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kpmss-storage-route-test-"));
  process.env.STORAGE_TYPE = "local";
  process.env.LOCAL_DATA_DIR = path.join(tmpDir, "data");

  vi.resetModules();
  const { storageRouter } = await import("../../routes/storage.ts");

  app = express();
  app.use(express.json());
  app.use("/api/storage", storageRouter);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.STORAGE_TYPE;
  delete process.env.LOCAL_DATA_DIR;
  vi.restoreAllMocks();
});

describe("GET /api/storage/load", () => {
  it("responds with the auto-generated seed data on the first load", async () => {
    const res = await request(app).get("/api/storage/load");

    expect(res.status).toBe(200);
    expect(res.body.isFirstBoot).toBe(false);
    expect(res.body.ledgers.length).toBeGreaterThan(0);
  });

  it("responds with isFirstBoot:false and the persisted data once an incremental save has happened", async () => {
    await saveOps([{ entity: "ledger", op: "upsert", key: "KID", data: { id: "KID", name: "幼儿备餐", createdAt: "2026-01-01T00:00:00.000Z" } }]);

    const res = await request(app).get("/api/storage/load");

    expect(res.status).toBe(200);
    expect(res.body.isFirstBoot).toBe(false);
    const kidLedger = res.body.ledgers.find((l: any) => l.id === "KID");
    expect(kidLedger).toEqual({ id: "KID", name: "幼儿备餐", createdAt: "2026-01-01T00:00:00.000Z" });
  });
});

describe("POST /api/storage/save", () => {
  it("applies the incremental op batch and responds with success + a timestamp", async () => {
    const res = await saveOps([{ entity: "ledger", op: "upsert", key: "KID", data: { id: "KID", name: "幼儿备餐", createdAt: "2026-01-01T00:00:00.000Z" } }]);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.timestamp).toBe("string");

    const loadRes = await request(app).get("/api/storage/load");
    const kidLedger = loadRes.body.ledgers.find((l: any) => l.id === "KID");
    expect(kidLedger).toEqual({ id: "KID", name: "幼儿备餐", createdAt: "2026-01-01T00:00:00.000Z" });
  });

  it("accepts an empty ops array without crashing", async () => {
    const res = await saveOps([]);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("only applies the targeted entity/key, leaving everything else already saved untouched", async () => {
    await saveOps([
      { entity: "ledger", op: "upsert", key: "KID", data: { id: "KID", name: "幼儿备餐", createdAt: "2026-01-01T00:00:00.000Z" } },
      { entity: "rawMaterial", op: "upsert", key: "土豆", data: { name: "土豆", category: "蔬菜", unit: "斤", isDefault: false } }
    ]);

    // 只增量修改 rawMaterial，不重新提交 ledger 这个 op
    await saveOps([{ entity: "rawMaterial", op: "upsert", key: "土豆", data: { name: "土豆", category: "蔬菜", unit: "斤", remark: "本地", isDefault: false } }]);

    const res = await request(app).get("/api/storage/load");
    const kidLedger = res.body.ledgers.find((l: any) => l.id === "KID");
    expect(kidLedger).toEqual({ id: "KID", name: "幼儿备餐", createdAt: "2026-01-01T00:00:00.000Z" });
    const potato = res.body.rawMaterialsDict.find((r: any) => r.name === "土豆");
    expect(potato).toEqual({ name: "土豆", category: "蔬菜", unit: "斤", remark: "本地", conversionUnit: null, conversionRatio: null, isDefault: false });
  });

  it("PROTOCOL GUARD: rejects with 400 when protocolVersion is missing or wrong, without touching stored data", async () => {
    await saveOps([{ entity: "ledger", op: "upsert", key: "KID", data: { id: "KID", name: "幼儿备餐", createdAt: "2026-01-01T00:00:00.000Z" } }]);

    const res = await request(app).post("/api/storage/save").send({ ledgers: [{ id: "HACK", name: "旧协议残留", createdAt: "2026-01-01T00:00:00.000Z" }] });
    expect(res.status).toBe(400);

    const loadRes = await request(app).get("/api/storage/load");
    const kidLedger = loadRes.body.ledgers.find((l: any) => l.id === "KID");
    expect(kidLedger).toEqual({ id: "KID", name: "幼儿备餐", createdAt: "2026-01-01T00:00:00.000Z" });
  });

  it("PROTOCOL GUARD: rejects with 400 when ops is not an array", async () => {
    const res = await request(app).post("/api/storage/save").send({ protocolVersion: 2, ops: "not-an-array" });
    expect(res.status).toBe(400);
  });
});
