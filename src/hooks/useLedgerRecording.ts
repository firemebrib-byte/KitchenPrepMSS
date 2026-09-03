/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 封装台账"今日录入模式"状态机的自定义 Hook：管理录入模式开关、当日采购/出入库草稿数据（含 LocalStorage 缓存读写），以及开始录入、单元格草稿变更、确认提交、取消录入四个核心动作。
 */

import { useEffect, useRef, useState } from "react";
import { LedgerItem, DailyStockRecord } from "../types/ledgerTypes.ts";
import { LedgerService } from "../services/ledgerStore.ts";
import { SyncHelper } from "../services/syncHelper.ts";
import { RawMaterialsDictService } from "../services/rawMaterialDict.ts";
import { LogBroker } from "../utils.ts";

/** 一条被按“全 0 / 空串”占位初始化的草稿模板（该原料在所选日期尚无记录，或数据未进前端内存时使用） */
const BLANK_DRAFT: DailyStockRecord = {
  inQuantity: 0, inPrice: 0, inAmount: 0, outQuantity: 0, note: "",
  certification: "", sensoryProperty: "", supplier: "", buyer: "", inspector: "", keeper: ""
};

/**
 * @description 判断一个字段值是否“填了东西”（数字 > 0、字符串非空）。
 */
function isMeaningfulValue(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v) && v > 0;
  if (typeof v === "string") return v.trim().length > 0;
  return v != null;
}

/**
 * @description 逐字段比对录入草稿相对“开启录入那一刻的初始值（基线）”的净变化，只返回用户真正改动过的字段。
 * 关键作用：确认提交时只把“用户实际改了的字段”发给后端，而不是把整条草稿（含大量占位 0/空串）整体发过去。
 * 否则当某原料在所选日期其实已有记录、但因按月懒加载没进前端内存、草稿被按全 0 模板初始化时，
 * 整条草稿提交会把该日已保存的数量/单价/供货商/检验员等字段一并写空，造成“录入过的蔬菜没了”。
 *
 * - `seedIsReal = true`（基线取自已加载的真实记录）：做完整逐字段 diff，允许把字段改成任意值（含清空）。
 * - `seedIsReal = false`（基线只是占位模板）：只接受“填了东西”的字段，绝不下发会把已有数据清空的占位值。
 *
 * 已知取舍(R10)：seedIsReal=false 时无法表达“清空某个字段”——编辑一个真实数据未加载的行、把值填了又删（净空），
 * 该字段不会进 delta、真实值被保留。方向安全（不误删），代价是跨月字段要先切到该月加载后才能清空。刻意为之。
 *
 * @param seed 基线草稿
 * @param draft 当前草稿
 * @param seedIsReal 基线是否取自已加载到内存的真实记录
 * @returns 仅含变化字段的 Partial（无变化则为空对象）
 */
function computeDraftDelta(
  seed: Partial<DailyStockRecord> | undefined,
  draft: Partial<DailyStockRecord> | undefined,
  seedIsReal: boolean
): Partial<DailyStockRecord> {
  const delta: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(seed || {}), ...Object.keys(draft || {})]);
  for (const k of keys) {
    const a = (seed as any)?.[k];
    const b = (draft as any)?.[k];
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    if (seedIsReal || isMeaningfulValue(b)) {
      delta[k] = b;
    }
  }
  return delta as Partial<DailyStockRecord>;
}

/**
 * @description useLedgerRecording 入参接口
 */
export interface UseLedgerRecordingParams {
  /** 当前选中的台账唯一标识ID */
  activeLedgerId: string;
  /** 当前选择进行数据同步的日期 (格式 YYYY-MM-DD) */
  selectedDate: string;
  /** 所有的采购原料项目列表 */
  ledgerItems: LedgerItem[];
  /** 触发自动同步成功气泡提示的回调 */
  onSaveToast: (message: string, durationMs?: number) => void;
  /** 触发错误提示的回调 */
  onError: (message: string, durationMs?: number) => void;
}

/**
 * @description useLedgerRecording 返回值接口
 */
