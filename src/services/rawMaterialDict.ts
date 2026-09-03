/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 原料大字典业务数据服务层（RawMaterialsDictService）：管理全局原料名称/单位/所属大类/换算比例等字典条目的增删改查，是台账系统及其展示视图共用的原料基础数据源。
 */

import { FoodCategory } from "../types/types.ts";
import { LogBroker } from "../utils.ts";
import { SyncHelper } from "./syncHelper.ts";

/**
 * @description 单个原料字典条目接口
 */
export interface RawMaterialDictItem {
  /** 原料品名，如 "土豆", "猪肉" */
  name: string;
  /** 所属的二级食材大品类 */
  category: FoodCategory;
  /** 默认计量单位，如 "斤", "袋", "箱" */
  unit: string;
  /** 原料备注（规格等），如 "25kg/袋" */
  remark?: string;
  /** 换算单位，如 "斤" */
  conversionUnit?: string;
  /** 换算比例，如 50 */
  conversionRatio?: number;
  /** 是否为系统默认生成的原料（默认数据仅允许编辑，不允许删除） */
  isDefault?: boolean;
}

/**
 * @description 原料字典数据服务类，维护系统中可供选择的原料列表，支持后台增删改查
 */
export class RawMaterialsDictService {
  /** 内存中的原料字典列表 */
  private static items: RawMaterialDictItem[] = [];

  /**
   * @description 初始化原料字典。若内存无数据，使用默认推荐种子数据填充
   * @returns 初始化的原料列表
   */
  public static initDict(): RawMaterialDictItem[] {
    return this.items;
  }

  /**
   * @description 供系统启动时统一由服务器加载数据并覆盖字典内存
   * @param serverDictItems 从服务器拉取回来的原料字典条目数组
   */
  public static initDictFromServer(serverDictItems?: RawMaterialDictItem[]): RawMaterialDictItem[] {
    if (serverDictItems && serverDictItems.length > 0) {
      const deduped = this.dedupeByName(serverDictItems);
      this.items = deduped;
      LogBroker.publish("INFO", "RawMaterialsDictService", "已成功从服务器同步载入原料字典数据");
      // 若服务器数据存在历史同名重复脏数据，待全局初始化解锁时回写服务器，避免下次加载再次触发（此刻系统尚处于初始化加载中，直接同步会被安全锁拦截丢弃）。
      // 去重可能涉及任意多个条目，无法精确描述"改了哪一条"，因此整批 replaceAll 覆盖回写，属于批量初始化场景而非用户增量编辑
      if (deduped.length !== serverDictItems.length) {
        SyncHelper.runWhenInitialized(() => {
          SyncHelper.queueChange({ entity: "rawMaterial", op: "replaceAll", data: this.items });
        });
      }
    } else {
      this.items = [];
      LogBroker.publish("WARN", "RawMaterialsDictService", "未收到有效的服务端字典数据，可能处于断网状态或服务异常。");
    }
    return this.items;
  }

  /**
   * @description 按原料名对字典条目去重（同名条目保留最后出现的一条，视为更晚写入的最新数据），避免历史脏数据导致列表渲染出现重复 key
   * @param items 待去重的原始条目数组
   * @returns 去重后的条目数组
   */
  private static dedupeByName(items: RawMaterialDictItem[]): RawMaterialDictItem[] {
    const map = new Map<string, RawMaterialDictItem>();
    let hasDuplicate = false;
    for (const item of items) {
      if (map.has(item.name)) {
        hasDuplicate = true;
      }
      map.set(item.name, item);
    }
    if (hasDuplicate) {
      LogBroker.publish("WARN", "RawMaterialsDictService", "检测到原料字典中存在同名重复条目，已自动去重");
    }
    return Array.from(map.values());
  }


