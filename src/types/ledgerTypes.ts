/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 原料购销台账系统相关的基础类型定义
 */

/**
 * @description 单个购销台账对象
 */
export interface Ledger {
  /** 唯一标识符 */
  id: string;
  /** 台账名称，如 "幼儿", "教师", "幼儿晚餐", "在校生" */
  name: string;
  /** 创建时间的ISO字符串 */
  createdAt: string;
}

/**
 * @description 每日出入库库存及详细数据记录 (扩充图片所需购销台账和出入库要件字段)
 */
export interface DailyStockRecord {
  /** 今日入库数量 */
  inQuantity: number;
  /** 今日入库单价 (元) */
  inPrice: number;
  /** 今日入库总金额 (元) = 入库数量 * 入库单价 */
  inAmount: number;
  /** 今日出库数量 */
  outQuantity: number;
  /** 今日出库单价 (元，可选) */
  outPrice?: number;
  /** 今日出库总金额 (元，可选) */
  outAmount?: number;
  /** 备注说明，如出库去处或入库来源 */
  note?: string;
  
  // ================= 购销台账特有要件字段 =================
  /** 食品索证，如 "已索证" 或 "是/否" */
  certification?: string;
  /** 感官性状，如 "合格", "良好" 等 */
  sensoryProperty?: string;
  /** 供货商名称及联系地址 / 经销商 */
  supplier?: string;
  /** 采购时间 (格式 YYYY-MM-DD，默认就是数据记录的日期) */
  purchaseDate?: string;
  /** 采购员名称 */
  buyer?: string;
  /** 检验员名称 */
  inspector?: string;
  /** 保管员名称 */
  keeper?: string;
  /** 生产日期 (格式 YYYY-MM-DD) */
  produceDate?: string;
  /** 保质期，如 "6个月" 或 "2026-12-28" */
  shelfLife?: string;

  // ================= 出入库单据特有签字要件 =================
  /** 发料出库人名称 */
  outHandler?: string;
  /** 领用接收人名称 */
  outRecipient?: string;
  
  // ================= 换算关系扩展字段 =================
  /** 换算后单位的数量数值，例如袋数*换算比例 */
  conversionUnitQuantity?: number;
  /** 出库时间 (格式 YYYY-MM-DD，默认为数据记录日期，允许手动修改) */
  outDate?: string;
}

/**
 * @description 台账中具体挂载的采购原料项目
 */
export interface LedgerItem {
  /** 原料项目的唯一标识ID */
  id: string;
  /** 所属的台账ID */
  ledgerId: string;
  /** 原料细分品类名称 (如：大米, 猪肉, 鸡蛋等) */
  name: string;
  /** 包装或计量单位 (如：斤, 公斤, 袋, 箱) */
  unit: string;
  /** 原料规格或辅助备注描述 */
  spec?: string;
  /**
   * 所属二级食材大类的 key（如 VEGETABLE / MEAT）。**新建该原料项时从原料字典抄一次的快照**，
   * 此后与字典解耦——字典改名/删除都不会改它。为空表示当时字典里查不到，展示层归到"未分类"。
   */
  category?: string | null;
  /** 初始库存数量 (系统新建该原料项目时的默认库存) */
  initialStock: number;
  /** 当前实时库存数量 (计算公式: 初始库存 + 历史所有天入库累加 - 历史所有天出库累加) */
  currentStock: number;
  /** 服务端预计算的该原料所有的历史累计入库总量（不受前端拉取的月份日期区间影响） */
  historicalTotalIn?: number;
  /** 服务端预计算的该原料所有的历史累计出库总量（不受前端拉取的月份日期区间影响） */
  historicalTotalOut?: number;
  /** 服务端预计算的该原料所有的历史累计入库金额（对全部逐日流水 inAmount 求和，不受前端拉取的月份日期区间影响） */
  historicalTotalInAmount?: number;
  /** 服务端预计算的该原料**全历史**最早一条逐日流水的日期（YYYY-MM-DD）；无任何流水时为 null/undefined。不受前端按月懒加载影响 */
  historicalFirstRecordDate?: string | null;
  /** 服务端预计算的该原料**全历史**最近一条逐日流水的日期（YYYY-MM-DD）；无任何流水时为 null/undefined。用于"最近一次录入是哪天"的准确提示 */
  historicalLastRecordDate?: string | null;
  /** 每日出入库及明细记录，以 YYYY-MM-DD 为 Key 进行索引 */
  dailyRecords: Record<string, DailyStockRecord>;
}

/**
 * @description 台账总表（样式一）支持点击表头进行排序的字段枚举
 */
export type LedgerSortField =
  | "materialName"   // 原材料名称
  | "category"       // 二级品类
  | "supplier"       // 供货商及地址
  | "buyer"          // 采购员
  | "purchaseDate"   // 采购/入库时间
  | "inspector"      // 检验员
  | "keeper"         // 保管员
  | "outHandler"     // 出库人
  | "outRecipient";  // 接收人

/**
 * @description 台账总表排序顺序 (asc: 顺序/升序, desc: 逆序/降序)
 */
export type LedgerSortOrder = "asc" | "desc";
