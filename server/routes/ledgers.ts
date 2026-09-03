/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 台账相关路由（阶段B·业务规则迁移到后端，见 SQLite迁移规划.md）：
 * `ledgersRouter` 挂载在 /api/ledgers 前缀下，提供台账本身的改名/删除与新增采购项目接口；
 * `ledgerItemsRouter` 挂载在 /api/ledger-items 前缀下，提供采购项目的改/删与每日出入库流水更新接口。
 * 校验/级联规则均在 StorageService 对应方法内实现，本路由只负责把 HTTP 请求转成方法调用、
 * 把业务校验错误转成 400 响应。
 */

import express from "express";
import { StorageService } from "../storageService.ts";

/**
 * @description 台账路由 Router 实例（/api/ledgers）
 */
export const ledgersRouter = express.Router();

/**
 * @description 台账原料项目路由 Router 实例（/api/ledger-items）
 */
export const ledgerItemsRouter = express.Router();

/**
 * @description 重命名台账，级联同步餐位人群配置
 * @route PUT /api/ledgers/:id
 */
ledgersRouter.put("/:id", async (req, res) => {
  try {
    const { name } = req.body ?? {};
    const ledger = await StorageService.updateLedger(req.params.id, name);
    res.json({ success: true, ledger });
  } catch (err: any) {
    console.error("[API LEDGER UPDATE ERROR]", err);
    res.status(400).json({ error: err.message || "更新台账失败" });
  }
});

/**
 * @description 物理删除台账，级联删除其下原料项目与对应的餐位人群配置
 * @route DELETE /api/ledgers/:id
 */
ledgersRouter.delete("/:id", async (req, res) => {
  try {
    await StorageService.deleteLedger(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    console.error("[API LEDGER DELETE ERROR]", err);
    res.status(400).json({ error: err.message || "删除台账失败" });
  }
});

/**
 * @description 为指定台账新增采购项目（原料明细）
 * @route POST /api/ledgers/:ledgerId/items
 */
ledgersRouter.post("/:ledgerId/items", async (req, res) => {
  try {
    const { name, unit, spec, initialStock, category } = req.body ?? {};
    const item = await StorageService.addLedgerItem({ ledgerId: req.params.ledgerId, name, unit, spec, initialStock, category });
    res.json({ success: true, item });
  } catch (err: any) {
    console.error("[API LEDGER ITEM ADD ERROR]", err);
    res.status(400).json({ error: err.message || "新增原料失败" });
  }
});

/**
 * @description 修改采购项目（原料）的基本信息，重新核算当前库存
 * @route PUT /api/ledger-items/:id
 */
ledgerItemsRouter.put("/:id", async (req, res) => {
  try {
    const { name, unit, spec, initialStock, category } = req.body ?? {};
    const item = await StorageService.updateLedgerItem(req.params.id, { name, unit, spec, initialStock, category });
    res.json({ success: true, item });
  } catch (err: any) {
    console.error("[API LEDGER ITEM UPDATE ERROR]", err);
    res.status(400).json({ error: err.message || "更新原料失败" });
  }
});

/**
 * @description 物理删除采购项目（原料），级联清理其逐日流水
 * @route DELETE /api/ledger-items/:id
 */
ledgerItemsRouter.delete("/:id", async (req, res) => {
  try {
    await StorageService.deleteLedgerItem(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    console.error("[API LEDGER ITEM DELETE ERROR]", err);
    res.status(400).json({ error: err.message || "删除原料失败" });
  }
});

/**
 * @description 更新指定原料在指定日期的出入库流水字段，重算入库金额与实时库存
 * @route PUT /api/ledger-items/:id/daily/:date
 */
ledgerItemsRouter.put("/:id/daily/:date", async (req, res) => {
  try {
    const result = await StorageService.updateLedgerDailyRecord(req.params.id, req.params.date, req.body ?? {});
    res.json({ success: true, item: result.item, mergedRecord: result.mergedRecord });
  } catch (err: any) {
    console.error("[API LEDGER DAILY RECORD UPDATE ERROR]", err);
    res.status(400).json({ error: err.message || "保存出入库记录失败" });
  }
});

/**
 * @description 批量更新指定台账下多个原料在指定日期的出入库流水字段，重算入库金额与实时库存
 * @route PUT /api/ledger-items/batch-daily/:date
 */
ledgerItemsRouter.put("/batch-daily/:date", async (req, res) => {
  try {
    const { updates } = req.body ?? {};
    if (!updates || typeof updates !== "object") {
      return res.status(400).json({ error: "批量更新参数格式不正确" });
    }
    const result = await StorageService.updateLedgerDailyRecordsBatch(req.params.date, updates);
    res.json({ success: true, updatedItems: result.updatedItems, mergedRecords: result.mergedRecords });
  } catch (err: any) {
    console.error("[API LEDGER DAILY RECORDS BATCH UPDATE ERROR]", err);
    res.status(400).json({ error: err.message || "批量保存出入库记录失败" });
  }
});
