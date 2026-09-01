/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description LogService（本地日志文件持久化服务）单元测试：写入格式、按日期归档、超出体积上限时按序号滚动到下一个分片文件、活跃文件路径缓存的失效重算、
 * 以及升级前遗留单一大日志文件（app.log）的一次性平滑迁移。测试通过临时目录 + 动态重新导入模块实现相互隔离。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

let tmpDir: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let LogService: any;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kpmss-log-test-"));
  process.env.LOCAL_LOG_DIR = path.join(tmpDir, "logs");
  process.env.LOG_MAX_FILE_SIZE_MB = "0.001"; // 约 1KB，便于用极少量日志行就能触发滚动测试
  vi.resetModules();
  const mod = await import("../logService.ts");
  LogService = mod.LogService;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LOCAL_LOG_DIR;
  delete process.env.LOG_MAX_FILE_SIZE_MB;
  vi.restoreAllMocks();
});

describe("LogService", () => {
  describe("init", () => {
    it("creates the log directory on module load", () => {
      expect(fs.existsSync(process.env.LOCAL_LOG_DIR!)).toBe(true);
    });

    // 注意：LogService.init() 里迁移遗留日志的源路径 path.resolve("data/app.log") 是硬编码相对于
    // process.cwd() 解析的，不受 LOCAL_LOG_DIR 环境变量控制。为了绝不触碰真实项目根目录下的 data/ 目录，
    // 这两个用例通过 process.chdir() 把当前工作目录临时切到隔离的临时目录，测试结束后立即恢复，
    // 确保 "data/app.log" 这个相对路径解析到的是临时目录而不是真实项目目录。
    it("migrates a legacy data/app.log file into the archive directory exactly once", async () => {
      const originalCwd = process.cwd();
      fs.rmSync(process.env.LOCAL_LOG_DIR!, { recursive: true, force: true });

      process.chdir(tmpDir);
      try {
        const legacyPath = path.resolve("data/app.log");
        fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
        fs.writeFileSync(legacyPath, "legacy log content\n");

        vi.resetModules();
        await import("../logService.ts");
        const migratedPath = path.join(process.env.LOCAL_LOG_DIR!, "app-legacy-migrated.log");

        expect(fs.existsSync(migratedPath)).toBe(true);
        expect(fs.readFileSync(migratedPath, "utf8")).toBe("legacy log content\n");
        expect(fs.existsSync(legacyPath)).toBe(false);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("does not attempt to re-migrate when the migrated file already exists", async () => {
      const originalCwd = process.cwd();
      const migratedPath = path.join(process.env.LOCAL_LOG_DIR!, "app-legacy-migrated.log");
      fs.writeFileSync(migratedPath, "already migrated");

      process.chdir(tmpDir);
      try {
        const legacyPath = path.resolve("data/app.log");
        fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
        fs.writeFileSync(legacyPath, "should stay untouched");

        vi.resetModules();
        await import("../logService.ts");

        // 既然迁移目标已存在，源文件不应被二次搬动，保持原样
        expect(fs.existsSync(legacyPath)).toBe(true);
        expect(fs.readFileSync(migratedPath, "utf8")).toBe("already migrated");
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe("write", () => {
    it("appends a formatted log line containing the timestamp, level, category and message", () => {
      LogService.write("INFO", "TestModule", "hello world");

      const files = fs.readdirSync(process.env.LOCAL_LOG_DIR!);
      const logFile = files.find((f) => f.endsWith(".log"));
      const content = fs.readFileSync(path.join(process.env.LOCAL_LOG_DIR!, logFile!), "utf8");

      expect(content).toContain("[INFO]");
      expect(content).toContain("[TestModule]");
      expect(content).toContain("hello world");
    });

    it("appends multiple lines to the same file across successive calls", () => {
      LogService.write("INFO", "M", "line one");
      LogService.write("WARN", "M", "line two");

      const files = fs.readdirSync(process.env.LOCAL_LOG_DIR!);
      const logFile = files.find((f) => f.endsWith(".log"));
      const content = fs.readFileSync(path.join(process.env.LOCAL_LOG_DIR!, logFile!), "utf8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("line one");
      expect(lines[1]).toContain("line two");
    });

    it("rolls over to a new sequenced file once the active file exceeds the size limit", () => {
      // LOG_MAX_FILE_SIZE_MB 被设为约 1KB，写入一条足够长的日志即可让该文件超出上限
      const longMessage = "x".repeat(2000);
      LogService.write("INFO", "M", longMessage);

      // 第一条写完后该文件已超出上限；下一条写入应解析到一个新的分片文件（序号 .0.log）
      LogService.write("INFO", "M", "second entry after rollover");

      const files = fs.readdirSync(process.env.LOCAL_LOG_DIR!).filter((f) => f.endsWith(".log"));
      expect(files.length).toBeGreaterThanOrEqual(2);

      const sequencedFile = files.find((f) => /\.\d+\.log$/.test(f));
      expect(sequencedFile).toBeDefined();
      const sequencedContent = fs.readFileSync(path.join(process.env.LOCAL_LOG_DIR!, sequencedFile!), "utf8");
      expect(sequencedContent).toContain("second entry after rollover");
    });

    it("re-resolves the active file path when the cached file was deleted externally", () => {
      LogService.write("INFO", "M", "first line");
      const files = fs.readdirSync(process.env.LOCAL_LOG_DIR!);
      const logFile = files.find((f) => f.endsWith(".log"))!;
      fs.rmSync(path.join(process.env.LOCAL_LOG_DIR!, logFile));

      // 缓存路径指向的文件已被外部删除，下一次写入应能自愈，重新解析出一个可写入的文件而不是抛错
      expect(() => LogService.write("INFO", "M", "second line after external delete")).not.toThrow();
      const filesAfter = fs.readdirSync(process.env.LOCAL_LOG_DIR!).filter((f) => f.endsWith(".log"));
      expect(filesAfter.length).toBeGreaterThan(0);
    });

    it("does not throw when appendFileSync fails (e.g. an unwritable target path)", () => {
      // 直接篡改私有静态字段模拟写入目标损坏（含空字节的非法路径必然导致 fs 写入抛错），
      // 仅用于验证 write() 的 try/catch 兜底不会向调用方抛出异常（LogService 在本文件中以 any 类型导入，
      // 因此不需要 @ts-expect-error 绕过私有字段的编译期检查）
      LogService.activeFilePath = path.join(tmpDir, "invalid\0path");
      expect(() => LogService.write("ERROR", "M", "should not throw")).not.toThrow();
    });
  });
});
