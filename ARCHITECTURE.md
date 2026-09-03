# KPMSS 项目架构文档

> 本文档描述截至 **2026-07-13 台账为主转型完成后（[V2] 架构演进）** 的项目真实代码状态，而非重构计划。如后续代码结构继续演进，请同步更新本文档。
>
> **项目定位演进说明**：本项目最初以"备餐记账"（按人群×大类的月度日矩阵表格，可编辑）为核心功能，"原料购销台账"是后添加的辅助模块。2026-07-05～07-13 期间经历多轮重构（[V5.90.0]～[V5.99.0]、以及本文档标注的 [V2] 阶段），产品重心整体转向"原料购销台账"为主要数据录入入口，原备餐记账的独立可编辑数据模型（`GroupMonthlyReport`/`PreparedItem` 持久化实体、`reports`/`prepared_items` 数据表）已被完全删除，原备餐记账主表格现在是台账数据的**只读实时派生视图**。这次转型早期（[V5.95.0]）曾被记录为"主表格 `readOnly` 硬编码为既定设计"，最终阶段（本文档描述的现状）已经更彻底——不只是只读开关，整个独立报表数据源都不存在了。历史遗留的类名（`PrepReportService`）与部分注释仍沿用"报表"措辞，属已知的命名债务，未做跨仓库改名。

## 一、项目概述

KPMSS（食堂备菜管理和统计系统）是面向学校/机关食堂的原料购销台账与备餐记账统计系统。采用 **React 19 + TypeScript + Vite** 前端、**Express + Node.js** 后端的全栈架构，单进程打包部署（前后端不做部署层面的分离），数据持久化到本地 **SQLite**（默认）或腾讯云 COS 对象存储。

核心业务域有两个：
1. **原料购销台账（Ledger）**：按原料维度记录逐日出入库明细（供货商、采购员、检验员、保质期、感官性状等台账要素），支持"总表"与"单原料流水"两种打印/录入样式，是系统**唯一的数据录入与持久化入口**。
2. **备餐记账展示（TableGrid，历史上称 PrepReport）**：按受众人群（教师/幼儿/在校生等）× 食材大类（蔬菜/粮油/肉类等）的月度日矩阵表格/单日聚焦卡片两种视图，数据完全从台账 `LedgerItem.dailyRecords` 实时过滤聚合派生，不持久化、不可编辑，纯粹是台账数据的另一种阅读方式（见三）。

管理后台（Admin）提供受众人群、食材大类、原料字典、台账人员与供货商四类基础配置的增删改查。

## 二、目录结构总览

