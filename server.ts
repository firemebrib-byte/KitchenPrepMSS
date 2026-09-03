/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 后端服务入口文件：初始化 Express 实例与中间件、挂载数据持久化与杂项路由、在开发环境挂载 Vite HMR 中间件（生产环境托管静态构建产物），并注册进程级与路由级的全局异常捕获。
 */

import express from "express";
import path from "path";
import dotenv from "dotenv";
import { LogService } from "./server/logService.ts";
import { storageRouter } from "./server/routes/storage.ts";
import { miscRouter } from "./server/routes/misc.ts";
import { rawMaterialsRouter } from "./server/routes/rawMaterials.ts";
import { ledgersRouter, ledgerItemsRouter } from "./server/routes/ledgers.ts";
import { groupsRouter, categoriesRouter } from "./server/routes/reports.ts";
import { systemRouter } from "./server/routes/system.ts";

// 加载环境变量
dotenv.config();

/**
 * @description 初始化 Express 实例
 */
const app = express();

/**
 * @description 服务监听端口：优先读取环境变量 PORT（单机部署时如遇端口冲突，可在 .env 中修改此项后重启即可切换端口），
 * 未配置或配置值非法时回退到默认端口 3000
 */
const DEFAULT_PORT = 3000;
const parsedPort = Number(process.env.PORT);
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : DEFAULT_PORT;
if (process.env.PORT && PORT !== parsedPort) {
  console.warn(`[SYSTEM BOOT] 环境变量 PORT="${process.env.PORT}" 不是合法端口号，已自动回退使用默认端口 ${DEFAULT_PORT}`);
}

// 配置 JSON 解析器
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

import { RequestContext, StorageService } from "./server/storageService.ts";

/** 会改动数据、需要进运行日志审计的 HTTP 方法 */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// 记录请求日志中转器
app.use((req, res, next) => {
  console.log(`[HTTP LOG] [${new Date().toISOString()}] ${req.method} ${req.url}`);

  const baseVersionStr = req.header("X-Base-Version");
  const baseVersion = baseVersionStr ? parseInt(baseVersionStr, 10) : undefined;

  // 每个请求分配一个短随机 ID，串联同一次请求在运行日志与数据审计日志里的多条记录
  const reqId = Math.random().toString(36).slice(2, 10);

  // 拦截所有的 res.json 响应，在发出前附带最新的数据库版本号
  const originalJson = res.json;
  res.json = function (body) {
    if (StorageService.getDbVersion) {
      res.setHeader("X-New-Version", StorageService.getDbVersion().toString());
    }
    return originalJson.call(this, body);
  };

  // 变更类请求：入口与最终响应状态都进运行日志，便于按时间点核对"这一刻发起了哪个写请求、结果是成功还是被 409/400/500 拒绝"
  if (MUTATING_METHODS.has(req.method)) {
    const startedAt = Date.now();
    LogService.write(
      "INFO",
      "HTTP",
      `req=${reqId} ${req.method} ${req.url} 收到写请求 baseVer=${baseVersion ?? "∅"}`
    );
    res.on("finish", () => {
      const level = res.statusCode >= 500 ? "ERROR" : res.statusCode >= 400 ? "WARN" : "INFO";
      LogService.write(
        level,
        "HTTP",
        `req=${reqId} ${req.method} ${req.url} 响应 ${res.statusCode} 用时 ${Date.now() - startedAt}ms`
      );
    });
  }

  // 将请求上下文存入全局，供底层的 withWriteLock 校验版本、各数据变更方法组装审计日志的 ctx 段
  RequestContext.run({ baseVersion, reqId, method: req.method, url: req.url }, () => {
    next();
  });
});

// 挂载数据持久化相关路由 (/api/storage/load|save)
app.use("/api/storage", storageRouter);

// 挂载原料字典业务路由（阶段A·校验/级联已迁移到后端，见 SQLite迁移规划.md）
app.use("/api/raw-materials", rawMaterialsRouter);

// 挂载台账业务路由（阶段B·校验/级联已迁移到后端，见 SQLite迁移规划.md）
app.use("/api/ledgers", ledgersRouter);
app.use("/api/ledger-items", ledgerItemsRouter);

// 挂载一二级配置业务路由（阶段C·校验/级联已迁移到后端，见 SQLite迁移规划.md）
app.use("/api/groups", groupsRouter);
app.use("/api/categories", categoriesRouter);

// 挂载杂项路由 (/api/log、/api/health)
app.use("/api", miscRouter);

// 挂载系统维护路由 (/api/system)
app.use("/api/system", systemRouter);

/**
 * @description 是否为开发模式：必须显式设置 NODE_ENV=development 才会进入开发模式（由 npm run dev 通过 cross-env 设置）。
 * 只要未显式声明为开发模式，一律按生产模式启动（含直接双击启动脚本、npm start、或忘记设置环境变量等场景），
 * 避免单机离线部署时因环境变量缺省而意外尝试加载仅开发环境才需要的 Vite 中间件。
 */
const isDevMode = process.env.NODE_ENV === "development";

/**
 * @description 挂载 Vite 开发中间件以保高画质更新（仅在开发模式下才动态引入 vite 包，
 * 单机离线生产部署时无需安装 vite 及其相关 devDependencies 也能正常启动，减小部署依赖体积）
 */
async function bootstrap() {
  if (isDevMode) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    console.log("[SYSTEM BOOT] 已成功以 VITE 实时 HMR 仿真宿主模式挂载 Express 客户端页面件");
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
    console.log("[SYSTEM BOOT] 生产模式启动：托管静态主包路径在 dist/");
  }

  // 挂载全局路由执行错误捕获器，确保服务端异常不引起停机且保留堆栈日志
  app.use((err: any, req: any, res: any, next: any) => {
    if (err.message === "VERSION_CONFLICT") {
      return res.status(409).json({ error: "数据已被其他终端修改，请刷新页面获取最新数据后重试" });
    }
    const errMsg = err instanceof Error ? `${err.message}\nStack: ${err.stack}` : String(err);
    console.error("[HTTP ERROR] 路由遭遇运行时内部执行异常:", err);
    LogService.write("ERROR", "ExpressRouter", `URL: ${req.method} ${req.url} - ${errMsg}`);
    res.status(500).json({ error: "服务器内部异常", details: err.message || String(err) });
  });

  // 绑定宿主 0.0.0.0 以绕过沙箱
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[KITCHEN SYSTEM LIVE] 服务就绪! 请访问外部绑定端口层: http://localhost:${PORT}`);
  });
}

// 监听进程级别未捕获异常
process.on("uncaughtException", (err) => {
  console.error("[FATAL ERROR] 捕获到未处理的致命运行时异常:", err);
  LogService.write("ERROR", "UncaughtException", `${err.message}\nStack: ${err.stack}`);
});

// 监听 Promise 异步未处理拒绝
process.on("unhandledRejection", (reason: any) => {
  console.error("[FATAL ERROR] 捕获到未处理的致命 Promise Rejection:", reason);
  const msg = reason instanceof Error ? `${reason.message}\nStack: ${reason.stack}` : String(reason);
  LogService.write("ERROR", "UnhandledRejection", msg);
});

bootstrap().catch((err) => {
  console.error("[FATAL ERROR] 启动服务器引擎阶段直接死亡:", err);
  LogService.write("ERROR", "Bootstrap", String(err));
});
