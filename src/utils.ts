/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 全项目通用的日期计算、拼音模糊匹配、备餐月度汇总统计、CSV 导出及系统日志广播（LogBroker）等基础工具函数集合。
 */

import { PreparedItem, SystemLog } from "./types/types.ts";
import { LedgerItem } from "./types/ledgerTypes.ts";

/**
 * @description 获取选定月份的第1天到月末的天数数组
 * @param year 年份 (例如: 2026)
 * @param month 月份 (1-12)
 * @returns 包含天数索引字符串的数组，如 ["1", "2", ..., "31"]
 */
export function getDaysInMonth(year: number, month: number): string[] {
  // 利用 Date 溢出机制自动计算当月天数
  const totalDays = new Date(year, month, 0).getDate();
  const days: string[] = [];
  for (let i = 1; i <= totalDays; i++) {
    days.push(String(i));
  }
  return days;
}

/**
 * @description 按台账人群（可选）与当月有效天数（"1".."当月天数"）逐日累加台账入库金额，返回以天序号为键的每日金额 Record（不做四舍五入，交由调用方按展示/累计场景各自处理）。
 * 只按当月实际天数遍历、不使用 Object.keys(dailyRecords) 盲目累加，避免历史脏键（如早期版本遗留的完整 "YYYY-MM-DD" 格式键）污染合计——
 * App.tsx 的侧边栏合计（activeGroupReportTotal/allGroupsReportTotal）与 TableGrid.tsx 的"合计汇总"逐日汇总（summaryDailyTotals）此前
 * 各自独立实现了同一段"按人群过滤台账、按当月天数求和"逻辑，此处收敛为一份共享实现，避免两处口径不一致（[V5.97.0] 曾因类似的独立实现口径不一致导致侧边栏合计与明细表对不上）。
 * @param ledgerItems 全部台账原料项目列表
 * @param targetGroup 目标人群/台账ID；传 null 表示不按人群过滤，统计全部台账
 * @param year 年份
 * @param month 月份 (1-12)
 * @returns 以天序号字符串（"1".."当月天数"）为键的每日入库金额 Record
 */
export function computeLedgerDailyAmountsByGroup(
  ledgerItems: LedgerItem[],
  targetGroup: string | null,
  year: number,
  month: number
): Record<string, number> {
  const validDays = getDaysInMonth(year, month);
  const scopedItems = targetGroup === null ? ledgerItems : ledgerItems.filter((i) => i.ledgerId === targetGroup);
  const dailyAmounts: Record<string, number> = {};

  validDays.forEach((day) => {
    const dateKey = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    let sum = 0;
    scopedItems.forEach((item) => {
      const record = item.dailyRecords?.[dateKey];
      if (record) {
        sum += record.inAmount || 0;
      }
    });
    dailyAmounts[day] = sum;
  });

  return dailyAmounts;
}

/**
 * @description 计算某个台账原料项的“真实当前库存”（全历史累计口径），不受前端按月/按区间懒加载的影响。
 * 优先使用服务端在 GET /api/storage/load 时预聚合的 historicalTotalIn/historicalTotalOut
 * （本地 SQLite 模式下是对该原料全部逐日流水的无条件 SUM，与前端当前加载的月份区间无关）；
 * 两字段缺失时（如 COS 模式返回的本就是完整 dailyRecords）退回按内存中现有 dailyRecords 求和。
 * @param item 台账原料项（至少含 initialStock，理想情况下含 historicalTotalIn/Out）
 * @returns 真实当前库存数量（保留两位小数）
 */
export function computeLedgerTrueCurrentStock(item: LedgerItem): number {
  const initial = item.initialStock || 0;
  const histIn = item.historicalTotalIn;
  const histOut = item.historicalTotalOut;
  if (
    typeof histIn === "number" && Number.isFinite(histIn) &&
    typeof histOut === "number" && Number.isFinite(histOut)
  ) {
    return Math.round((initial + histIn - histOut) * 100) / 100;
  }
  let sumIn = 0;
  let sumOut = 0;
  Object.values(item.dailyRecords || {}).forEach((r) => {
    sumIn += r?.inQuantity || 0;
    sumOut += r?.outQuantity || 0;
  });
  return Math.round((initial + sumIn - sumOut) * 100) / 100;
}