export interface UseLedgerRecordingResult {
  /** 当前选定台账与日期是否正处于"录入中"状态 */
  isRecordingMode: boolean;
  /** 处于录入模式时，存储的当前日采购及出库草稿数据 */
  draftRecords: Record<string, DailyStockRecord>;
  /** 启动录入模式，优先从本地缓存读取未确认的草稿数据 */
  handleStartRecording: () => void;
  /** 录入模式下，更新草稿内存与 LocalStorage 缓存 */
  handleDraftCellChange: (itemId: string, fields: Partial<DailyStockRecord>) => void;
  /** 确认提交并同步数据，保存至数据库并清空本地 LocalStorage 缓存 */
  handleConfirmRecording: () => Promise<void>;
  /** 放弃当前草稿录入（不会清除本地缓存，下次点击录入可找回） */
  handleCancelRecording: () => void;
}

/**
 * @description 管理台账"今日录入模式"开关、草稿数据与确认/取消动作的自定义 Hook
 */
export function useLedgerRecording({
  activeLedgerId,
  selectedDate,
  ledgerItems,
  onSaveToast,
  onError
}: UseLedgerRecordingParams): UseLedgerRecordingResult {
  /** 当前选定台账与日期是否正处于"录入中"状态 */
  const [isRecordingMode, setIsRecordingMode] = useState<boolean>(false);
  /** 处于录入模式时，存储的当前日采购及出库草稿数据 */
  const [draftRecords, setDraftRecords] = useState<Record<string, DailyStockRecord>>({});
  /**
   * @description 开启录入那一刻各行的初始草稿基线（真实已存记录的副本，或全 0 占位模板）。
   * 确认提交时用它做逐字段 diff，只提交用户真正改过的字段，避免整条占位草稿把已有数据覆盖写空。
   */
  const baselineRecordsRef = useRef<Record<string, Partial<DailyStockRecord>>>({});
  /** 基线取自“已加载到内存的真实记录”的行 id 集合（这些行允许把字段改成任意值，包括清空） */
  const baselineRealIdsRef = useRef<Set<string>>(new Set());

  // 当切换台账或修改日期时，退出录入模式并清理内存草稿
  useEffect(() => {
    setIsRecordingMode(false);
    setDraftRecords({});
    baselineRecordsRef.current = {};
    baselineRealIdsRef.current = new Set();
  }, [activeLedgerId, selectedDate]);

  /**
   * @description 启动录入模式，优先从本地缓存（LocalStorage）读取未确认的草稿数据
   */
  const handleStartRecording = () => {
    const draftKey = `ledger_draft_${activeLedgerId}_${selectedDate}`;

    // 1) 先按“字典全量原料”算出这一刻的基线：该原料在所选日期已有记录（且已加载进内存）→ 用真实记录做基线；
    //    否则用全 0 占位模板。基线永远这样算，跟是否有本地缓存草稿无关——确认提交时以此为准做 diff。
    const dictItems = RawMaterialsDictService.getItems();
    const dbItemsMap = new Map(
      ledgerItems.filter((item) => item.ledgerId === activeLedgerId).map((item) => [item.name, item])
    );
    const baseline: Record<string, Partial<DailyStockRecord>> = {};
    const realIds = new Set<string>();
    const freshSeedDraft: Record<string, DailyStockRecord> = {};
    const seedRow = (itemId: string, realRecord?: DailyStockRecord) => {
      if (realRecord) {
        baseline[itemId] = { ...realRecord };
        realIds.add(itemId);
        freshSeedDraft[itemId] = { ...realRecord };
      } else {
        baseline[itemId] = { ...BLANK_DRAFT };
        freshSeedDraft[itemId] = { ...BLANK_DRAFT };
      }
    };
    dictItems.forEach((dictItem) => {
      const dbItem = dbItemsMap.get(dictItem.name);
      seedRow(dbItem ? dbItem.id : `temp_${dictItem.name}`, dbItem?.dailyRecords[selectedDate]);
    });
    // [字典与台账解耦] 台账里已有、但已不在字典里的孤立原料项也要种一行基线，
    // 否则录入模式下它会以空行出现、无法从既有记录起编辑。
    const dictNames = new Set(dictItems.map((d) => d.name));
    ledgerItems
      .filter((item) => item.ledgerId === activeLedgerId && !dictNames.has(item.name) && !baseline[item.id])
      .forEach((item) => seedRow(item.id, item.dailyRecords[selectedDate]));

    // 2) 工作草稿：有本地缓存就用缓存（找回上次未提交的编辑），否则用刚算出的基线。
    //    注意基线（baselineRecordsRef）始终按第 1 步独立算，不受这里用不用缓存影响——
    //    确认提交时逐字段 diff 用的是它，缓存里没有的原料行不会被提交，天然安全。
    let initialDraft: Record<string, DailyStockRecord> = freshSeedDraft;
    const cached = localStorage.getItem(draftKey);
    if (cached) {
      try {
        const parsedDraft = JSON.parse(cached);
        const currentItemsMap = new Set(ledgerItems.filter(i => i.ledgerId === activeLedgerId).map(i => i.id));
        const restored: Record<string, DailyStockRecord> = {};
        for (const [key, value] of Object.entries(parsedDraft)) {
          if (key.startsWith("temp_") || currentItemsMap.has(key)) {
            restored[key] = value as DailyStockRecord;
          }
        }
        initialDraft = restored;
        LogBroker.publish("INFO", "LedgerSystem", `成功加载本地未提交的台账录入缓存: ${draftKey}`);
        onSaveToast("已恢复未提交的本地缓存数据", 2500);
      } catch (err) {
        console.error("加载台账缓存失败:", err);
      }
    }

    baselineRecordsRef.current = baseline;
    baselineRealIdsRef.current = realIds;

    setDraftRecords(initialDraft);
    setIsRecordingMode(true);
  };

  /**
   * @description 录入模式下，更新草稿内存与 LocalStorage 缓存
   */
  const handleDraftCellChange = (itemId: string, fields: Partial<DailyStockRecord>) => {
    setDraftRecords((prev) => {
      const current = prev[itemId] || {
        inQuantity: 0,
        inPrice: 0,
        inAmount: 0,
        outQuantity: 0,
        note: "",
        certification: "",
        sensoryProperty: "",
        supplier: "",
        buyer: "",
        inspector: "",
        keeper: ""
      };
      // 出入库数量/单价禁止负数或非法数字，录入草稿阶段就地拦截，避免不合理数据在保存前就已展示给用户
      const sanitizedFields: Partial<DailyStockRecord> = { ...fields };
      (["inQuantity", "inPrice", "outQuantity"] as const).forEach((field) => {
        const value = sanitizedFields[field];
        if (value !== undefined) {
          sanitizedFields[field] = Number.isFinite(value) && value >= 0 ? value : 0;
        }
      });
      const updatedRecord = { ...current, ...sanitizedFields };
      // 自动重算入库金额
      if (updatedRecord.inQuantity !== undefined || updatedRecord.inPrice !== undefined) {
        const qty = updatedRecord.inQuantity ?? 0;
        const prc = updatedRecord.inPrice ?? 0;
        updatedRecord.inAmount = Number((qty * prc).toFixed(2));
      }
      // 自动计算换算比例对应的换算后单位数量数值（如袋数*50）
      if (updatedRecord.inQuantity !== undefined) {
        // 直接从 itemId 或已有的 items 中分析出原料名字，支持 temp_ 临时前缀原料
        const rawName = itemId.startsWith("temp_") ? itemId.replace("temp_", "") : (ledgerItems.find(i => i.id === itemId)?.name || "");
        if (rawName) {
          const dictItem = RawMaterialsDictService.getItems().find((d) => d.name === rawName);
          if (dictItem && dictItem.conversionRatio) {
            updatedRecord.conversionUnitQuantity = Number((updatedRecord.inQuantity * dictItem.conversionRatio).toFixed(2));
          } else {
            updatedRecord.conversionUnitQuantity = undefined;
          }
        }
      }

      const newDrafts = { ...prev, [itemId]: updatedRecord };
      // 同步缓存到 localStorage
      const draftKey = `ledger_draft_${activeLedgerId}_${selectedDate}`;
      localStorage.setItem(draftKey, JSON.stringify(newDrafts));
      return newDrafts;
    });
  };

  /**
   * @description 确认提交并同步数据，保存至数据库并清空本地 LocalStorage 缓存
   * 如果编辑的原料为临时原料（temp_），且用户填写的该原料记录有至少一条有效数据，则先将其正式安全地添加到该台账中再保存记录
   */
  const handleConfirmRecording = async () => {
    try {
      (window as any).__setGlobalLoading?.("正在向服务端同步并写入今日采购及出入库台账，请稍候...");

      const promises: Promise<void>[] = [];
      const batchUpdates: Record<string, Partial<DailyStockRecord>> = {};
      /** 新建台账原料项失败、这一行录入本次未能提交的原料名（含原因），用于结束时提示并保留草稿 */
      const skippedNewItems: string[] = [];

      // 验证记录是否含有至少一项有效数据值（不为空且不为0）
      const hasAtLeastOneContent = (rec: DailyStockRecord) => {
        return (
          (rec.inQuantity !== undefined && rec.inQuantity > 0) ||
          (rec.outQuantity !== undefined && rec.outQuantity > 0) ||
          !!rec.note?.trim() ||
          !!rec.certification?.trim() ||
          !!rec.sensoryProperty?.trim() ||
          !!rec.supplier?.trim() ||
          !!rec.buyer?.trim() ||
          !!rec.inspector?.trim() ||
          !!rec.keeper?.trim() ||
          !!rec.outHandler?.trim() ||
          !!rec.outRecipient?.trim()
        );
      };

      // 遍历所有项目：只提交“相对开启录入时的初始快照真正改动过的字段”，未被用户触碰的行整行跳过。
      // 这样即便某行因按月懒加载被按全 0 模板初始化，只要用户没动它，就不会把它已有的记录覆盖写空。
      for (const [itemId, record] of Object.entries(draftRecords)) {
        const delta = computeDraftDelta(
          baselineRecordsRef.current[itemId],
          record as DailyStockRecord,
          baselineRealIdsRef.current.has(itemId)
        );
        if (Object.keys(delta).length === 0) {
          // 用户没有改动这一行，跳过，绝不下发（避免整行占位值覆盖已有数据）
          continue;
        }

        if (itemId.startsWith("temp_")) {
          // 临时原料：仍要求整条草稿含有效内容才值得为它新建台账原料项
          if (hasAtLeastOneContent(record as DailyStockRecord)) {
            const rawName = itemId.replace("temp_", "");
            const dictItem = RawMaterialsDictService.getItems().find(d => d.name === rawName);
            if (dictItem) {
              // 检查该台账下是否已经存在同名原料 (可能是之前异常中断或多端同步已存在)
              const currentLedgerItems = LedgerService.getLedgerItems();
              const existingItem = currentLedgerItems.find(
                i => i.ledgerId === activeLedgerId && i.name.trim() === dictItem.name.trim()
              );

              let targetItemId = "";
              if (existingItem) {
                targetItemId = existingItem.id;
              } else {
                try {
                  const newItem = await LedgerService.addLedgerItem(
                    activeLedgerId,
                    dictItem.name,
                    dictItem.unit,
                    dictItem.remark || "",
                    0,
                    dictItem.category
                  );
                  targetItemId = newItem.id;
                } catch (addErr: any) {
                  // 新建失败（常见：多端/并发已建了同名项 → 400“已有名为X”）。刷新一次内存再找找看。
                  try {
                    await SyncHelper.refreshNow();
                    const nowExisting = LedgerService.getLedgerItems().find(
                      i => i.ledgerId === activeLedgerId && i.name.trim() === dictItem.name.trim()
                    );
                    if (nowExisting) {
                      targetItemId = nowExisting.id;
                    }
                  } catch { /* 刷新也失败就按跳过处理 */ }
                  if (!targetItemId) {
                    // 这一项这次提交不了——跳过它，不阻断其余项，草稿保留供稍后重试
                    skippedNewItems.push(`${dictItem.name}（${addErr?.message || "新建失败"}）`);
                    continue;
                  }
                }
              }
              // 只下发用户填写的字段（相对全 0 基线的差异）
              batchUpdates[targetItemId] = delta;
            }
          }
        } else {
          // 已存在的正式原料：只下发改动过的字段，后端会在真实已存记录之上做浅合并
          batchUpdates[itemId] = delta;
        }
      }

      // 如果有任何用户实际改动过的行，一次性发起批量提交（只含改动字段，未触碰的行不下发）
      const changedItemIds = Object.keys(batchUpdates);
      if (changedItemIds.length > 0) {
        promises.push(LedgerService.updateDailyRecordsBatch(selectedDate, batchUpdates));
      }
      LogBroker.publish(
        "INFO",
        "LedgerSystem",
        `确认提交 ${selectedDate} 的台账录入：本次共 ${changedItemIds.length} 项有改动并提交（未改动的原料行不下发，避免覆盖已有数据）`,
        changedItemIds.length > 0
          ? `改动项: ${changedItemIds.map((id) => `${id}=${JSON.stringify(batchUpdates[id])}`).join("; ")}`
          : undefined
      );

      await Promise.all(promises);

      // 本地内存虽已即时更新，但增量同步还要等 200ms 防抖 + 一次网络往返才能真正落盘到服务器；
      // 在此之前就放行页面（关闭录入锁屏），万一此时恰好触发了一次 SyncHelper.refreshNow()（如切换查看月份），
      // 就可能被一份尚未包含这批新数据的服务器快照短暂覆盖，导致刚保存的记录在细表/台账里"过一会儿才出现"。
      // 等到同步真正确认完成再放行，让锁屏提示准确反映"数据是否已安全落盘"。
      (window as any).__setGlobalLoading?.("正在等待服务器确认数据已安全落盘，请稍候...");
      await SyncHelper.waitForPendingSync();

      const draftKey = `ledger_draft_${activeLedgerId}_${selectedDate}`;

      if (skippedNewItems.length > 0) {
        // 有原料没建成、这几行录入没提交上去——已成功的那批已落盘，但保留草稿和录入态，让用户能重试。
        LogBroker.publish(
          "WARN",
          "LedgerSystem",
          `确认提交 ${selectedDate}：${skippedNewItems.length} 个新原料项新建失败、其录入未保存（其余 ${changedItemIds.length} 项已落盘）`,
          `未保存: ${skippedNewItems.join("、")}`
        );
        onError(`以下原料未能新建、其录入未保存，请稍后重试：${skippedNewItems.join("、")}`, 5000);
      } else {
        localStorage.removeItem(draftKey);
        setIsRecordingMode(false);
        setDraftRecords({});
        onSaveToast("当天采购与台账数据已成功保存并同步！", 2500);
        LogBroker.publish("INFO", "LedgerSystem", `已完成 ${selectedDate} 台账录入的提交与服务端落盘确认（提交 ${changedItemIds.length} 项改动）`);
      }
    } catch (err: any) {
      onError(err.message || "批量保存台账记录失败", 3000);
    } finally {
      (window as any).__setGlobalLoading?.(null);
    }
  };

  /**
   * @description 放弃当前草稿录入（不会清除本地缓存，下次点击录入可找回）
   */
  const handleCancelRecording = () => {
    setIsRecordingMode(false);
    setDraftRecords({});
    LogBroker.publish("INFO", "LedgerSystem", `已暂停 ${selectedDate} 的台账录入，草稿已暂存本地`);
    onSaveToast("录入草稿已暂存本地", 2000);
  };

  return {
    isRecordingMode,
    draftRecords,
    handleStartRecording,
    handleDraftCellChange,
    handleConfirmRecording,
    handleCancelRecording
  };
}
