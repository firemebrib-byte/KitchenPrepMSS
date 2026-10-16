/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 一二级人群/食材大类配置服务层。类名 PrepReportService 是转型前"备餐月度报表"是主要功能时期的遗留命名——
 * [V2 架构演进] 备餐报表双状态（reports/getOrCreateReport/syncFromLedger 等）已随台账转为主要数据源而整体删除，
 * 现在只负责 activeGroups/activeCategories 两份一二级配置的增删改查，不再管理任何"报表"。
 */

import { DynamicGroup, DynamicCategory } from "../types/types.ts";
import { LogBroker } from "../utils.ts";
import { SyncHelper } from "./syncHelper.ts";

/**
 * @description 自动模拟服务层接口呼叫时延 (毫秒)
 */
const MOCK_API_LATENCY = 150;

/**
 * @description 发生重大核心变动后的侦听分发器类型
 */
export type StateChangeListener = () => void;

/**
 * @description 一二级人群/食材大类配置的 pub/sub 单例服务：saveGroup/deleteGroup/saveCategory/deleteCategory
 * 的校验/级联规则已迁移到后端 REST API（前端只负责发请求、用响应更新内存），syncGroupFromLedger/
 * syncDeleteGroupFromLedger 仍是纯前端内存操作，供台账改名/删除时同步一级人群标签使用。
 */
export class PrepReportService {
  private static changeListeners: StateChangeListener[] = [];
  private static activeGroups: DynamicGroup[] = [];
  private static activeCategories: DynamicCategory[] = [];

  /**
   * @description 注册局部状态变动全局热补丁侦听
   * @param listener 回调监听器
   */
  public static subscribe(listener: StateChangeListener): () => void {
    this.changeListeners.push(listener);
    return () => {
      this.changeListeners = this.changeListeners.filter((l) => l !== listener);
    };
  }

  /**
   * @description 推送最新配置状态至所有订阅组件
   */
  private static notifyListeners(): void {
    this.changeListeners.forEach((listener) => {
      try {
        listener();
      } catch (err) {
        LogBroker.publish("ERROR", "PrepReportService", "下发变动通知失败:", String(err));
      }
    });
  }

  /**
   * @description 获取当前激活的餐卡人群列表
   * @returns 动态人群配置列表
   */
  public static getActiveGroups(): DynamicGroup[] {
    return this.activeGroups;
  }

  /**
   * @description 获取当前激活的食材大类列表
   * @returns 动态大类配置列表
   */
  public static getActiveCategories(): DynamicCategory[] {
    return this.activeCategories;
  }

  /**
   * @description 启动并自检缓存。完全从服务器同步获取数据，不使用本地缓存
   */
  public static async initStore(): Promise<void> {
    let serverData: any = null;
    try {
      // 从后端拉取最新同步数据
      serverData = await SyncHelper.loadFromServer();
    } catch (err) {
      LogBroker.publish("WARN", "PrepReportService", "同步服务器数据失败: " + String(err));
    }

    return new Promise((resolve) => {
      setTimeout(() => {
        try {
          if (serverData && serverData.activeGroups && serverData.activeCategories) {
            this.activeGroups = serverData.activeGroups as DynamicGroup[];
            this.activeCategories = serverData.activeCategories as DynamicCategory[];
            LogBroker.publish("INFO", "PrepReportService", "已成功从服务器同步载入备餐基础配置数据");
          } else {
            this.activeGroups = [];
            this.activeCategories = [];
            LogBroker.publish("WARN", "PrepReportService", "未收到有效的服务端数据，可能处于断网状态或服务异常。");
          }
          resolve();
        } catch (error) {
          LogBroker.publish("ERROR", "PrepReportService", "启动加载数据发生异常:", String(error));
          resolve();
        }
      }, MOCK_API_LATENCY);
    });
  }

  /**
   * @description 从台账同步餐位人群配置列表
   * @param id 台账唯一ID / 人群唯一Key
   * @param name 台账名称 / 人群中文名称
   */
  public static syncGroupFromLedger(id: string, name: string): void {
    const existingIndex = this.activeGroups.findIndex((g) => g.key === id);
    if (existingIndex > -1) {
      if (this.activeGroups[existingIndex].label !== name) {
        this.activeGroups[existingIndex].label = name;
        this.notifyListeners();
        SyncHelper.queueChange({ entity: "activeGroup", op: "upsert", key: id, data: this.activeGroups[existingIndex] });
      }
    } else {
      const newGroup: DynamicGroup = {
        key: id,
        label: name,
        emoji: "🍽️"
      };
      this.activeGroups.push(newGroup);
      this.notifyListeners();
      SyncHelper.queueChange({ entity: "activeGroup", op: "upsert", key: id, data: newGroup });
    }
  }