```
KPMSS/
├── server.ts                 # 后端入口：Express 初始化、中间件、路由挂载、Vite 中间件/静态托管、进程级异常捕获
├── server/
│   ├── storageService.ts     # StorageService：本地 SQLite / 腾讯云 COS 双模式持久化 + 业务校验/重算/级联方法（见四、五）
│   ├── logService.ts         # LogService：服务端结构化日志的写入与轮转
│   └── routes/
│       ├── storage.ts        # /api/storage/load|save：全量读取与增量写入（阶段三 SyncOp 协议，见 4.2）
│       ├── rawMaterials.ts   # /api/raw-materials：原料字典增删改（阶段A迁移）
│       ├── ledgers.ts        # /api/ledgers、/api/ledger-items：台账及其原料项/逐日流水增删改（阶段B迁移）
│       ├── reports.ts        # /api/groups、/api/categories：一二级配置增删改（阶段C迁移）
│       └── misc.ts           # /api/log、/api/health 两个杂项路由
├── src/
│   ├── main.tsx               # 前端挂载入口
│   ├── App.tsx                # 应用根组件与顶层外壳（登录/加载态、侧边栏、工具栏、各功能模块路由编排）
│   ├── utils.ts                # 通用工具函数（拼音匹配、CSV 转换、日志上报客户端等）
│   ├── services/              # 业务数据服务层（客户端 pub/sub 单例，负责内存状态管理 + 与后端通信，见三）
│   │   ├── store.ts              # PrepReportService：仅剩一二级人群/大类配置（类名是转型前的命名遗留，不再管理任何"报表"）
│   │   ├── ledgerStore.ts        # LedgerService：原料购销台账，系统唯一的数据持久化写入口
│   │   ├── rawMaterialDict.ts    # RawMaterialsDictService：原料字典
│   │   └── syncHelper.ts         # SyncHelper：读路径（loadFromServer/refreshNow）+ 少数纯前端方法仍在用的写路径（queueChange 等，见 3.3）
│   ├── types/
│   │   ├── types.ts              # 备餐记账展示相关类型（TargetGroup、PreparedItem 派生视图行等）
│   │   └── ledgerTypes.ts         # 台账相关类型（Ledger、LedgerItem、FoodCategory 等），系统唯一的持久化数据模型
│   ├── constants/
│   │   ├── constants.ts           # 备餐记账展示层 UI 文案与配置常量
│   │   └── ledgerConstants.ts     # 台账 UI 文案、打印模板配置常量
│   ├── hooks/                  # 自定义 Hook：从大型组件中抽取的状态/副作用逻辑
│   │   ├── useAppAuth.ts          # 登录态、管理员密码校验
│   │   ├── useAppData.ts          # 三大服务的首屏并行初始化与数据变动订阅（App.tsx 的核心数据加载，不含心跳轮询，见 3.3）
│   │   ├── useLedgerData.ts       # 台账列表/条目数据加载与订阅（LedgerSystem.tsx 用）
│   │   ├── useLedgerRecording.ts  # 台账录入模式状态机（草稿态、确认/取消提交，含同步确认等待逻辑）
│   │   └── useTableTheme.ts       # 备餐记账表格主题切换（TableGrid.tsx 用）
│   └── components/
│       ├── admin/                # 管理后台：AdminBackend + 4 个配置 Tab 子组件
│       ├── ledger/                # 原料购销台账：LedgerSystem 顶层编排 + 子组件（双样式表格/打印/控制栏等），系统唯一的数据录入入口
│       ├── inventory/             # 库存总览：InventoryPanel + TableGrid（矩阵/单日聚焦两种视图子组件），完全从台账数据实时派生的只读展示
│       └── shared/                # 跨业务域复用组件：ErrorBoundary、SearchableSelect、HelperSelect、SensorySelector
├── readme_zh.md                # 中文 README + 逐版本 Changelog（仅追加，不改历史）
├── 提示词历史记录.md / prompt_history.md   # AI 提示词变更历史（仅追加，不改历史）
├── 部署指南.md                  # 单机离线部署操作手册（权威部署文档）
├── SQLite迁移规划.md            # SQLite 迁移三阶段规划与实施记录（历史参考文档）
├── LOGGING.md                  # 日志与数据审计约定（新增/改动落库功能必须按此补日志，见八）
└── ARCHITECTURE.md              # 本文档
```

## 三、数据流向

前端三个业务 Service（`PrepReportService`、`LedgerService`、`RawMaterialsDictService`）都是 pub/sub 单例：内存持有当前数据，`subscribe(listener)` 供组件订阅变化，内部变更后 `notifyListeners()` 触发重渲染。但**写操作的落盘方式因方法而异**——这是三阶段重构留下的核心架构特征，不是过渡态：

### 3.0 台账为主的展示层派生（[V2] 架构演进核心变化）

`TableGrid`（备餐记账主表格，历史上称"报表"）不再持有任何自己的持久化数据。它接收 `App.tsx` 传下来的 `ledgerItemsList`（`LedgerService` 当前内存里的全部 `LedgerItem[]`），在组件内部用 `useMemo` 按 `ledgerId`（对应人群）、原料字典分类、当月有效天数实时过滤/聚合成展示行（`filteredItems`/`summaryDailyTotals`，见 `TableGrid.tsx`）。这意味着：
- **没有独立的写路径**：不存在"编辑备餐细项"这回事，`TableGrid` 及其子视图 `TableGridMatrixView`/`TableGridFocusView` 完全只读，唯一的数据录入入口是台账页面（`LedgerSystem.tsx`）。
- **没有同步延迟风险**：因为不是"台账写入 → 反向同步进另一份报表数据 → 报表展示"，而是"台账写入 → 展示层下一次渲染直接读到最新台账数据"，天然不存在两份数据对不齐的问题（这类问题曾在旧架构下真实出现过，见 [V5.97.0]）。
- **`src/utils.ts` 的 `computeLedgerDailyAmountsByGroup()`** 收敛了"按人群过滤台账、按当月有效天数逐日求和"这段此前在 `App.tsx`（侧边栏合计）与 `TableGrid.tsx`（合计汇总表）各自独立实现的逻辑，避免同一段统计口径在两处漂移。

