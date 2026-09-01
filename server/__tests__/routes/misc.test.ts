/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description /api/log 与 /api/health 路由的 HTTP 层集成测试：不改动 server.ts 本身，在测试文件内新建一个只挂载 miscRouter 的最小 Express 实例，用 supertest 发真实 HTTP 请求覆盖两个端点。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";
import os from "os";

let tmpDir: string;
let app: express.Express;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kpmss-misc-route-test-"));
  process.env.LOCAL_LOG_DIR = path.join(tmpDir, "logs");

  vi.resetModules();
  const { miscRouter } = await import("../../routes/misc.ts");

  app = express();
  app.use(express.json());
  app.use("/api", miscRouter);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LOCAL_LOG_DIR;
  vi.restoreAllMocks();
});

describe("POST /api/log", () => {
  it("writes the reported log line to the local log file and responds with success", async () => {
    const res = await request(app)
      .post("/api/log")
      .send({ level: "WARN", category: "TestClient", message: "something happened" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const files = fs.readdirSync(process.env.LOCAL_LOG_DIR!).filter((f) => f.endsWith(".log"));
    expect(files.length).toBeGreaterThan(0);
    const content = fs.readFileSync(path.join(process.env.LOCAL_LOG_DIR!, files[0]), "utf8");
    expect(content).toContain("[WARN]");
    expect(content).toContain("[TestClient]");
    expect(content).toContain("something happened");
  });

  it("falls back to INFO/System/empty-message defaults when the body is empty", async () => {
    const res = await request(app).post("/api/log").send({});

    expect(res.status).toBe(200);
    const files = fs.readdirSync(process.env.LOCAL_LOG_DIR!).filter((f) => f.endsWith(".log"));
    const content = fs.readFileSync(path.join(process.env.LOCAL_LOG_DIR!, files[0]), "utf8");
    expect(content).toContain("[INFO]");
    expect(content).toContain("[System]");
  });
});

describe("GET /api/health", () => {
  it("responds with alive status and an ISO timestamp", async () => {
    const res = await request(app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("alive");
    expect(() => new Date(res.body.timestamp).toISOString()).not.toThrow();
  });
});