  /**
   * @description 从台账同步删除餐位人群配置
   * @param id 台账ID / 人群Key
   */
  public static syncDeleteGroupFromLedger(id: string): void {
    const upperKey = id.toUpperCase();
    this.activeGroups = this.activeGroups.filter((g) => g.key !== upperKey);
    LogBroker.publish("WARN", "PrepReportService", `从台账同步物理移除了群组: ${upperKey}`);
    this.notifyListeners();
  }

  /**
   * @description 新增或编辑一级人群配置并落盘
   */
  public static async saveGroup(key: string, label: string, emoji: string): Promise<void> {
    const res = await SyncHelper.fetchWithVersion(`/api/groups/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, emoji })
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || "保存人群配置失败");
    }
    const savedGroup: DynamicGroup = body.group;
    const existingIndex = this.activeGroups.findIndex((g) => g.key === savedGroup.key);
    if (existingIndex > -1) {
      this.activeGroups[existingIndex] = savedGroup;
      LogBroker.publish("INFO", "PrepReportService", `更新了一级备餐人群: ${label} (${savedGroup.key})`);
    } else {
      this.activeGroups.push(savedGroup);
      LogBroker.publish("INFO", "PrepReportService", `新增了一级备餐人群: ${label} (${savedGroup.key})`);
    }
    this.notifyListeners();
    await SyncHelper.refreshNow();
  }

  /**
   * @description 删除一级人群配置
   */
  public static async deleteGroup(key: string): Promise<void> {
    const upperKey = key.toUpperCase();
    const res = await SyncHelper.fetchWithVersion(`/api/groups/${encodeURIComponent(key)}`, { method: "DELETE" });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || "删除人群配置失败");
    }
    this.activeGroups = this.activeGroups.filter((g) => g.key.toUpperCase() !== upperKey);
    LogBroker.publish("WARN", "PrepReportService", `剔除了一级备餐人群: ${upperKey}`);
    this.notifyListeners();
    await SyncHelper.refreshNow();
  }

  /**
   * @description 新增或编辑二级食材大类配置并在系统落盘
   */
  public static async saveCategory(key: string, label: string): Promise<void> {
    const res = await SyncHelper.fetchWithVersion(`/api/categories/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label })
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || "保存大类配置失败");
    }
    const savedCategory: DynamicCategory = body.category;
    const existingIndex = this.activeCategories.findIndex((c) => c.key === savedCategory.key);
    if (existingIndex > -1) {
      this.activeCategories[existingIndex] = savedCategory;
      LogBroker.publish("INFO", "PrepReportService", `更新了二级食材大类: ${label} (${savedCategory.key})`);
    } else {
      this.activeCategories.push(savedCategory);
      LogBroker.publish("INFO", "PrepReportService", `新增了二级食材大类: ${label} (${savedCategory.key})`);
    }
    this.notifyListeners();
  }

  /**
   * @description 删除二级大品类配置
   */
  public static async deleteCategory(key: string): Promise<void> {
    const upperKey = key.toUpperCase();
    const res = await SyncHelper.fetchWithVersion(`/api/categories/${encodeURIComponent(key)}`, { method: "DELETE" });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || "删除大类配置失败");
    }
    this.activeCategories = this.activeCategories.filter((c) => c.key !== upperKey);
    LogBroker.publish("WARN", "PrepReportService", `剔除了二级大类: ${upperKey}`);
    this.notifyListeners();
  }

  /**
   * @description 供 SyncHelper.refreshNow() 静默更新内存中的一级人群列表
   */
  public static setActiveGroupsInMemory(g: DynamicGroup[]): void {
    this.activeGroups = g;
  }

  /**
   * @description 供 SyncHelper.refreshNow() 静默更新内存中的二级大类列表
   */
  public static setActiveCategoriesInMemory(c: DynamicCategory[]): void {
    this.activeCategories = c;
  }

  /**
   * @description 强制广播分发最新的内存数据变动
   */
  public static forceNotify(): void {
    this.notifyListeners();
  }
}