### 3.1 REST 校验型写路径（阶段A/B/C迁移后的主流路径）

大多数会触碰校验规则、级联删除/更新、金额或库存重算的写操作，直接 `fetch()` 对应的 REST 端点，由后端 `StorageService` 的业务方法（见四）完成校验与持久化，前端只负责：
1. 发起请求，`!res.ok` 时把后端返回的 `{ error }` 文案包成 `Error` 抛出（错误文案与迁移前的纯前端实现逐字一致，调用方 UI 的 `catch` 逻辑不用改）。
2. 用响应体里返回的完整实体更新自己的内存（不再自己重新计算一遍校验/重算逻辑）。
3. 若这次操作有跨服务级联效果（如改台账名字连带改一级人群标签），调用 `SyncHelper.refreshNow()` 立即拉取一次最新全量状态并应用（见 3.1/3.3）——这是为了修复"级联结果需要等待才能看到"的显示延迟问题（见 [V5.89.0]/[V5.91.0]）。**例外**：`updateDailyRecord`（出入库单元格编辑，全系统最高频写操作）不调用 `refreshNow()`，而是让后端直接在响应体里返回级联后的台账原料项，前端做零网络开销的局部内存更新（`LedgerService.setLedgerItemsInMemory()` + `forceNotify()`），避免每次编辑都触发一次全量往返（见 [V5.93.0]）。

### 3.2 纯前端内存写路径（架构约束下刻意保留，非迁移遗漏）

少数方法因为架构原因无法（或暂不适合）迁移成异步 REST 调用，仍然是"改内存 + `SyncHelper.queueChange(op)` 排队 + 200ms 防抖批量 `POST /api/storage/save`"的旧模式：

| 方法 | 所在文件 | 保留原因 |
|---|---|---|
| `syncGroupFromLedger()`/`syncDeleteGroupFromLedger()` | `store.ts` | 级联效果已由后端 `saveGroup`/`deleteGroup` 一次事务完成，生产代码已不再调用，仅保留自身单元测试 |
| `syncLedgerFromGroup()`/`syncDeleteLedgerFromGroup()` | `ledgerStore.ts` | 级联效果已由后端 `updateLedger`/`deleteLedger` 一次事务完成，生产代码已不再调用，仅保留自身单元测试 |
| `initDictFromServer()` 的历史脏数据去重回写 | `rawMaterialDict.ts` | 首启发现服务器数据存在同名重复项时的自愈回写，属于批量场景非用户增量编辑 |

> [V2] 此前列在这里的 `getOrCreateReport()`/`syncFromLedger()`（`store.ts`）与 `cascadeUpdateMaterial()`/`cascadeDeleteMaterial()`（`ledgerStore.ts`/`store.ts`）已随备餐报表双状态整体删除，不再需要任何反向同步——见 3.0。

`SyncHelper` 的 `queueChange`/`pendingOps`/`scheduleFlush`/`flush`/`retryFailedBatch`/`runWhenInitialized`/`isInitialized` 这套写路径基础设施仍是生产代码真实调用路径，作为永久性架构结论保留（见 [V5.93.0]），不再重新评估。

### 3.3 读路径

```
应用冷启动 → useAppData → GET /api/storage/load → StorageService 读取并拼装 → 三个 Service 各自初始化内存
级联操作成功后 → SyncHelper.refreshNow()（= loadFromServer() + applyFreshData()，不做竞态守卫）立即刷新，见 3.1
```