/**
 * @description 计算单个台账原料项在给定连续日期区间内“每一天的当日结余库存”。
 *
 * 结余口径锚定在 computeLedgerTrueCurrentStock() 返回的“真实当前库存”上：区间最后一天的结余恒等于
 * 真实当前库存，更早的日期按区间内每天的出入库变动逐日反推。因此无论选择哪个时间段展示或打印，都不会
 * 因为区间外（尤其是更早月份）的入库/出库被按月懒加载排除在 dailyRecords 之外，而算出错误（甚至为负）
 * 的库存。例如某原料 8 月入库 250 斤、9 月仅出库若干斤，切到 9 月查看时最后一天仍显示真实剩余库存，
 * 而不是把 8 月的入库丢掉后得到的负数。
 *
 * @param item 台账原料项（需含 dailyRecords，理想情况下含 historicalTotalIn/Out）
 * @param dates 升序排列的连续日期字符串数组（YYYY-MM-DD），通常由 getDatesBetween() 生成
 * @returns 以日期字符串为键、当日结余库存为值的 Record
 */
export function computeLedgerDailyStockBalances(
  item: LedgerItem,
  dates: string[]
): Record<string, number> {
  const balances: Record<string, number> = {};
  const trueCurrentStock = computeLedgerTrueCurrentStock(item);

  // 区间内的出入库净变动合计
  let windowIn = 0;
  let windowOut = 0;
  dates.forEach((d) => {
    const r = item.dailyRecords?.[d];
    if (r) {
      windowIn += r.inQuantity || 0;
      windowOut += r.outQuantity || 0;
    }
  });

  // 反推“区间第一天之前”的期初结余：真实当前库存 − 区间净入库 + 区间净出库
  let accum = Math.round((trueCurrentStock - windowIn + windowOut) * 100) / 100;
  dates.forEach((dateStr) => {
    const r = item.dailyRecords?.[dateStr];
    accum = accum + (r?.inQuantity || 0) - (r?.outQuantity || 0);
    balances[dateStr] = Math.round(accum * 100) / 100;
  });

  return balances;
}

/**
 * @description 计算某本台账下全部原料的“全历史累计入库金额”（全部账期口径），不受前端按月懒加载的影响。
 * 优先用服务端在 GET /api/storage/load 预聚合的 historicalTotalInAmount（对该原料全部逐日流水 inAmount 的
 * 无条件 SUM，与前端当前加载的月份区间无关）；缺失时（如 COS 模式返回的本就是完整 dailyRecords）退回按内存中
 * 现有 dailyRecords 求和。用于左侧边栏“台账原料累计入库”切到“全部”时，避免只统计到已切换浏览过的月份。
 * @param ledgerItems 全部台账原料项目列表
 * @param ledgerId 目标台账 ID（只统计 ledgerId 匹配的原料）
 * @returns 该台账全历史累计入库金额（保留两位小数）
 */
export function computeLedgerHistoricalInAmount(ledgerItems: LedgerItem[], ledgerId: string): number {
  let total = 0;
  for (const item of ledgerItems) {
    if (item.ledgerId !== ledgerId) continue;
    const hist = item.historicalTotalInAmount;
    if (typeof hist === "number" && Number.isFinite(hist)) {
      total += hist;
    } else {
      Object.values(item.dailyRecords || {}).forEach((r) => {
        total += r?.inAmount || 0;
      });
    }
  }
  return Math.round(total * 100) / 100;
}

/**
 * @description 获取两个日期之间的所有日期字符串数组 (格式: YYYY-MM-DD)
 * @param startDate 开始日期 (YYYY-MM-DD)
 * @param endDate 结束日期 (YYYY-MM-DD)
 * @returns 包含这区间所有日期的数组
 */
