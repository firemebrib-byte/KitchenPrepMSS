# KPMSS 日志与数据审计约定

> 目的：当出现「数据丢了 / 数据对不上」时，能**按时间点在日志里精确回溯**——某条台账数据在哪一刻、由哪个请求、从什么值改成了什么值，或在哪一步被丢弃。
>
> 新增/修改任何会落库的功能时，**必须**按本文件补齐日志。Code review 时把「有没有加审计日志」作为一个检查项。

## 一、两条归档流

服务端日志统一由 `server/logService.ts` 的 `LogService` 写入 `data/logs/` 下，按日期分文件、单文件超 `LOG_MAX_FILE_SIZE_MB`（默认 5MB）自动滚动到 `.1.log`/`.2.log`……

| 文件 | 写入方法 | 内容 |
|---|---|---|
| `app-YYYY-MM-DD.log` | `LogService.write(level, category, message)` | 运行日志：HTTP 请求出入、系统启动、异常堆栈、客户端上报（`POST /api/log`）等。每条数据审计记录也会以 `[AUDIT]` 前缀**镜像**一份进来。 |
| `audit-YYYY-MM-DD.log` | `LogService.audit(action, detail, ctx?, severity?)` | **数据审计**：且仅有「数据被增/删/改成了什么」的结构化前后对照。排查数据问题时**优先只 grep 这个文件**。 |

前端（浏览器）日志经 `utils.ts` 的 `LogBroker.publish(level, module, message, details?)` → `POST /api/log` → 落进 `app-*.log`。前端无法直接写 `audit-*.log`，前端侧的数据丢失（如同步彻底失败）用 `LogBroker.publish("ERROR", ...)` 上报。

## 二、`LogService.audit(...)` 用法

```ts
LogService.audit(
  action,     // 点分动作名，见下表
  detail,     // 结构化前后对照串（见"detail 写法"）
  ctx,        // 请求上下文串，服务端业务方法里统一用 StorageService.auditCtx() 生成
  severity,   // "info"（默认）| "warn"（数据被跳过/未按预期写入）| "error"（写入失败/被丢弃）
);
```

产出的行形如：

```
[2026-09-03 15:30:12] [AUDIT] ledger.dailyRecord.update req=ab12cd34 PUT /api/ledger-items/x/daily/2026-09-03 baseVer=5 dbVer=5 | 台账逐日流水录入 item=ledger_item_KID_17..(土豆/KID) date=2026-09-03 | 请求字段: {"inQuantity":10,"inPrice":3.5} | 当日记录: updated | 变更: inQuantity 0 -> 10, inPrice 0 -> 3.5, inAmount 0 -> 35 | 库存: 0 -> 10 (累计入库 0 -> 10, 累计出库 0 -> 0)
```

### detail 写法约定

- 用 ` | ` 分段，段内 `字段 旧值 -> 新值` 逗号分隔。
- 逐字段差异统一用 `LogService.diffFields(before, after, fields)` 生成，口径一致（"增加了什么、减少了什么"）。
- 空值统一记作 `∅`（`LogService.fmt` 负责）。
- 删除类操作要把「连带删掉多少子数据」写清楚（如 `连带删除其逐日流水 12 条 (2026-08-01 ~ 2026-08-31)`）。
- 有级联时写清楚级联影响了哪些实体、多少行、可能的话列出主键。

### 请求上下文 `ctx`

服务端 `StorageService` 里所有业务方法用 `StorageService.auditCtx()` 取，内容为
`req=<reqId> <METHOD> <url> baseVer=<前端携带的版本号> dbVer=<当前库版本号>`。
`reqId` 由 `server.ts` 的中间件为每个 HTTP 请求生成，同一次请求在 `app-*.log` 与 `audit-*.log` 里的多条记录用它串联。

## 三、当前已埋点的动作名（`action`）