> [V2 架构演进，2026-07-07 commit `76f8061`] 此前"每 10 秒静默拉取全量状态覆盖内存"的心跳轮询机制，已随"按月懒加载 + 304 缓存"改造被移除（轮询整份状态与按需分月加载的设计目标冲突）。**这意味着多端数据一致性不再有自动兜底**：如果两个浏览器/设备同时打开系统，一端的修改不会在 10 秒内自动同步到另一端的界面上，需要手动刷新页面才能看到。当前的一致性保障只剩两层：① 写操作各自的 `refreshNow()` 保证操作者自己立即看到最新数据；② `fetchWithVersion` 的 `X-Base-Version`/409 乐观并发冲突检测，防止两端同时写入时静默覆盖对方的修改（但不解决"看不到对方已写入的新数据"这个纯读场景）。是否需要为多端场景重新引入某种刷新机制，是留给后续评估的产品/架构决策，不在本次问题清单范围内。

## 四、后端业务方法（`server/storageService.ts`）

阶段A/B/C迁移后，`StorageService` 除了原有的 `load()`/`save()` 全量读写，还新增了一批做业务校验/重算/级联的方法，每个方法内部遵循同一个模式：

```ts
public static async someMutation(...): Promise<T> {
  // 1. 参数校验（不通过则 throw new Error("与迁移前逐字一致的中文错误文案")）
  return StorageService.withWriteLock(async () => {
    const current = await StorageService.load();   // 2. 读取当前完整状态
    // 3. 在纯 JS 里计算结果、构造一批 SyncOp[]（含跨实体级联，如改台账名连带改人群配置）
    const ok = await StorageService.saveInternal(ops);  // 4. 复用既有的增量持久化引擎一次性提交
    return result;
  });
}
```

这个"op-batch 级联"模式是三个阶段共用的核心设计：级联不再手写额外的 SQL `UPDATE...WHERE`，而是把级联影响到的每一行都构造成一个 `SyncOp` 追加进同一个数组，一起交给已经过充分测试的 `saveInternal()`（本地 SQLite 走 `applyChangesIntoSqlite()`，包在一个 `db.transaction()` 里；COS 模式走 `applyOpsToPlainObject()`），天然获得事务原子性，也天然获得 COS 模式的等价支持，不需要为级联单独写第二套实现。

**当前业务方法清单**（按迁移阶段分组，路由映射见五）：

| 阶段 | 方法 | 级联影响 |
|---|---|---|
| A | `addRawMaterial`/`updateRawMaterial`/`deleteRawMaterial` | 改名/删除级联更新台账 `ledger_items` 里的同名条目 |
| B | `addLedgerItem`/`updateLedgerItem`/`deleteLedgerItem` | 库存 `currentStock` 重算 |
| B | `updateLedgerDailyRecord` | 逐日流水合并/重算（`mergeLedgerDailyRecord` 私有辅助方法） |
| B | `updateLedger`/`deleteLedger` | 同步/删除对应一级人群配置 `active_groups` |
| C | `saveGroup`/`deleteGroup` | 同步创建/改名/删除对应台账 |
| C | `saveCategory`/`deleteCategory` | 二级大类的增删改（[V2] 起不再有报表可供级联清空，见下） |

> [V5.95.0] `addPreparedItem`/`updateCell`/`deletePreparedItem`（餐位分组页面下备餐细项的增/改/删）与 `batchUpdatePriceCol`（一键批量调价）四个方法及其对应 REST 端点已被确认为死代码删除——当时排查确认主报表展示屏的 `readOnly` 硬编码为 `true` 是 [V5.2.0] 就已存在的产品设计，这四个方法从未有任何 UI 入口能触发。
>
> **[V2] 在此基础上更进一步**：`reports`/`prepared_items`/`prepared_item_daily_data` 三张表与 `PrepReportService` 里对应的 `getOrCreateReport`/`syncFromLedger`/`cascadeUpdateMaterial`/`cascadeDeleteMaterial`/`cascadeDeleteLedgerItem` 等全部方法已整体删除——不只是"没有编辑入口"，连"以独立数据形式存在"这件事本身都不再需要，`TableGrid` 现在直接从 `LedgerItem` 实时派生渲染（见三.0）。因此上表 A/B 两阶段方法原先"级联更新/清理 prepared_items 同名条目"的效果也一并消失（改名/删除原料时只需级联更新台账，无需再级联一份报表副本）。

