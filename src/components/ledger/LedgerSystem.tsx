/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 原料购销台账及库存仓储系统主面板组件：编排台账的筛选、样式一/样式二切换、录入模式、原料增删改、批量签字与打印导出等各子组件；数据加载与录入模式状态机已分别抽取到 useLedgerData/useLedgerRecording 两个自定义 Hook 中。
 */

import React, { useEffect, useState, useMemo } from "react";
import { LedgerItem, DailyStockRecord, LedgerSortField, LedgerSortOrder } from "../../types/ledgerTypes.ts";
import { LedgerService } from "../../services/ledgerStore.ts";
import { LEDGER_UI_TEXT, LEDGER_PRINT_OUT_CONFIG, LEDGER_PRINT_STYLE1_CONFIG } from "../../constants/ledgerConstants.ts";
import { LogBroker, matchPinyin, getDatesBetween, computeLedgerDailyStockBalances } from "../../utils.ts";
import { RawMaterialsDictService } from "../../services/rawMaterialDict.ts";
import { FoodCategory } from "../../types/types.ts";
import { resolveLedgerItemCategory, UNCATEGORIZED_CATEGORY_KEY } from "../../constants/constants.ts";
import { PrepReportService } from "../../services/store.ts";
import { LedgerPrintDoc } from "./LedgerPrintDoc.tsx";
import { LedgerPrintPreviewOverlay } from "./LedgerPrintPreviewOverlay.tsx";
import { LedgerStyle1Table } from "./LedgerStyle1Table.tsx";
import { LedgerStyle2Flow } from "./LedgerStyle2Flow.tsx";
import { LedgerInvoiceTab } from "./LedgerInvoiceTab.tsx";
import { LedgerPrintModal } from "./LedgerPrintModal.tsx";
import { LedgerSidebar } from "./LedgerSidebar.tsx";
import { LedgerControlBar } from "./LedgerControlBar.tsx";
import { useLedgerData } from "../../hooks/useLedgerData.ts";
import { useLedgerRecording } from "../../hooks/useLedgerRecording.ts";
import { SyncHelper } from "../../services/syncHelper.ts";

import {
  Calendar,
  AlertCircle,
  FileText
} from "lucide-react";

interface LedgerSystemProps {
  onActiveLedgerChange?: (id: string) => void;
  selectedDate?: string;
  onDateChange?: (date: string) => void;
}

/**
 * @description 原料购销台账及库存仓储系统主面板组件
 */