  /**
   * @description 系统预置的默认推荐原料种子清单（不含 isDefault 标记），供生成种子数据与迁移历史数据共用同一份基准数据源，
   * 避免维护两份重复列表导致后续新增/调整种子原料时出现遗漏或不一致
   */
  public static getDefaultSeedList(): RawMaterialDictItem[] {
    return [
      // 蔬菜类 (VEGETABLE)
      { name: "土豆", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "柿子", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "黄瓜", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "胡萝卜", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "青椒", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "葱", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "蒜", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "香菜", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "豆芽", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "大萝卜", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "紫菜", category: "VEGETABLE", unit: "袋", remark: "30g/袋" },//
      { name: "角瓜", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "蒜苔", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "白萝卜", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "窝瓜", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "黑芝麻", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "粉条", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "酵母", category: "VEGETABLE", unit: "袋", remark: "500g/袋" },
      { name: "豆沙", category: "VEGETABLE", unit: "斤", remark: "" },
      { name: "白菜", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "木耳", category: "VEGETABLE", unit: "斤", remark: "" },
      { name: "菠菜", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "圆葱", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "香其酱", category: "VEGETABLE", unit: "袋", remark: "90g/袋" },
      { name: "烧烤料", category: "VEGETABLE", unit: "斤", remark: "" },
      { name: "甘蓝", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "香菇", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "粉丝", category: "VEGETABLE", unit: "袋", remark: "400g/袋" },
      { name: "茄子", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "虾皮", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "山药", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "大豆腐", category: "VEGETABLE", unit: "刀", remark: "" },
      { name: "芹菜", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "油菜", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "菜花", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "干豆腐", category: "VEGETABLE", unit: "斤", remark: "散装" },
      { name: "冬瓜", category: "VEGETABLE", unit: "斤", remark: "散装" },

      // 粮油类 (GRAIN_OIL)
      { name: "大米", category: "GRAIN_OIL", unit: "袋", remark: "25kg/袋" },
      { name: "豆油", category: "GRAIN_OIL", unit: "桶", remark: "" },
      { name: "面粉", category: "GRAIN_OIL", unit: "袋", remark: "25kg/袋" },
      { name: "黑米", category: "GRAIN_OIL", unit: "斤", remark: "散装" },
      { name: "黄米", category: "GRAIN_OIL", unit: "斤", remark: "散装" },
      { name: "燕麦", category: "GRAIN_OIL", unit: "斤", remark: "袋装" },
      { name: "小碴子", category: "GRAIN_OIL", unit: "斤", remark: "散装" },
      { name: "小米", category: "GRAIN_OIL", unit: "斤", remark: "散装" },
      { name: "挂面", category: "GRAIN_OIL", unit: "斤", remark: "" },

      // 调料类 (SEASONING)
      { name: "盐", category: "SEASONING", unit: "袋", remark: "" },
      { name: "味素", category: "SEASONING", unit: "袋", remark: "袋装" },
      { name: "鸡精", category: "SEASONING", unit: "袋", remark: "袋装" },
      { name: "淀粉", category: "SEASONING", unit: "斤", remark: "" },
      { name: "酱油", category: "SEASONING", unit: "桶", remark: "" },
      { name: "蚝油", category: "SEASONING", unit: "桶", remark: "" },
      { name: "生抽", category: "SEASONING", unit: "桶", remark: "" },
      { name: "老抽", category: "SEASONING", unit: "桶", remark: "" },
      { name: "白糖", category: "SEASONING", unit: "斤", remark: "" },
      { name: "十三香", category: "SEASONING", unit: "盒", remark: "盒装" },
      { name: "花椒", category: "SEASONING", unit: "斤", remark: "" },
      { name: "大料", category: "SEASONING", unit: "斤", remark: "" },

      // 肉类 (MEAT)
      { name: "精肉", category: "MEAT", unit: "斤", remark: "" },
      { name: "牛肉", category: "MEAT", unit: "斤", remark: "" },
      { name: "鸡腿肉", category: "MEAT", unit: "斤", remark: "" },
      { name: "鸡翅根", category: "MEAT", unit: "斤", remark: "" },
      { name: "精五花", category: "MEAT", unit: "斤", remark: "" },
      { name: "羊肉片", category: "MEAT", unit: "斤", remark: "" },
      { name: "鸡蛋", category: "MEAT", unit: "斤", remark: "" },
      { name: "火腿肠", category: "MEAT", unit: "捆", remark: "10/捆" },
      { name: "排骨", category: "MEAT", unit: "斤", remark: "冷鲜" },
      { name: "大虾", category: "MEAT", unit: "斤", remark: "" },
      { name: "鱼丸", category: "MEAT", unit: "斤", remark: "" },
      { name: "巴沙鱼", category: "MEAT", unit: "斤", remark: "" },

      // 低耗品 (LOW_CONSUMP)
      { name: "中袋", category: "LOW_CONSUMP", unit: "捆", remark: "" },
      { name: "黑袋", category: "LOW_CONSUMP", unit: "捆", remark: "40x65" },
      { name: "一次性手套", category: "LOW_CONSUMP", unit: "袋", remark: "" },
      // 水果 (FRUIT)
      { name: "沃柑", category: "FRUIT", unit: "斤", remark: "" },
      { name: "香梨", category: "FRUIT", unit: "斤", remark: "" },
      { name: "西瓜", category: "FRUIT", unit: "斤", remark: "散装" },
      { name: "苹果", category: "FRUIT", unit: "斤", remark: "" },
      { name: "沙白瓜", category: "FRUIT", unit: "斤", remark: "散装" },
      { name: "香蕉", category: "FRUIT", unit: "斤", remark: "" }
    ];
  }