export function getDatesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  if (!startDate || !endDate) return dates;
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return dates;

  const current = new Date(start);
  while (current <= end) {
    const y = current.getFullYear();
    const m = String(current.getMonth() + 1).padStart(2, "0");
    const d = String(current.getDate()).padStart(2, "0");
    dates.push(`${y}-${m}-${d}`);
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

import { pinyin } from "pinyin-pro";

/**
 * @description 判断目标中文文本是否匹配查询关键词（支持拼音首字母缩写、全拼模糊以及中文原文）
 * @param targetText 中文目标文本，如 "大米"
 * @param querySearch 查找关键词，如 "dm" 或 "dami" 或 "大米"
 * @returns 是否匹配
 */
export function matchPinyin(targetText: string, querySearch: string): boolean {
  const query = querySearch.trim().toLowerCase();
  if (!query) return true;

  const text = targetText.trim().toLowerCase();
  if (text.includes(query)) return true;

  try {
    // 获取无音调全拼，如 "da mi"
    const fullPinyin = pinyin(text, { toneType: "none" }).toLowerCase().replace(/\s+/g, "");
    if (fullPinyin.includes(query)) return true;

    // 获取拼音首字母，如 "dm"
    const firstLetters = pinyin(text, { pattern: "first", toneType: "none" }).toLowerCase().replace(/\s+/g, "");
    if (firstLetters.includes(query)) return true;
  } catch (err) {
    // 降级防呆
    return text.includes(query);
  }

  return false;
}

/**
 * @description 获取某一行备餐明细行当月的所有天数的总数量与总金额
 * @param item 细分品类备餐实体
 * @param days 当月包含的所有天数
 * @returns 包含总数量(totalQty) 和总金额(totalCost) 两个统计属性的对象
 */
export function getItemMonthlySummary(
  item: PreparedItem,
  days: string[]
): { totalQty: number; totalCost: number } {
  let totalQty = 0;
  let totalCost = 0;
  days.forEach((day) => {
    const entry = item.dailyData[day];
    if (entry) {
      totalQty += entry.quantity || 0;
      totalCost += entry.amount || 0;
    }
  });
  return {
    totalQty: Math.round(totalQty * 100) / 100,
    totalCost: Math.round(totalCost * 100) / 100
  };
}

/**
 * @description 将系统状态信息或操作异常记录写入性能监视日志
 * @param level 日志级别 (INFO | WARN | ERROR)
 * @param module 触发日志的函数或组件名称
 * @param message 描述内容
 * @param details 额外异常详情或错误堆栈
 * @returns 组装好的完整 SystemLog 对象
 */
export function createSystemLog(
  level: "INFO" | "WARN" | "ERROR",
  module: string,
  message: string,
  details?: string
): SystemLog {
  const log: SystemLog = {
    id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    timestamp: new Date().toISOString(),
    level,
    module,
    message,
    details
  };

  // 同时输出在浏览器的控制台，方便排查
  if (level === "ERROR") {
    console.error(`[${log.timestamp}] [${module}] ${message}`, details || "");
  } else if (level === "WARN") {
    console.warn(`[${log.timestamp}] [${module}] ${message}`);
  } else {
    console.log(`[${log.timestamp}] [${module}] ${message}`);
  }

  return log;
}

/**
 * @description 双向绑定的全功能系统日志发布拦截器
 */
export class LogBroker {
  private static listeners: ((log: SystemLog) => void)[] = [];

  /**
   * @description 注册一个新的系统日志订阅者
   * @param listener 回调函数
   */
  public static subscribe(listener: (log: SystemLog) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * @description 触发并向所有注册组件推送新日志条目
   * @param level 日志等级
   * @param module 来源模块
   * @param message 日志消息
   * @param details 堆栈细节 
   */
  public static publish(
    level: "INFO" | "WARN" | "ERROR",
    module: string,
    message: string,
    details?: string
  ): void {
    const log = createSystemLog(level, module, message, details);

    // 异步将日志上传至后端写入本地文件
    fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level, category: module, message: details ? `${message} (详情: ${details})` : message })
    }).catch(err => {
      // 捕获可能出现的网络或配置错误，防止日志本身报错阻塞业务
      console.warn("[LogBroker] 无法上传日志至后端持久化:", err);
    });

    this.listeners.forEach((listener) => {
      try {
        listener(log);
      } catch (err) {
        console.error("推送信道异常:", err);
      }
    });
  }
}

/**
 * @description 将指定品类的细分备餐矩阵导出为标准的 Excel 可兼容 CSV 文本格式
 * @param items 该类目的备餐行列表
 * @param days 当前月份的所有天数 (如 1号 到 31号)
 * @param categoryLabel 品类中文名称
 * @returns 导出用的 CSV 纯文本
 */
export function convertItemsToCsv(
  items: PreparedItem[],
  days: string[],
  categoryLabel: string
): string {
  // UTF-8 BOM，防止 Excel 打开中文乱码
  let csvContent = "\uFEFF";

  // 第一行头：品类与对应天
  const header1 = ["品类/日期"];
  days.forEach((day) => {
    header1.push(`${day}号`, "", ""); // 占三个格子
  });
  header1.push("总数量", "总金额");
  csvContent += header1.map((col) => `"${col}"`).join(",") + "\n";

  // 第二行头：数量、单价、金额
  const header2 = ["细分项目名称"];
  days.forEach(() => {
    header2.push("数量", "单价", "金额(元)");
  });
  header2.push("月累加", "月总金额(元)");
  csvContent += header2.map((col) => `"${col}"`).join(",") + "\n";

  // 填充正文内容行
  items.forEach((item) => {
    const row = [`${item.name} (${item.unit})`];
    let rowQtySum = 0;
    let rowCostSum = 0;

    days.forEach((day) => {
      const entry = item.dailyData[day] || { quantity: 0, price: 0, amount: 0 };
      row.push(
        String(entry.quantity || 0),
        String(entry.price || 0),
        String(entry.amount || 0)
      );
      rowQtySum += entry.quantity || 0;
      rowCostSum += entry.amount || 0;
    });

    row.push(
      String(Math.round(rowQtySum * 100) / 100),
      String(Math.round(rowCostSum * 100) / 100)
    );
    csvContent += row.map((col) => `"${col.replace(/"/g, '""')}"`).join(",") + "\n";
  });

  return csvContent;
}