## 五、持久化设计与路由一览

### 5.1 存储后端

`StorageService` 支持两种存储后端，由 `.env` 的 `STORAGE_TYPE` 切换：
- **`local`**（默认）：本地 **SQLite**（`data/kpmss.sqlite`，WAL 模式），规范化关系型表结构（`ledgers`/`ledger_items`/`ledger_item_daily_records`/`active_groups`/`active_categories`/`raw_materials_dict`/`ledger_helper_options`/`sys_config` 共 8 张表）。逐日流水（台账每日出入库）独立成表，按 `(item_id, date)` 复合主键存储，而非拍平进一个大 JSON 字段。`sys_config` 存放乐观并发版本号 `db_version`（见 `fetchWithVersion`/`X-Base-Version`）。[V2] 起原备餐报表专用的 `reports`/`prepared_items`/`prepared_item_daily_data` 三张表已被主动 `DROP TABLE`，不再存在。
- **`cos`**：读写腾讯云 COS 对象存储的等价 JSON 对象（`applyOpsToPlainObject()` 在内存里模拟同样的 upsert/delete 语义后整体序列化写回）。

### 5.2 增量写协议（阶段三，`SyncOp[]`）

`POST /api/storage/save` 接受 `{ protocolVersion: 2, ops: SyncOp[] }`，每个 `SyncOp` 描述"哪个实体的哪一行该 upsert 还是 delete"（见 `server/storageService.ts` 顶部 `SyncOpEntity`/`SyncOp` 类型定义）。这个协议目前有两类调用方：
1. 四、里列出的业务方法内部构造 op 数组自己调用 `saveInternal()`（不经过 HTTP，同进程内直接调用）。
2. 三.2 里仍保留纯前端逻辑的写路径，经 `SyncHelper` 200ms 防抖后打包成一次 `POST /api/storage/save`。
3. 首次启动/批量种子数据生成使用 `op: "replaceAll"`（整体替换该实体全部行）。

### 5.3 备份

系统本身**不含任何自动备份/快照/恢复机制**（[V5.90.0] 起彻底移除，此前的本地/COS JSON 快照是一个前端从未调用过的孤儿功能）。数据安全性完全依赖 SQLite 事务+WAL（本地模式）或云厂商多副本冗余（COS 模式），灾难恢复由客户自行定期做操作系统级的 `data/` 目录整体备份，详见 [部署指南.md](部署指南.md) 第五章。

