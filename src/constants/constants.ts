/// <reference types="vite/client" />
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 备餐系统专属的常量字典：一二级人群/食材大类的中文名映射、默认单位、预设食材种子数据、登录与管理员密码（来自环境变量）以及界面通用中文文案集中管理。
 */




/**
 * @description 管理配置后台的默认进入密码，支持从环境变量安全调入
 */
export const ADMIN_PASSWORD = (typeof process !== "undefined" ? process.env.VITE_ADMIN_PASSWORD : (import.meta as any).env?.VITE_ADMIN_PASSWORD) || "admin";

/**
 * @description 系统首页登录的验证密码，支持从环境变量安全调入
 */
export const LOGIN_PASSWORD = (typeof process !== "undefined" ? process.env.VITE_LOGIN_PASSWORD : (import.meta as any).env?.VITE_LOGIN_PASSWORD) || "guest";


/**
 * @description 界面通用的中文文本字面量硬编码，集中管理方便修改。
 * [V2 架构演进] 备餐记账主表格改为台账数据的只读派生展示后，原来服务于"可编辑表格"功能
 * （导入导出JSON、清空录入、批量调价、独立新增项按钮等）的文案已随对应功能一并删除，
 * 此处只保留展示层仍在实际使用的三个字段。
 */
export const UI_TEXT = {
  saveSuccess: "月备餐数据已自动保存至本地缓存！",
  summaryName: "全品类预算合计汇总",
  noDataMessage: "该品类暂无细分材料，请在左侧「原料购销台账」中录入对应原料的出入库数据。"
};

/**
 * @description 台账采购原料项没有分类快照（`item.category` 为空，通常是建项时字典里查不到、或字典条目后来被删）
 * 时，展示层统一归入的“未分类”兜底大类的 key 与显示名。字典与台账解耦后，孤立项走这个桶，不会再从界面消失。
 */
export const UNCATEGORIZED_CATEGORY_KEY = "__UNCATEGORIZED__";
export const UNCATEGORIZED_CATEGORY_LABEL = "未分类";

/**
 * @description 解析一个台账采购原料项应归属的二级大类 key：优先用项自带的 category 快照，
 * 其次回退按 name 从原料字典查一次（兼容升级前建的、快照列还没回填的老数据 / COS 模式），
 * 都没有则归 UNCATEGORIZED_CATEGORY_KEY。
 * @param item 台账采购原料项（至少含 name，理想含 category）
 * @param dictLookup 传入 (name) => category 的字典查询函数（通常是 RawMaterialsDictService.getCategoryForMaterial）
 */
export function resolveLedgerItemCategory(
  item: { name?: string; category?: string | null },
  dictLookup: (name: string) => string | null
): string {
  const snap = (item.category ?? "").trim();
  if (snap) return snap;
  const fromDict = item.name ? dictLookup(item.name) : null;
  return fromDict || UNCATEGORIZED_CATEGORY_KEY;
}