export function LedgerSystem(props: LedgerSystemProps = {}) {
  const { onActiveLedgerChange } = props;
  // ================= 状态声明部分 =================

  // 台账列表、原料项目列表及当前选中台账ID的加载与订阅逻辑，统一由 useLedgerData 提供
  const { ledgers, ledgerItems, activeLedgerId, setActiveLedgerId } = useLedgerData();

  /** 当前选中的台账展现样式，style1总表(日清单)，style2单原料流水(月卡片) */
  const [ledgerStyle, setLedgerStyle] = useState<"style1" | "style2">("style1");
  /** 样式二下当前选中聚焦进行流水查看的原料ID */
  const [activeItemId, setActiveItemId] = useState<string>("");

  /** 当前选择进行数据同步的日期 (格式 YYYY-MM-DD，默认今天) */
  const [internalSelectedDate, setInternalSelectedDate] = useState<string>(() => {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  });

  const selectedDate = props.selectedDate || internalSelectedDate;
  const setSelectedDate = props.onDateChange || setInternalSelectedDate;

  /** 系统当前真实日期 (YYYY-MM-DD)，用于提示用户所选录入日期是否为“今天”，避免把往日的账误当今天录入 */
  const todayStr = (() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  })();
  const isSelectedDateToday = selectedDate === todayStr;

  /** 样式二（单原料日流水）自定义时间段 - 开始日期 */
  const [style2StartDate, setStyle2StartDate] = useState<string>("");
  /** 样式二（单原料日流水）自定义时间段 - 结束日期 */
  const [style2EndDate, setStyle2EndDate] = useState<string>("");

  // 当 activeLedgerId 变化时通知父组件
  useEffect(() => {
    if (onActiveLedgerChange && activeLedgerId) {
      onActiveLedgerChange(activeLedgerId);
    }
  }, [activeLedgerId, onActiveLedgerChange]);

  /** 界面操作的当前选项卡: "entry" | "invoice" */
  const [activeTab, setActiveTab] = useState<"entry" | "invoice">("entry");
  /** 重命名台账的目标ID */
  const [renameLedgerId, setRenameLedgerId] = useState<string | null>(null);
  /** 重命名台账的新名字输入 */
  const [renameLedgerName, setRenameLedgerName] = useState<string>("");

  // 批量签字人填报状态
  const [batchOutHandler, setBatchOutHandler] = useState<string>("");
  const [batchOutRecipient, setBatchOutRecipient] = useState<string>("");

  // 编辑原料明细相关状态
  const [editingMaterialId, setEditingMaterialId] = useState<string | null>(null);
  const [editMaterialName, setEditMaterialName] = useState<string>("");
  const [editMaterialUnit, setEditMaterialUnit] = useState<string>("斤");
  const [editMaterialSpec, setEditMaterialSpec] = useState<string>("");
  const [editMaterialStock, setEditMaterialStock] = useState<number>(0);

  /** 自动同步成功小气泡的文字 */
  const [saveToast, setSaveToast] = useState<string | null>(null);
  /** 系统交互时的报错提示 */
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // --- 批量确认录入模式相关状态与动作，统一由 useLedgerRecording 提供 ---
  const {
    isRecordingMode,
    draftRecords,
    handleStartRecording: handleStartRecordingBase,
    handleDraftCellChange,
    handleConfirmRecording,
    handleCancelRecording
  } = useLedgerRecording({
    activeLedgerId,
    selectedDate,
    ledgerItems,
    onSaveToast: (message, durationMs = 2500) => {
      setSaveToast(message);
      setTimeout(() => setSaveToast(null), durationMs);
    },
    onError: (message, durationMs = 4000) => {
      setErrorMessage(message);
      setTimeout(() => setErrorMessage(null), durationMs);
    }
  });

  // --- 台账多维度筛选状态（样式一主表格专用）---
  /** 原料名称搜索关键字（支持模糊匹配） */
  const [filterName, setFilterName] = useState<string>("");
  /** 筛选品类（空字符串表示全部不限）*/
  const [filterCategory, setFilterCategory] = useState<string>("");
  /** 筛选采购员（空字符串表示全部不限）*/
  const [filterBuyer, setFilterBuyer] = useState<string>("");
  /** 筛选检验员（空字符串表示全部不限）*/
  const [filterInspector, setFilterInspector] = useState<string>("");
  /** 筛选保管员（空字符串表示全部不限）*/
  const [filterKeeper, setFilterKeeper] = useState<string>("" );

  // --- 台账总表表头排序状态（默认按二级品类顺序/升序排序）---
  /** 当前总表排序字段，默认按照二级品类排序 */
  const [sortField, setSortField] = useState<LedgerSortField>("category");
  /** 当前总表排序方向 (asc: 顺序/升序, desc: 逆序/降序)，默认顺序 */
  const [sortOrder, setSortOrder] = useState<LedgerSortOrder>("asc");

  /**
   * @description 切换总表表头字段的排序方向或排序字段
   * @param field 要排序的表头字段
   */
  const handleToggleSort = (field: LedgerSortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder("asc");
    }
  };

  /** 仅供打印使用的纯净弹出视图状态: null | "in" | "out" */
  const [printDocType, setPrintDocType] = useState<null | "in" | "out">(null);

  // --- 高级打印模式相关状态 ---
  /** 区分当前正处于何种打印预览中：null 表示关闭预览，"style1"表示总表模式预览，"style2"表示单原料流水预览 */
  const [printPreviewStyle, setPrintPreviewStyle] = useState<null | "style1" | "style2" | "style3">(null);
  /** 二级分类勾选打印控制弹窗 */
  const [printModalOpen, setPrintModalOpen] = useState<boolean>(false);
  /** 总表打印预览下选中的二级食材分类（默认包含全部大类 + “未分类”兜底桶） */
  const [selectedPrintCategories, setSelectedPrintCategories] = useState<FoodCategory[]>(() =>
    [...PrepReportService.getActiveCategories().map(c => c.key), UNCATEGORIZED_CATEGORY_KEY]
  );

  /** 动态补充的空白行数（打印和预览时生效，按类型分离记忆） */
  const [customDataRowsLedger, setCustomDataRowsLedger] = useState<number>(() => {
    const saved = localStorage.getItem("kpmss_print_data_rows_ledger");
    return saved ? parseInt(saved, 10) : LEDGER_PRINT_STYLE1_CONFIG.minPrintRows;
  });
  const [customDataRowsDoc, setCustomDataRowsDoc] = useState<number>(() => {
    const saved = localStorage.getItem("kpmss_print_data_rows_doc");
    return saved ? parseInt(saved, 10) : LEDGER_PRINT_OUT_CONFIG.minPrintRows;
  });
  const [customSupplierRowsDoc, setCustomSupplierRowsDoc] = useState<number>(() => {
    const saved = localStorage.getItem("kpmss_print_supplier_rows_doc");
    return saved ? parseInt(saved, 10) : LEDGER_PRINT_OUT_CONFIG.maxSuppliersPerPage;
  });

  useEffect(() => {
    localStorage.setItem("kpmss_print_data_rows_ledger", customDataRowsLedger.toString());
  }, [customDataRowsLedger]);

  useEffect(() => {
    localStorage.setItem("kpmss_print_data_rows_doc", customDataRowsDoc.toString());
  }, [customDataRowsDoc]);

  useEffect(() => {
    localStorage.setItem("kpmss_print_supplier_rows_doc", customSupplierRowsDoc.toString());
  }, [customSupplierRowsDoc]);

  /** 从全局原料大字典获取的可供选择下拉项 */
  const dictOptions = useMemo(() => {
    return RawMaterialsDictService.getItems().map((item) => ({
      value: item.name,
      label: item.name,
      unit: item.unit,
      category: item.category
    }));
  }, [editingMaterialId]);

  // ================= 懒加载数据触发器 =================
  useEffect(() => {
    let requiredStart = selectedDate;
    let requiredEnd = selectedDate;

    if (ledgerStyle === "style1") {
      // 样式一（总表）：默认拉取 selectedDate 所在自然月的所有数据
      const parts = selectedDate.split("-");
      if (parts.length === 3) {
        const y = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10) - 1;
        requiredStart = `${y}-${String(m + 1).padStart(2, "0")}-01`;
        requiredEnd = `${y}-${String(m + 1).padStart(2, "0")}-${new Date(y, m + 1, 0).getDate()}`;
      }
    } else if (ledgerStyle === "style2" && style2StartDate && style2EndDate) {
      // 样式二（单原料流水）：如果有自定义日期范围，则拉取该范围
      requiredStart = style2StartDate;
      requiredEnd = style2EndDate;
    }

    // 触发刷新请求，SyncHelper 内部会自动判定是否与当前缓存的区间一致
    SyncHelper.refreshNow(requiredStart, requiredEnd).catch(err => {
      console.error("按需懒加载数据失败:", err);
    });
  }, [ledgerStyle, selectedDate, style2StartDate, style2EndDate]);

  // ================= 计算属性与动态过滤 =================

  /** 当前被选中的台账对象 */
  const activeLedger = useMemo(() => {
    return ledgers.find((l) => l.id === activeLedgerId) || null;
  }, [ledgers, activeLedgerId]);

  /** 过滤并整合出当前选中台账应该显示的采购原料项目（非录入模式下仅展示台账已持有的正式原料，录入模式下默认平铺所有字典原料以直接编辑）*/
  const currentLedgerItems = useMemo(() => {
    const dictItems = RawMaterialsDictService.getItems();
    // 本台账下所有正式采购原料项。[字典与台账解耦] 不再要求“必须在字典里存在”——
    // 字典删了/改名了，台账项照样展示（name/unit/spec/category 都是建项时的快照）。
    const dbItems = ledgerItems.filter((item) => item.ledgerId === activeLedgerId);

    // 如果非录入模式，则保持只展示正式存在的原料
    if (!isRecordingMode) {
      return dbItems;
    }

    const dbItemsMap = new Map(dbItems.map((item) => [item.name, item]));
    const dictNames = new Set(dictItems.map((d) => d.name));

    // 录入模式下，动态合并已有的和临时的（带 temp_ 前缀 ID）以实现平铺所有大字典原料采购项
    const flattened = dictItems.map((dictItem) => {
      if (dbItemsMap.has(dictItem.name)) {
        return dbItemsMap.get(dictItem.name)!;
      }
      return {
        id: `temp_${dictItem.name}`,
        ledgerId: activeLedgerId,
        name: dictItem.name,
        unit: dictItem.unit,
        spec: dictItem.remark || "",
        initialStock: 0,
        currentStock: 0,
        dailyRecords: {}
      } as LedgerItem;
    });

    // [字典与台账解耦] 台账里已有、但字典里已没有的“孤立原料项”也要在录入模式露出来，
    // 否则字典删掉某原料后，它在本台账的历史数据在录入模式下就看不见/改不了了。
    const orphans = dbItems.filter((item) => !dictNames.has(item.name));
    return [...flattened, ...orphans];
  }, [ledgerItems, activeLedgerId, isRecordingMode]);

  /**
   * @description 本台账内实际存在采购原料项目的二级食材大类集合，供打印勾选弹窗禁用"本台账在该大类下压根没有任何原料、选了也是空表"的大类
   */
  const printableCategories = useMemo(() => {
    const dbItems = ledgerItems.filter((item) => item.ledgerId === activeLedgerId);
    const result = new Set<FoodCategory>();
    dbItems.forEach((item) => {
      result.add(resolveLedgerItemCategory(item, (n) => RawMaterialsDictService.getCategoryForMaterial(n)));
    });
    return result;
  }, [ledgerItems, activeLedgerId]);

  /**
   * @description 打开二级分类打印勾选弹窗前，先剔除当前选中项中本台账实际没有任何原料的大类，避免"选了也是空表"
   */
  const handleTogglePrintModal = (open: boolean) => {
    if (open) {
      setSelectedPrintCategories((prev) => prev.filter((cat) => printableCategories.has(cat)));
    }
    setPrintModalOpen(open);
  };

  /**
   * @description 开启当日录入前，自动切换回总表模式（图一），确保录入时始终能看到完整的原料清单
   */
  const handleStartRecording = () => {
    setLedgerStyle("style1");
    handleStartRecordingBase();
  };

  /**
   * @description 当前选定的"同步日期"在本台账下完全没有任何出入库记录、但本台账其他日期确实存在记录时，
   * 计算出最近一次的有效录入日期，用于提示用户切换日期查看（避免误以为数据丢失）。
   * 录入模式下不提示，避免打扰正在录入当天数据的用户。
   */
  const nearestRecordDateHint = useMemo(() => {
    if (isRecordingMode) return null;
    const hasRecordOnSelectedDate = currentLedgerItems.some((item) => !!item.dailyRecords[selectedDate]);
    if (hasRecordOnSelectedDate) return null;

    // 优先取服务端预聚合的“全历史最近记录日期”（historicalLastRecordDate，不受按月懒加载影响），
    // 内存里已加载的最大日期只作为兜底；两者取较大值，避免因当前只加载了某个月而把“最近一次录入”误报成较早/较晚的错误日期。
    let latestDate: string | null = null;
    const consider = (d: string | null | undefined) => {
      if (d && (!latestDate || d > latestDate)) {
        latestDate = d;
      }
    };
    currentLedgerItems.forEach((item) => {
      consider(item.historicalLastRecordDate);
      Object.keys(item.dailyRecords).forEach((d) => consider(d));
    });
    return latestDate;
  }, [currentLedgerItems, selectedDate, isRecordingMode]);

  /**
   * 叠加所有筛选条件后的展示项目列表（仅供样式一渲染，不参与录入逻辑）
   * 依赖：名称搜索词、品类、采购员、检验员、保管员、选定日期
   */
  const filteredLedgerItems = useMemo(() => {
    return currentLedgerItems.filter((item) => {
      // [字典与台账解耦] 不再要求原料必须在字典里存在——字典删了/改名了，台账项照样显示。
      // 分类走 item.category 快照，缺失时回退字典、再缺失归“未分类”。
      const itemCategory = resolveLedgerItemCategory(item, (n) => RawMaterialsDictService.getCategoryForMaterial(n));

      // 非录入模式下，仅展示当前所选同步日期确实存在出入库记录的原料；曾在其他日期录入过、但当天未采购的原料不再显示，
      // 避免总表出现大量与当天无关的空白行
      if (!isRecordingMode && !item.dailyRecords[selectedDate]) return false;

      if (filterName.trim()) {
        if (!matchPinyin(item.name, filterName)) return false;
      }
      if (filterCategory) {
        if (itemCategory !== filterCategory) return false;
      }
      if (filterBuyer.trim()) {
        const rec = item.dailyRecords[selectedDate];
        if (!((rec?.buyer || "").toLowerCase().includes(filterBuyer.trim().toLowerCase()))) return false;
      }
      if (filterInspector.trim()) {
        const rec = item.dailyRecords[selectedDate];
        if (!((rec?.inspector || "").toLowerCase().includes(filterInspector.trim().toLowerCase()))) return false;
      }
      if (filterKeeper.trim()) {
        const rec = item.dailyRecords[selectedDate];
        if (!((rec?.keeper || "").toLowerCase().includes(filterKeeper.trim().toLowerCase()))) return false;
      }
      return true;
    });
  }, [currentLedgerItems, filterName, filterCategory, filterBuyer, filterInspector, filterKeeper, selectedDate]);

  /**
   * @description 按照当前所选表头字段及排序方向对过滤后的台账原料进行排序
   * 默认按二级品类分类排序；支持按原材料名称、供货商、采购员、采购时间、检验员、保管员、出库人、接收人升序或降序排列
   */
  const sortedFilteredLedgerItems = useMemo(() => {
    const activeCats = PrepReportService.getActiveCategories();

    /** 获取某个原料在指定排序字段下的对比文本值 */
    const getFieldValue = (item: LedgerItem, field: LedgerSortField): string => {
      const draftRec = isRecordingMode ? draftRecords[item.id] : undefined;
      const dailyRec = item.dailyRecords[selectedDate];
      const rec = draftRec || dailyRec || {};

      switch (field) {
        case "materialName":
          return item.name || "";
        case "category": {
          const catKey = resolveLedgerItemCategory(item, (n) => RawMaterialsDictService.getCategoryForMaterial(n));
          // 该返回值仅作排序比较键（表头“二级品类”列的显示另在 LedgerStyle1Table 里渲染），未分类项按“未分类”拼音参与排序
          if (catKey === UNCATEGORIZED_CATEGORY_KEY) return "未分类";
          const catObj = activeCats.find((c) => c.key === catKey);
          return catObj ? catObj.label : catKey;
        }
        case "supplier":
          return rec.supplier || "";
        case "buyer":
          return rec.buyer || "";
        case "purchaseDate":
          return rec.purchaseDate || selectedDate;
        case "inspector":
          return rec.inspector || "";
        case "keeper":
          return rec.keeper || "";
        case "outHandler":
          return rec.outHandler || "";
        case "outRecipient":
          return rec.outRecipient || "";
        default:
          return "";
      }
    };

    return [...filteredLedgerItems].sort((a, b) => {
      const valA = getFieldValue(a, sortField);
      const valB = getFieldValue(b, sortField);

      let cmp = 0;
      if (sortField === "category") {
        cmp = valA.localeCompare(valB, "zh-CN");
      } else {
        if (!valA && valB) cmp = 1;
        else if (valA && !valB) cmp = -1;
        else cmp = valA.localeCompare(valB, "zh-CN", { numeric: true });
      }

      // 次级排序：当主字段值相同时，按原料名称拼音升序以保证排序展示稳定
      if (cmp === 0) {
        cmp = (a.name || "").localeCompare(b.name || "", "zh-CN");
      }

      return sortOrder === "asc" ? cmp : -cmp;
    });
  }, [filteredLedgerItems, sortField, sortOrder, isRecordingMode, draftRecords, selectedDate]);

  /** 当前台账存在的品类集合（动态），用于品类筛选下拉 */
  const availableCategories = useMemo(() => {
    const catSet = new Set<string>();
    currentLedgerItems.forEach(item => {
      catSet.add(resolveLedgerItemCategory(item, (n) => RawMaterialsDictService.getCategoryForMaterial(n)));
    });
    return Array.from(catSet);
  }, [currentLedgerItems]);

  /** 采购员候选列表（当前台账所有历史记录中出现过的） */
  const availableBuyers = useMemo(() => {
    const set = new Set<string>();
    currentLedgerItems.forEach(item => {
      Object.values(item.dailyRecords || {}).forEach((rec: any) => { if (rec.buyer?.trim()) set.add(rec.buyer.trim()); });
    });
    return Array.from(set).sort();
  }, [currentLedgerItems]);

  /** 检验员候选列表 */
  const availableInspectors = useMemo(() => {
    const set = new Set<string>();
    currentLedgerItems.forEach(item => {
      Object.values(item.dailyRecords || {}).forEach((rec: any) => { if (rec.inspector?.trim()) set.add(rec.inspector.trim()); });
    });
    return Array.from(set).sort();
  }, [currentLedgerItems]);

  /** 保管员候选列表 */
  const availableKeepers = useMemo(() => {
    const set = new Set<string>();
    currentLedgerItems.forEach(item => {
      Object.values(item.dailyRecords || {}).forEach((rec: any) => { if (rec.keeper?.trim()) set.add(rec.keeper.trim()); });
    });
    return Array.from(set).sort();
  }, [currentLedgerItems]);

  /** 是否有任何筛选条件正处于激活状态 */
  const hasActiveFilters = !!(filterName.trim() || filterCategory || filterBuyer.trim() || filterInspector.trim() || filterKeeper.trim());

  // 当切换台账时，自动把样式二的聚焦原料设为该台账的第一个原料项目
  useEffect(() => {
    if (currentLedgerItems.length > 0) {
      setActiveItemId(currentLedgerItems[0].id);
    } else {
      setActiveItemId("");
    }
  }, [activeLedgerId, currentLedgerItems.length]);

  // 当 selectedDate 改变时，默认重置样式二的时间段为当前整月
  useEffect(() => {
    const parts = selectedDate.split("-");
    const year = parseInt(parts[0] || "2026");
    const month = parseInt(parts[1] || "06");

    const firstDay = `${year}-${String(month).padStart(2, "0")}-01`;
    const lastDayNum = new Date(year, month, 0).getDate();
    const lastDay = `${year}-${String(month).padStart(2, "0")}-${String(lastDayNum).padStart(2, "0")}`;

    setStyle2StartDate(firstDay);
    setStyle2EndDate(lastDay);
  }, [selectedDate]);

  /** 解析选定日期的年份与月份 */
  const dateParts = useMemo(() => {
    const p = selectedDate.split("-");
    return {
      year: parseInt(p[0] || "2026"),
      month: parseInt(p[1] || "06"),
      day: p[2] || "01"
    };
  }, [selectedDate]);

  /** 样式二（单原料日流水）自定义时间段内的所有日期列表 */
  const style2DatesArray = useMemo(() => {
    return getDatesBetween(style2StartDate, style2EndDate);
  }, [style2StartDate, style2EndDate]);

  /**
   * @description 样式二下单个原料在自定义时间段内每天的“当日结余库存”映射表。
   * 结余锚定在“真实当前库存”（基于服务端全历史累计的 historicalTotalIn/Out）上，不再从“内存中早于区间的
   * dailyRecords”反推期初——那样在跨月查看时会因为更早月份的记录被按月懒加载排除而算出错误的负库存
   * （见 utils.ts computeLedgerDailyStockBalances）。
   */
  const dailyStockBalances = useMemo(() => {
    if (!activeItemId) return {};
    const item = ledgerItems.find((i) => i.id === activeItemId);
    if (!item) return {};
    return computeLedgerDailyStockBalances(item, style2DatesArray);
  }, [activeItemId, ledgerItems, style2DatesArray]);

  /** 当日有入库行为的项目列表 (用于生成入库单) */
  const dailyInwardItems = useMemo(() => {
    return currentLedgerItems
      .map((item) => ({
        ...item,
        record: item.dailyRecords[selectedDate] || {
          inQuantity: 0, inPrice: 0, inAmount: 0, outQuantity: 0, note: "",
          certification: "", sensoryProperty: "", supplier: "", buyer: "", inspector: "", keeper: "", outHandler: "", outRecipient: ""
        }
      }))
      .filter((item) => item.record.inQuantity > 0);
  }, [currentLedgerItems, selectedDate]);

  /** 当日有出库行为的项目列表 (用于生成出库单) */
  const dailyOutwardItems = useMemo(() => {
    return currentLedgerItems
      .map((item) => ({
        ...item,
        record: item.dailyRecords[selectedDate] || {
          inQuantity: 0, inPrice: 0, inAmount: 0, outQuantity: 0, note: "",
          certification: "", sensoryProperty: "", supplier: "", buyer: "", inspector: "", keeper: "", outHandler: "", outRecipient: ""
        }
      }))
      .filter((item) => item.record.outQuantity > 0);
  }, [currentLedgerItems, selectedDate]);

  /** 当日总入库金额 */
  const dailyInTotalAmount = useMemo(() => {
    return dailyInwardItems.reduce((sum, item) => sum + item.record.inAmount, 0);
  }, [dailyInwardItems]);

  // ================= 事务处理方法 =================

  /**
   * @description 触发自动保存提示气泡
   */
  const triggerSaveToast = () => {
    setSaveToast(LEDGER_UI_TEXT.autoSaveSuccess);
    const t = setTimeout(() => setSaveToast(null), 2000);
    return () => clearTimeout(t);
  };

  /**
   * @description 弹出错误信息提示并自动淡出
   */
  const triggerError = (msg: string) => {
    setErrorMessage(msg);
    setTimeout(() => setErrorMessage(null), 4000);
  };

  /**
   * @description 重命名台账
   */
  const handleRenameLedgerSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!renameLedgerId || !renameLedgerName.trim()) return;
    LedgerService.updateLedger(renameLedgerId, renameLedgerName)
      .then(() => {
        setRenameLedgerId(null);
        setRenameLedgerName("");
      })
      .catch((err) => triggerError(err.message));
  };

  /**
   * @description 保存编辑后的原料配置信息
   */
  const handleSaveEditMaterial = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMaterialId || !editMaterialName.trim()) return;
    LedgerService.updateLedgerItem(
      editingMaterialId,
      editMaterialName,
      editMaterialUnit,
      editMaterialSpec,
      editMaterialStock
    )
      .then(() => {
        setEditingMaterialId(null);
      })
      .catch((err) => triggerError(err.message));
  };

  /**
   * @description 物理删除原料采购项目
   */
  const handleDeleteMaterial = (id: string) => {
    const item = currentLedgerItems.find((i) => i.id === id);
    if (!item) return;

    // 判断该原料在“当前所选日期以外的日期”是否还有记录时，绝不能只看前端内存里的 dailyRecords ——
    // 按月懒加载下内存通常只有当前查看的月份，别的月份即使有记录也不在内存里。
    // 一旦据此误判为“没有其它记录”，就会走进“物理删除整个原料 + 全部历史流水”的分支，把用户几个月前
    // 录入的数据（比如蔬菜）连根删掉。这里叠加服务端提供的全历史信息（首/末记录日期、累计出入库量）一起判断。
    const memOtherDates = Object.keys(item.dailyRecords).some((date) => {
      if (date === selectedDate) return false;
      const r = item.dailyRecords[date];
      return !!r && (r.inQuantity > 0 || r.outQuantity > 0 || !!r.purchaseDate || !!r.supplier || !!r.note ||
        !!r.buyer || !!r.inspector || !!r.keeper || !!r.outHandler || !!r.outRecipient);
    });
    const firstDate = item.historicalFirstRecordDate;
    const lastDate = item.historicalLastRecordDate;
    const serverDatesBeyondSelected =
      (!!firstDate && firstDate !== selectedDate) || (!!lastDate && lastDate !== selectedDate);
    // 服务端全历史累计出入库量，减去当前所选日内存里那条记录的量，若仍 > 0 说明别的日期也有流水
    const selRec = item.dailyRecords[selectedDate];
    const histInBeyond = (item.historicalTotalIn ?? 0) - (selRec?.inQuantity ?? 0);
    const histOutBeyond = (item.historicalTotalOut ?? 0) - (selRec?.outQuantity ?? 0);
    const serverTotalsBeyondSelected = histInBeyond > 0.001 || histOutBeyond > 0.001;

    const hasRecordsBeyondSelectedDate = memOtherDates || serverDatesBeyondSelected || serverTotalsBeyondSelected;

    // 是否拿到了服务端预聚合的“全历史首/末记录日期”这对字段。正常本地模式的 GET /load 一定带上（有记录时是日期串，
    // 无记录时是 null）；只有“本次部署之前加载、还没刷新的老标签页”或 COS 模式才会整键缺失（undefined）。
    const historyDatesKnown = firstDate !== undefined || lastDate !== undefined;
    // 敢走“物理删除整个原料 + 全部历史”的前提：确信除了当前所选日之外没有别的历史。
    // 字段已知 → 首/末记录日期要么不存在、要么就等于当前所选日（历史全在这一天，删掉只损失眼前看到的这条）。
    const confidentSafeToFullyDelete =
      historyDatesKnown &&
      (!firstDate || firstDate === selectedDate) &&
      (!lastDate || lastDate === selectedDate);

    LogBroker.publish(
      "INFO",
      "LedgerSystem",
      `点击删除台账原料【${item.name}】(id=${item.id})：判定为${
        hasRecordsBeyondSelectedDate ? "「仅清除当天记录」" : confidentSafeToFullyDelete ? "「物理删除整个原料及全部历史」" : "「无法确认历史，拦截并提示刷新」"
      }`,
      `依据 -> 内存中其它日期有记录:${memOtherDates}, 服务端首/末记录日期越界:${serverDatesBeyondSelected}(first=${firstDate ?? "∅"},last=${lastDate ?? "∅"}), 服务端累计量越界:${serverTotalsBeyondSelected}(histIn=${item.historicalTotalIn ?? "∅"},histOut=${item.historicalTotalOut ?? "∅"}), 服务端首末日期字段已知:${historyDatesKnown}; selectedDate=${selectedDate}`
    );

    if (!hasRecordsBeyondSelectedDate && !confidentSafeToFullyDelete) {
      // 没有“别处还有记录”的正向信号，但服务端首/末日期字段缺失（多半是数据尚未完整加载 / 老标签页），
      // 无法确认是否有跨月历史。绝不物理删除——一旦确有历史就是连根删。拦下来让用户刷新页面后再操作。
      triggerError(`暂时无法确认【${item.name}】在其它日期是否还有记录（数据可能尚未完整加载），请刷新页面后再删除该原料，以免误删历史数据。`);
      return;
    }

    if (hasRecordsBeyondSelectedDate) {
      if (confirm(`【${item.name}】在其它日期还有出入库记录，这里只会清除（${selectedDate}）当天的记录，不会影响其它日期。确定清除吗？`)) {
        LedgerService.updateDailyRecord(item.id, selectedDate, {
          inQuantity: 0,
          inPrice: 0,
          inAmount: 0,
          outQuantity: 0,
          certification: "",
          sensoryProperty: "",
          supplier: "",
          purchaseDate: "",
          buyer: "",
          produceDate: "",
          shelfLife: "",
          inspector: "",
          keeper: "",
          outHandler: "",
          outRecipient: "",
          note: ""
        }).catch((err) => triggerError(err.message));
      }
    } else {
      if (confirm(LEDGER_UI_TEXT.deleteMaterialConfirm)) {
        LedgerService.deleteLedgerItem(id).catch((err) => triggerError(err.message));
      }
    }
  };

  /**
   * @description 一键批量将发料人(出库人)和领料人(接收人)同步应用到今日所有有出入库变动的项目上
   */
  const handleApplyBatchSignatures = () => {
    if (dailyInwardItems.length === 0 && dailyOutwardItems.length === 0) {
      triggerError("今日该台账暂无任何出入库原料变动，无需填写签字。");
      return;
    }

    const handler = batchOutHandler.trim();
    const recipient = batchOutRecipient.trim();
    if (!handler && !recipient) {
      triggerError("请先填写出库人或接收人姓名，再点击一键应用。");
      return;
    }

    // 汇总成一次批量提交（键为 itemId），只带 outHandler / outRecipient 两个字段，
    // 服务端按当天做字段级浅合并，不会动该日已有的数量/单价/供货商/索证等其它字段。
    // 用批量接口而非逐项并发 PUT：一次请求 = 一次版本校验，避免多个并发写共用同一过期版本号相互撞 409；
    // 且整批走单个事务，要么全写要么全不写，不会出现“签了一半”的中间态。
    const batchUpdates: Record<string, Partial<DailyStockRecord>> = {};
    currentLedgerItems.forEach((item) => {
      const record = item.dailyRecords[selectedDate];
      if (record && (record.inQuantity > 0 || record.outQuantity > 0)) {
        const fieldsToUpdate: Partial<DailyStockRecord> = {};
        if (handler) fieldsToUpdate.outHandler = handler;
        if (recipient) fieldsToUpdate.outRecipient = recipient;
        batchUpdates[item.id] = fieldsToUpdate;
      }
    });

    if (Object.keys(batchUpdates).length === 0) {
      triggerError("当前所选日期没有需要填写签字的出入库记录。");
      return;
    }

    LedgerService.updateDailyRecordsBatch(selectedDate, batchUpdates)
      .then(() => {
        triggerSaveToast();
        setBatchOutHandler("");
        setBatchOutRecipient("");
        LogBroker.publish("INFO", "LedgerSystem", `批量填报 ${selectedDate} 签字：出库/发料人「${handler}」，接收/领料人「${recipient}」，共 ${Object.keys(batchUpdates).length} 项`);
      })
      .catch((err) => {
        const raw = err instanceof Error ? err.message : String(err);
        const msg = raw === "VERSION_CONFLICT"
          ? "台账数据已被其它页面或设备更新，请刷新页面获取最新数据后再重试。"
          : `批量应用签字失败：${raw}`;
        triggerError(msg);
      });
  };

  // ================= 导出与打印核心逻辑 =================

  /**
   * @description 导出当日入库单为 CSV 格式 (添加 UTF-8 BOM 防乱码，完全包含类别、出库人、接收人等属性)
   */
  const handleExportInwardCsv = () => {
    if (!activeLedger) return;
    let csv = "类别(台账),序号,食品原材料品名,规格描述,单位,入库数量,单价(元),入库金额(元),发料出库人(采购员),接收人(检验/保管),食品索证,感官性状,备注\n";
    dailyInwardItems.forEach((item, index) => {
      const record = item.record;
      csv += `${activeLedger.name}台账,${index + 1},${item.name},${item.spec || ""},${item.unit},${record.inQuantity},${record.inPrice},${record.inAmount},${record.outHandler || record.buyer || ""},${record.outRecipient || record.inspector || ""},${record.certification || ""},${record.sensoryProperty || ""},${record.note || ""}\n`;
    });
    csv += `,,,,,合计金额,,${dailyInTotalAmount},,,,,\n`;

    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${activeLedger.name}台账_入库单_${selectedDate}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    LogBroker.publish("INFO", "LedgerSystem", `成功导出「${activeLedger.name}」在 [${selectedDate}] 的当日入库单 CSV。`);
  };

  /**
   * @description 导出当日出库单为 CSV 格式 (添加 UTF-8 BOM 防乱码，包含出库人、接收人等属性)
   */
  const handleExportOutwardCsv = () => {
    if (!activeLedger) return;
    let csv = "类别(台账),序号,食品原材料品名,规格描述,单位,出库数量,发料出库人,接收人(领料),食品索证,感官性状,备注去处\n";
    dailyOutwardItems.forEach((item, index) => {
      const record = item.record;
      csv += `${activeLedger.name}台账,${index + 1},${item.name},${item.spec || ""},${item.unit},${record.outQuantity},${record.outHandler || ""},${record.outRecipient || ""},${record.certification || ""},${record.sensoryProperty || ""},${record.note || ""}\n`;
    });

    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${activeLedger.name}台账_出库单_${selectedDate}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    LogBroker.publish("INFO", "LedgerSystem", `成功导出「${activeLedger.name}」在 [${selectedDate}] 的当日出库单 CSV。`);
  };

  /**
   * @description 唤醒纯净打印覆盖层
   * @param type "in" | "out"
   */
  const triggerPrintDoc = (type: "in" | "out") => {
    setPrintDocType(type);
  };

  // ================= 视图渲染部分 =================

  // ================= (老版本) 打印入库单与出库单凭证覆盖层 =================
  if (printDocType) {
    return (
      <LedgerPrintDoc
        printDocType={printDocType}
        activeLedger={activeLedger}
        selectedDate={selectedDate}
        dailyInwardItems={dailyInwardItems}
        dailyOutwardItems={dailyOutwardItems}
        dailyInTotalAmount={dailyInTotalAmount}
        customDataRows={customDataRowsDoc}
        setCustomDataRows={setCustomDataRowsDoc}
        customSupplierRows={customSupplierRowsDoc}
        setCustomSupplierRows={setCustomSupplierRowsDoc}
        onClose={() => setPrintDocType(null)}
      />
    );
  }

  // ================= (新) 打印总表及单原料月流水覆盖层 =================
  if (printPreviewStyle) {
    return (
      <LedgerPrintPreviewOverlay
        printPreviewStyle={printPreviewStyle}
        setPrintPreviewStyle={setPrintPreviewStyle}
        activeLedger={activeLedger}
        selectedDate={selectedDate}
        selectedPrintCategories={selectedPrintCategories}
        currentLedgerItems={currentLedgerItems}
        activeItemId={activeItemId}
        ledgerItems={sortedFilteredLedgerItems}
        style2StartDate={style2StartDate}
        style2EndDate={style2EndDate}
        style2DatesArray={style2DatesArray}
        customDataRows={customDataRowsLedger}
        setCustomDataRows={setCustomDataRowsLedger}
      />
    );
  }

  return (
    <div className="flex flex-col lg:flex-row h-full w-full bg-[#f1f5f9] text-slate-800 font-sans overflow-hidden">

      {/* 左侧台账选择名录区 */}
      <LedgerSidebar
        ledgers={ledgers}
        activeLedgerId={activeLedgerId}
        renameLedgerId={renameLedgerId}
        renameLedgerName={renameLedgerName}
        setActiveLedgerId={setActiveLedgerId}
        setRenameLedgerName={setRenameLedgerName}
        setRenameLedgerId={setRenameLedgerId}
        handleRenameLedgerSubmit={handleRenameLedgerSubmit}
      />

      {/* 右侧明细录入区 */}

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-[#f8fafc]">

        {/* 页眉日期及样式选择栏 */}
        <div className="p-3 bg-white border-b border-slate-200 flex flex-col xl:flex-row xl:items-center justify-between gap-2 shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-bold text-slate-800 flex items-center gap-1.5">
                <FileText className="text-emerald-600" size={16} />
                「{activeLedger?.name || "未选择"}」购销与库存台账
              </h2>
              {saveToast && (
                <span className="text-[11px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded border border-emerald-200 animate-pulse">
                  {saveToast}
                </span>
              )}
            </div>
            <p className="text-[12px] text-slate-400 mt-0.5">{LEDGER_UI_TEXT.moduleSubtitle}</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* 日期选择器：非“今天”时整体转琥珀色并显式标注，避免把往日的账误当今天录入 */}
            <div
              className={`flex items-center gap-2 border rounded-lg px-2.5 py-1.5 w-fit transition-colors ${
                isSelectedDateToday ? "bg-slate-50 border-slate-200" : "bg-amber-50 border-amber-300"
              }`}
            >
              <Calendar size={13} className={isSelectedDateToday ? "text-slate-500" : "text-amber-600"} />
              <span className={`text-[12px] font-medium ${isSelectedDateToday ? "text-slate-500" : "text-amber-700"}`}>录入日期：</span>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => {
                  setSelectedDate(e.target.value);
                  LogBroker.publish("INFO", "LedgerSystem", `切换台账数据录入日期为: ${e.target.value}`);
                }}
                className={`bg-transparent text-[13px] font-bold outline-none cursor-pointer ${isSelectedDateToday ? "text-slate-700" : "text-amber-800"}`}
              />
              <span
                className={`text-[11px] font-black px-1.5 py-0.5 rounded shrink-0 ${
                  isSelectedDateToday ? "bg-emerald-100 text-emerald-700" : "bg-amber-500 text-white"
                }`}
              >
                {isSelectedDateToday ? "今天" : "非今天"}
              </span>
            </div>
          </div>
        </div>

        {/* 当前同步日期无记录提示：提醒用户本台账数据实际记录在其他日期，避免误以为台账数据丢失 */}
        {nearestRecordDateHint && (
          <div className="mx-4 mt-3 bg-amber-50 border border-amber-200 text-amber-800 text-[13px] px-4 py-2.5 rounded-lg flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Calendar size={14} className="shrink-0" />
              <span>
                当前所选录入日期（<strong>{selectedDate}</strong>）在本台账下暂无出入库记录，本台账最近一次录入记录的日期为 <strong>{nearestRecordDateHint}</strong>，并非数据丢失，你可以切换日期查看。
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                setSelectedDate(nearestRecordDateHint);
                LogBroker.publish("INFO", "LedgerSystem", `根据提示跳转切换台账同步日期为最近记录日期: ${nearestRecordDateHint}`);
              }}
              className="shrink-0 px-2.5 py-1 bg-amber-100 hover:bg-amber-200 text-amber-800 font-bold rounded cursor-pointer transition-all"
            >
              跳转查看该日期
            </button>
          </div>
        )}

        {/* 错误警示 */}
        {errorMessage && (
          <div className="mx-4 mt-3 bg-rose-50 border border-rose-200 text-rose-800 text-[13px] px-4 py-2.5 rounded-lg flex items-center gap-2 animate-bounce">
            <AlertCircle size={14} className="shrink-0" />
            <span>警告: {errorMessage}</span>
          </div>
        )}

        <LedgerControlBar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          isRecordingMode={isRecordingMode}
          ledgerItems={ledgerItems}
          activeItemId={activeItemId}
          setActiveItemId={setActiveItemId}
          currentLedgerItems={currentLedgerItems}
          ledgerStyle={ledgerStyle}
          setLedgerStyle={setLedgerStyle}
          dailyInwardItems={dailyInwardItems}
          dailyOutwardItems={dailyOutwardItems}
          batchOutHandler={batchOutHandler}
          setBatchOutHandler={setBatchOutHandler}
          batchOutRecipient={batchOutRecipient}
          setBatchOutRecipient={setBatchOutRecipient}
          handleStartRecording={handleStartRecording}
          handleConfirmRecording={handleConfirmRecording}
          handleCancelRecording={handleCancelRecording}
          handleApplyBatchSignatures={handleApplyBatchSignatures}
          handleExportInwardCsv={handleExportInwardCsv}
          handleExportOutwardCsv={handleExportOutwardCsv}
          setPrintModalOpen={handleTogglePrintModal}
          setPrintPreviewStyle={setPrintPreviewStyle}
          triggerPrintDoc={triggerPrintDoc}
          selectedDate={selectedDate}
          isSelectedDateToday={isSelectedDateToday}
        />

        {/* 主体工作区 */}

        <div className="flex-1 overflow-auto p-4 scrollbar-thin">

          {/* Tab 1: 台账数据录入 */}
          {activeTab === "entry" && (
            <>
              {/* 样式一：食品原材料购销总表 (图一样式) */}
              {ledgerStyle === "style1" && (
                <LedgerStyle1Table
                  currentLedgerItems={currentLedgerItems}
                  filteredLedgerItems={sortedFilteredLedgerItems}
                  selectedDate={selectedDate}
                  isRecordingMode={isRecordingMode}
                  draftRecords={draftRecords}
                  editingMaterialId={editingMaterialId}
                  editMaterialName={editMaterialName}
                  editMaterialSpec={editMaterialSpec}
                  editMaterialUnit={editMaterialUnit}
                  editMaterialStock={editMaterialStock}
                  dictOptions={dictOptions}
                  availableCategories={availableCategories}
                  availableBuyers={availableBuyers}
                  availableInspectors={availableInspectors}
                  availableKeepers={availableKeepers}
                  filterName={filterName}
                  filterCategory={filterCategory}
                  filterBuyer={filterBuyer}
                  filterInspector={filterInspector}
                  filterKeeper={filterKeeper}
                  hasActiveFilters={hasActiveFilters}
                  sortField={sortField}
                  sortOrder={sortOrder}
                  onToggleSort={handleToggleSort}
                  setFilterName={setFilterName}
                  setFilterCategory={setFilterCategory}
                  setFilterBuyer={setFilterBuyer}
                  setFilterInspector={setFilterInspector}
                  setFilterKeeper={setFilterKeeper}
                  handleSaveEditMaterial={handleSaveEditMaterial}
                  handleDeleteMaterial={handleDeleteMaterial}
                  handleDraftCellChange={handleDraftCellChange}
                  setEditingMaterialId={setEditingMaterialId}
                  setEditMaterialName={setEditMaterialName}
                  setEditMaterialSpec={setEditMaterialSpec}
                  setEditMaterialUnit={setEditMaterialUnit}
                  setEditMaterialStock={setEditMaterialStock}
                />
              )}

              {/* 样式二：单原料日出入库流水账 (图二样式) */}
              {ledgerStyle === "style2" && (
                <LedgerStyle2Flow
                  activeItemId={activeItemId}
                  ledgerItems={ledgerItems}
                  dateParts={dateParts}
                  selectedDate={selectedDate}
                  isRecordingMode={isRecordingMode}
                  draftRecords={draftRecords}
                  style2DatesArray={style2DatesArray}
                  dailyStockBalances={dailyStockBalances}
                  handleDraftCellChange={handleDraftCellChange}
                  style2StartDate={style2StartDate}
                  style2EndDate={style2EndDate}
                  setStyle2StartDate={setStyle2StartDate}
                  setStyle2EndDate={setStyle2EndDate}
                />
              )}
            </>
          )}

          {/* Tab 2: 当日出入库单 (明细归集) */}
          {activeTab === "invoice" && (
            <LedgerInvoiceTab
              dailyInwardItems={dailyInwardItems}
              dailyOutwardItems={dailyOutwardItems}
              dailyInTotalAmount={dailyInTotalAmount}
            />
          )}

        </div>
      </div>

      {/* 二级分类打印勾选模态弹框 */}
      <LedgerPrintModal
        isOpen={printModalOpen}
        selectedPrintCategories={selectedPrintCategories}
        setSelectedPrintCategories={setSelectedPrintCategories}
        setPrintPreviewStyle={setPrintPreviewStyle}
        printableCategories={printableCategories}
        onClose={() => setPrintModalOpen(false)}
      />

    </div>
  );
}