### 5.4 路由一览

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/storage/load` | GET | 加载全量数据（含逐日流水的透明拼装） |
| `/api/storage/save` | POST | 增量写入（`SyncOp[]` 协议，见 5.2），仅供三.2 纯前端写路径与首启种子数据使用 |
| `/api/raw-materials` | POST | 新增原料字典条目 |
| `/api/raw-materials/:oldName` | PUT | 改名/编辑原料字典条目（级联更新台账同名项） |
| `/api/raw-materials/:name` | DELETE | 删除原料字典条目（`isDefault` 保护，级联清理台账同名项） |
| `/api/ledgers/:id` | PUT | 改名台账（级联同步人群配置） |
| `/api/ledgers/:id` | DELETE | 删除台账（级联清理原料项/人群配置） |
| `/api/ledgers/:ledgerId/items` | POST | 新增台账原料项 |
| `/api/ledger-items/:id` | PUT | 编辑台账原料项（重算库存） |
| `/api/ledger-items/:id` | DELETE | 删除台账原料项 |
| `/api/ledger-items/:id/daily/:date` | PUT | 更新某原料某天的出入库流水（重算库存） |
| `/api/groups/:key` | PUT | 新增/编辑一级人群配置（级联同步台账） |
| `/api/groups/:key` | DELETE | 删除一级人群配置（`isDefault` 保护，级联清理对应台账） |
| `/api/categories/:key` | PUT | 新增/编辑二级食材大类 |
| `/api/categories/:key` | DELETE | 删除二级食材大类（`isDefault` 保护） |
| `/api/log` | POST | 客户端错误/性能日志上报 |
| `/api/health` | GET | 健康检查 |

## 六、已知的架构边界与待办

1. **COS 云存储模式未做实际联调测试**，仅确认代码路径类型检查通过与逻辑镜像本地模式；如启用建议先做独立端到端验证。
2. **`SyncHelper` 写路径长期保留**（见 3.2），不是待清理项，是架构结论。
3. **多端数据一致性无自动兜底**（见三.3）：心跳轮询已于 2026-07-07 移除，两个浏览器/设备之间的读一致性目前只能靠手动刷新，是否需要重新引入某种刷新机制留待后续产品决策评估。
4. **`PrepReportService` 类名是转型前的命名遗留**：该类现在只管理一二级人群/大类配置，不再管理任何"报表"，跨仓库改名（涉及 20+ 处引用）风险大于收益，暂不处理，新增代码注意不要被类名误导。
5. **`useLedgerRecording.test.ts` 存在与本次台账为主转型无关的既有测试基础设施问题**：`handleConfirmRecording` 相关 5 个用例依赖的通用 fetch mock 未能正确模拟 `updateDailyRecordsBatch` 实际读取的响应体形状，导致这几个用例在当前代码库上持续失败，需要单独排查修复，不在本次问题清单范围内。
6. **`server/__tests__/` 目录下的路由/服务测试相对导入路径未随 2026-07-08 的"测试框架结构性重构"更新**（如 `logService.test.ts` 内 `./logService.ts` 实际应为 `../logService.ts`），导致 `tsc --noEmit` 报模块找不到，属于该次重构遗留、与本次台账转型无关的独立问题。
7. **未合并到 `main` 分支** —— 本轮所有改动固定在 `dev` 分支上。

## 七、自动化测试体系

> 详见 [V5.55.0] 起的变更记录。项目使用 Vitest 作为常驻回归安全网。

### 7.1 技术选型

- **Vitest**：与 `vite.config.ts` 原生集成。
- **@testing-library/react** / **jest-dom** / **user-event**：组件与 Hook 测试。
- **supertest**：后端 Express 路由 HTTP 层集成测试，测试文件内构造只挂载对应 router 的最小 Express 实例（不导入有 `app.listen()` 副作用的 `server.ts` 本身）。
- **jsdom**：前端测试环境；后端 `server/**` 目录测试通过 `environmentMatchGlobs` 使用 `node` 环境。
- 未引入 Playwright 等浏览器端到端测试，只做单元/集成测试。

### 7.2 覆盖范围

- **业务逻辑层高覆盖**：`src/utils.ts`、`src/services/*.ts`（含阶段A/B/C迁移后重写的 fetch 断言）、`src/hooks/*.ts`、`server/storageService.ts`（含四、里列出的全部业务方法）、`server/logService.ts`、`server/routes/*.ts`（`storage`/`rawMaterials`/`ledgers`/`reports`/`misc` 五个路由文件均有独立集成测试；`reports.ts` 现在只承载一二级人群/大类配置的增删改路由，与已删除的备餐报表数据无关，文件名是历史命名遗留）。
- **关键交互组件**：`HelperSelect`、`LedgerPrintModal`、`LedgerPrintStyle1`、`LedgerPrintStyle2Consumable`、`LedgerStyle1Table`、`LedgerStyle2Flow`、`TableGrid`、`TableGridMatrixView`、`TableGridFocusView`。纯展示型组件不在覆盖范围内。
- 测试文件采用就近同目录 `*.test.ts(x)` 命名。用例总数随功能演进持续变化，以 `npm test` 实际运行结果为准，不在本文档写死具体数字；本机沙盒环境因 `better-sqlite3` 原生绑定与 Node 版本不匹配、以及跑全量测试文件时观察到的 V8 堆内存溢出，无法一次性跑通全量 `npm test`（分批按目录跑不受影响），详见 [readme_zh.md](readme_zh.md) 对应记录。

### 7.3 运行方式

```bash
npm test               # 全量跑一次（CI / 提交前使用）
npm run test:watch     # 监听模式，开发时使用
npm run test:coverage  # 生成覆盖率报告
```

### 7.4 测试隔离要点

- 前端 `private static` 状态的服务类（`LedgerService`/`PrepReportService`/`RawMaterialsDictService`）复用其已有的 `setXInMemory()` 方法在用例间重置内存状态。
- 后端 `StorageService`/`LogService` 在模块加载时从 `process.env.*` 读取路径并绑定到 `private static` 字段；测试通过 `vi.resetModules()` + 动态 `import()` + 临时目录（`fs.mkdtempSync`）为每个用例拿到全新绑定的类实例，杜绝相互污染，也**杜绝任何测试清理逻辑触碰真实的 `data/` 目录**。
- 涉及"删除唯一一行数据"的测试需额外造一条不相关的"锚点"数据（如多加一本台账），避免规范化表结构全空时 `GET /load` 退化返回首启空壳 `{}`，无法验证"确实只删了目标行"（已知边界行为，详见 `storageService.test.ts`）。
- 阶段A/B/C迁移后新增的 REST 集成测试统一使用镜像后端语义的轻量假 `fetch` 路由（如 `fakeLedgerFetch`/`fakePrepReportFetch`）支撑前端 service 测试文件里大量"先增后改/先增后删"的多步测试序列，而非逐个用例手写 canned 响应。

## 八、日志与数据审计

服务端有两条独立归档流写入 `data/logs/`：`app-YYYY-MM-DD.log`（运行日志，`LogService.write`）与 `audit-YYYY-MM-DD.log`（**数据审计**，`LogService.audit`——只记「某条数据在哪一刻由哪个请求从什么值改成了什么值 / 在哪一步被丢弃」，是数据丢失排查的首要依据）。`StorageService` 的**每一个落库方法**都会在成功/失败后写一条 `audit` 记录（逐字段 `旧值 -> 新值`、级联影响、库存与累计重算前后值），`server.ts` 中间件为每个写请求分配 `reqId` 串联两条流。前端 `SyncHelper` 把"增量同步彻底放弃（数据丢失）""服务器快照覆盖了未落盘的本地录入"经 `LogBroker.publish` 上报进 `app-*.log`。

**新增或修改任何会落库的功能，必须按 [LOGGING.md](LOGGING.md) 的检查清单补齐 `LogService.audit(...)`**（含失败/跳过分支）。Code review 把这一项作为必查项。

## 九、原料字典与台账解耦（master data / transactional data 分离）

原料字典（`raw_materials_dict`）是**主数据/建议清单**，只服务于台账录入时的联想与默认值；台账采购原料项（`ledger_items`）及其逐日流水是**交易数据**。两者生命周期彻底分开：

- `ledger_items` 增加了 **`category` 快照列**：新建采购原料项时从字典按 `name` 抄一次分类，之后与字典独立。`name`/`unit`/`spec` 本就已在 `ledger_items` 上，加上 `category` 后台账项**自描述**，展示层不再回字典按 name 反查分类。旧库首启时 `getDb()` 幂等 `ALTER TABLE ... ADD COLUMN category` 并按字典回填一次。
- **字典改名/删除不再级联台账**：`updateRawMaterial`/`deleteRawMaterial` 只写 `raw_materials_dict` 一张表，台账里的同名采购项与全部历史流水原样保留。（此前的级联会把"删除字典条目"变成"物理删除数月采购记录"，且弹窗文案与实际行为相反。）
- 展示层对"分类快照为空"的孤立项（字典查不到、或建项在升级前）统一归入 **未分类**（`UNCATEGORIZED_CATEGORY_KEY`，见 `src/constants/constants.ts` 的 `resolveLedgerItemCategory`），不会再从总表/合计汇总/打印里消失。
- 已删除的死代码：`LedgerService.cascadeUpdateMaterial` / `cascadeDeleteMaterial`。