  /**
   * @description 供 SyncHelper.refreshNow() 静默更新内存中的原料字典列表，防止 LocalStorage 覆写
   */
  public static setRawMaterialsDictInMemory(items: RawMaterialDictItem[]): void {
    // 同样做防呆去重，避免历史脏数据在刷新覆盖时持续产生重复 key（此路径不回写服务器，避免触发多余保存）
    this.items = this.dedupeByName(items);
  }

  /**
   * @description 获取当前原料字典的所有条目数组
   */
  public static getItems(): RawMaterialDictItem[] {
    if (this.items.length === 0) {
      this.initDict();
    }
    return this.items;
  }

  /**
   * @description 根据原料名获取对应的默认大类
   * @param name 原料名
   * @returns 食材二级大类
   */
  public static getCategoryForMaterial(name: string): FoodCategory | null {
    const found = this.getItems().find((item) => item.name === name);
    return found ? found.category : null;
  }

  /**
   * @description 根据原料名获取对应的默认计量单位
   * @param name 原料名
   * @returns 计量单位字串
   */
  public static getUnitForMaterial(name: string): string {
    const found = this.getItems().find((item) => item.name === name);
    return found ? found.unit : "斤";
  }

  /**
   * @description 添加原料到字典
   * @param name 原料品名
   * @param category 类别
   * @param unit 单位
   * @param remark 备注/规格说明
   * @param conversionUnit 换算单位
   * @param conversionRatio 换算比例
   */
  public static async addMaterial(
    name: string,
    category: FoodCategory,
    unit: string,
    remark?: string,
    conversionUnit?: string,
    conversionRatio?: number
  ): Promise<void> {
    // 校验与级联规则已迁移到后端（阶段A，见 SQLite迁移规划.md），这里只负责发起请求并用响应更新内存缓存
    const res = await SyncHelper.fetchWithVersion("/api/raw-materials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, category, unit, remark, conversionUnit, conversionRatio })
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || "新增原料失败");
    }
    this.items.push(body.item);
    LogBroker.publish("INFO", "RawMaterialsDictService", `【原料字典】新增原料「${body.item.name}」（类别: ${category}，单位: ${unit}，备注: ${remark}，换算单位: ${conversionUnit}，换算比例: ${conversionRatio}）`);
  }

  /**
   * @description 更新原料字典条目并级联同步修改所有关联采购项与备餐项
   * @param oldName 原有名称
   * @param name 新名称
   * @param category 新大类
   * @param unit 新单位
   * @param remark 新备注/规格说明
   * @param conversionUnit 新换算单位
   * @param conversionRatio 新换算比例
   */
  public static async updateMaterial(
    oldName: string,
    name: string,
    category: FoodCategory,
    unit: string,
    remark?: string,
    conversionUnit?: string,
    conversionRatio?: number
  ): Promise<void> {
    // 校验、isDefault 保留在后端（阶段A，见 SQLite迁移规划.md）。
    // [字典与台账解耦] 编辑/改名字典条目**不再**级联改动台账里的同名采购项，前端也就不需要再 refreshNow。
    const res = await SyncHelper.fetchWithVersion(`/api/raw-materials/${encodeURIComponent(oldName)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, category, unit, remark, conversionUnit, conversionRatio })
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || "更新原料失败");
    }
    const index = this.items.findIndex((item) => item.name === oldName);
    if (index === -1) {
      this.items.push(body.item);
    } else {
      this.items[index] = body.item;
    }
    LogBroker.publish("INFO", "RawMaterialsDictService", `【原料字典】更新原料「${oldName}」为「${body.item.name}」（类别: ${category}，单位: ${unit}，备注: ${remark}）——仅影响录入联想，已有台账数据不变`);
  }

  /**
   * @description 从字典中删除原料（系统默认生成的原料不允许删除，仅允许编辑）。
   * [字典与台账解耦] 只移除录入联想项，台账里同名的采购项与历史流水原样保留、不受影响。
   * @param name 原料品名
   */
  public static async deleteMaterial(name: string): Promise<void> {
    const res = await SyncHelper.fetchWithVersion(`/api/raw-materials/${encodeURIComponent(name)}`, { method: "DELETE" });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || "删除原料失败");
    }
    this.items = this.items.filter((item) => item.name !== name);
    LogBroker.publish("WARN", "RawMaterialsDictService", `【原料字典】移除了原料「${name}」（仅移除录入联想项，已有台账数据不受影响）`);
  }
}