| action | 触发点 | severity |
|---|---|---|
| `persist.sqlite.stmts` | 每一批增量 `SyncOp` 的 SQLite 事务提交成功后，逐条列出实际执行的 prepared statement（语句名 + 绑定参数 + `changes=` 数据库实际影响行数，insert/upsert 还带 `rowid=`）。**这是回溯“数据库层面到底动了哪几行”的主依据**——例如某条 `deleteDailyRecord(...) -> changes=0` 说明代码以为删了、其实那行不存在。 | info |
| `persist.sqlite.rollback` | 事务执行中抛错、better-sqlite3 自动整体回滚（本批全部未生效）；列出回滚前已尝试的每条 SQL 及原因 | **error** |
| `persist.sqlite.fail` | `applyChangesIntoSqlite` 抛出后 `saveInternal` 兜底：本批变更未落盘的 op 级摘要 | **error** |
| `persist.cos.ok` / `persist.cos.fail` | COS 模式整体覆盖写回 | info / **error** |
| `sqlite.exec` | **仅当 `KPMSS_SQL_TRACE=1`**：SQLite 每执行一条 SQL（BEGIN/COMMIT/ROLLBACK 及每条 SELECT/INSERT/UPDATE/DELETE）都记一行语句原文。默认关闭，量很大，只在排查时临时开。 | info |
| `ledger.dailyRecord.update` | 单条台账逐日流水录入（`PUT /api/ledger-items/:id/daily/:date`） | info；清空导致整条删除时 **warn** |
| `ledger.dailyRecord.batch` | 批量录入（录入模式「确认提交」，`PUT /api/ledger-items/batch-daily/:date`），逐项列出前后变化 | info；有跳过项时 **warn** |
| `ledger.dailyRecord.batch.skip` | 批量录入里某 `itemId` 找不到 → **该原料这一行录入被静默丢弃**（数据丢失高发点） | **warn** |
| `ledger.item.add` / `ledger.item.update` / `ledger.item.delete` | 台账采购原料项增改删（删除时列出连带清掉的逐日流水条数与日期范围） | info；删除有流水时 **warn** |
| `ledger.rename` / `ledger.delete` | 台账改名 / 物理删除（删除列出级联清掉的原料项与流水条数） | info / **warn** |
| `dict.rawMaterial.add` / `dict.rawMaterial.update` / `dict.rawMaterial.delete` | 原料字典增改删。**字典与台账已解耦**：改名/删除字典条目**不再**级联改动台账里的同名采购项，只影响录入联想，日志会注明"台账已有数据不受影响" | info |
| `config.group.save` / `config.group.delete` | 一级人群配置增改删（删除列出级联清掉的台账与原料项） | info / **warn** |
| `config.category.save` / `config.category.delete` | 二级食材大类配置增改删 | info |
| `system.clearDailyRecords` / `system.clearDailyRecords.fail` | 后台「一键清空所有台账流水」（列出删除的行数） | **warn** / **error** |

前端 `SyncHelper`（`src/services/syncHelper.ts`）经 `LogBroker.publish` 上报进 `app-*.log` 的关键事件：

| message 关键字 | 触发点 | level |
|---|---|---|
| `增量同步连续重试 N 次仍失败，已放弃…（数据丢失）` | 防抖批量提交连续失败到上限、彻底放弃这批本地变更（`retryFailedBatch`） | **ERROR** |
| `已用服务器最新快照覆盖本地内存…` | `applyFreshData` 用服务器快照覆盖内存；**若覆盖时仍有未落盘的本地变更**会升级为 WARN 并注明可能覆盖掉未同步的录入 | INFO / **WARN** |

`server.ts` 中间件对每个 `POST/PUT/PATCH/DELETE` 请求写 `app-*.log`：入口一条（`收到写请求 baseVer=…`）、`res` 结束一条（`响应 <status> 用时 <ms>`，4xx→WARN、5xx→ERROR），可据此核对「这一刻发起了哪个写、结果是成功还是被 409/400/500 拒了」。

## 四、给新功能加日志的检查清单

1. **是不是会落库的操作？** 是 → 必须有一条 `LogService.audit(...)`。
2. **action 名**：`<域>.<对象>.<动作>`，沿用上表的域前缀（`ledger.` / `dict.` / `config.` / `system.` / `persist.`）。
3. **detail 里要能回答「在原有基础上增加了什么、减少了什么」**：
   - 改：`LogService.diffFields(before, after, [关心的字段])`；
   - 增：列出新对象的关键字段；
   - 删：列出被删对象的主键 + **连带删掉的子数据数量/范围**。
4. **ctx**：服务端业务方法传 `StorageService.auditCtx()`。
5. **severity**：数据被跳过/没按预期写 → `"warn"`；写入失败或本地变更被丢弃 → `"error"`。
6. **失败分支也要埋**：`saveInternal` 返回 `false`、`catch` 到异常、找不到目标行而跳过——这些正是数据丢失的来源，务必留痕。
7. 前端不可达服务端的失败（网络层彻底放弃同步等），用 `LogBroker.publish("ERROR", "<模块>", "<人话>", "<结构化细节>")`。
8. 补一条测试断言日志确实产生了（`logService.test.ts` 里已有 `audit` 的归档/滚动用例可参考）。
