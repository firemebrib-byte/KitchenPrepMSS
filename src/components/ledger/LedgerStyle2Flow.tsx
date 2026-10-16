/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 台账"样式二"单原料日流水组件：聚焦单个原料，以自定义时间段纵向展示其逐日出入库记录卡片。
 */

import { useRef } from "react";
import { Award, ChevronLeft, ChevronRight } from "lucide-react";
import { LedgerItem, DailyStockRecord } from "../../types/ledgerTypes.ts";
import { LEDGER_UI_TEXT } from "../../constants/ledgerConstants.ts";
import { LedgerService } from "../../services/ledgerStore.ts";
import { RawMaterialsDictService } from "../../services/rawMaterialDict.ts";
import { HelperSelect } from "../shared/HelperSelect.tsx";
import { SensorySelector } from "../shared/SensorySelector.tsx";

/**
 * @description 单原料日出入库流水账组件入参接口
 */
interface LedgerStyle2FlowProps {
  /** 处于激活状态的原料项目 ID */
  activeItemId: string | null;
  /** 台账所有的原料项目 */
  ledgerItems: LedgerItem[];
  /** 日期解析的年、月结构 */
  dateParts: { year: number; month: number };
  /** 选中的单日期 */
  selectedDate: string;
  /** 系统是否处于录入状态 */
  isRecordingMode: boolean;
  /** 草稿数据映射表 */
  draftRecords: Record<string, DailyStockRecord>;
  /** 样式二自定义范围内的全量日期列表 */
  style2DatesArray: string[];
  /** 每日库存结余计算结果 */
  dailyStockBalances: Record<string, number>;
  /** 编辑草稿的回调函数 */
  handleDraftCellChange: (itemId: string, fields: Partial<DailyStockRecord>) => void;
  /** 采购时间段 - 开始日期 */
  style2StartDate: string;
  /** 采购时间段 - 结束日期 */
  style2EndDate: string;
  /** 设置开始日期的回调 */
  setStyle2StartDate: (val: string) => void;
  /** 设置结束日期的回调 */
  setStyle2EndDate: (val: string) => void;
}

export function LedgerStyle2Flow({
  activeItemId,
  ledgerItems,
  dateParts,
  selectedDate,
  isRecordingMode,
  draftRecords,
  style2DatesArray,
  dailyStockBalances,
  handleDraftCellChange,
  style2StartDate,
  style2EndDate,
  setStyle2StartDate,
  setStyle2EndDate
}: LedgerStyle2FlowProps) {
  /** 月度流水表格横向滚动容器引用，供左右移动按钮调用 */
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const scrollTable = (dir: number) => {
    tableScrollRef.current?.scrollBy({ left: dir * 320, behavior: "smooth" });
  };

  if (!activeItemId) {
    return (
      <div className="text-center py-12 bg-white border border-slate-200 rounded-xl text-slate-400 italic">
        该台账暂无采购原料项目。请切换到总表模式（图一）点击左上方“开启当日录入”进入录入模式，选择字典中的原料并填写数据即可自动添加。
      </div>
    );
  }

  const activeItem = ledgerItems.find((i) => i.id === activeItemId);
  if (!activeItem) return null;

  const dictItem = RawMaterialsDictService.getItems().find((d) => d.name === activeItem.name);
  const hasConversion = !!(dictItem && dictItem.conversionUnit && dictItem.conversionRatio);
  const displayUnit = hasConversion ? dictItem.conversionUnit : dictItem?.unit || activeItem.unit || "";

  // 提取当月有记录的供应商与索证，做成表头绑定
  const currentMonthStr = `${dateParts.year}-${String(dateParts.month).padStart(2, "0")}`;
  const sampleRecord = Object.entries(activeItem.dailyRecords).find(
    ([d, rec]) => d.startsWith(currentMonthStr) && (rec.supplier || rec.certification)
  )?.[1] || { supplier: "", certification: "" };

  const draftRecord = draftRecords[activeItem.id];
  const recordForSelectedDate = activeItem.dailyRecords[selectedDate] || { supplier: "", certification: "" };
  const currentSupplier = isRecordingMode ? (draftRecord?.supplier ?? "") : (recordForSelectedDate.supplier ?? sampleRecord.supplier ?? "");
  const currentCertification = isRecordingMode ? (draftRecord?.certification ?? "") : (recordForSelectedDate.certification ?? sampleRecord.certification ?? "");

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden p-5 space-y-4">
      
      {/* 采购时间段筛选栏 */}
      <div className="bg-slate-50 border border-slate-100 rounded-lg p-3 flex flex-wrap items-center gap-3 text-xs">
        <span className="font-bold text-slate-500">采购流水时间段筛选:</span>
        <div className="flex items-center gap-2">
          <input 
            type="date"
            value={style2StartDate}
            onChange={(e) => setStyle2StartDate(e.target.value)}
            className="bg-white border border-slate-200 px-2 py-1 rounded outline-none focus:border-emerald-500 font-mono"
          />
          <span className="text-slate-400">至</span>
          <input 
            type="date"
            value={style2EndDate}
            onChange={(e) => setStyle2EndDate(e.target.value)}
            className="bg-white border border-slate-200 px-2 py-1 rounded outline-none focus:border-emerald-500 font-mono"
          />
        </div>
        <span className="text-[10px] text-slate-400 font-medium">（默认当前月，可手动修改任意时间段范围进行流水过滤及打印）</span>
      </div>

      {/* 样式二表头与经销商信息 */}
      <div className="bg-slate-50 border border-slate-100 rounded-lg p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <span className="text-[11px] font-bold text-slate-400 block uppercase">采购项目</span>
          <div className="text-sm font-black text-slate-800 mt-1 flex items-center gap-1.5">
            <Award size={15} className="text-emerald-600" />
            {activeItem.name} ({activeItem.unit})
          </div>
        </div>
        
        <div>
          <span className="text-[11px] font-bold text-slate-400 block uppercase">经销商/供货商</span>
          <input 
            type="text"
            value={currentSupplier}
            placeholder={isRecordingMode ? LEDGER_UI_TEXT.defaultSupplierPlaceholder : "未开启录入"}
            disabled={!isRecordingMode}
            onChange={(e) => {
              handleDraftCellChange(activeItem.id, { supplier: e.target.value });
            }}
            className="w-full bg-white disabled:bg-slate-50 disabled:text-slate-400 border border-slate-200 px-2.5 py-1 mt-1 rounded text-xs outline-none focus:border-emerald-500"
          />
        </div>

        <div>
          <span className="text-[11px] font-bold text-slate-400 block uppercase">索证索票情况</span>
          <input 
            type="text"
            value={currentCertification}
            placeholder={isRecordingMode ? LEDGER_UI_TEXT.defaultCertificationPlaceholder : "未开启录入"}
            disabled={!isRecordingMode}
            onChange={(e) => {
              handleDraftCellChange(activeItem.id, { certification: e.target.value });
            }}
            className="w-full bg-white disabled:bg-slate-50 disabled:text-slate-400 border border-slate-200 px-2.5 py-1 mt-1 rounded text-xs outline-none focus:border-emerald-500"
          />
        </div>
      </div>

      {/* 月度流水网格 */}
      <div className="relative">
        {/* 左右移动导航栏：粘性定位随纵向滚动始终悬浮在可视区域内，方便查看过长记录行时随时左右移动查看 */}
        <div className="sticky top-2 z-20 h-0 pointer-events-none">
          <div className="flex justify-between px-1.5">
            <button
              type="button"
              onClick={() => scrollTable(-1)}
              className="pointer-events-auto p-1.5 bg-white/90 hover:bg-white border border-slate-200 rounded-full shadow-md text-slate-500 hover:text-emerald-600 cursor-pointer transition-all"
              title="向左移动查看更多字段"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => scrollTable(1)}
              className="pointer-events-auto p-1.5 bg-white/90 hover:bg-white border border-slate-200 rounded-full shadow-md text-slate-500 hover:text-emerald-600 cursor-pointer transition-all"
              title="向右移动查看更多字段"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
        <div ref={tableScrollRef} className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs min-w-[1000px]">
          <thead>
            <tr className="bg-slate-100/50 text-slate-500 border-b border-slate-200 text-center font-bold">
              <th className="px-4 py-2.5 font-bold w-28">日期</th>
              <th className="px-3 py-2.5 font-bold bg-emerald-50/20 w-24">采购数量</th>
              <th className="px-3 py-2.5 font-bold w-28">生产日期</th>
              <th className="px-3 py-2.5 font-bold w-24">保质期</th>
              <th className="px-3 py-2.5 font-bold w-24">采购员</th>
              <th className="px-3 py-2.5 font-bold w-24">感官性状</th>
              <th className="px-3 py-2.5 font-bold w-24">检验员</th>
              <th className="px-3 py-2.5 font-bold bg-indigo-50/10 w-24">出库数量</th>
              <th className="px-3 py-2.5 font-bold bg-slate-100/80 w-28">当日库存</th>
              <th className="px-3 py-2.5 font-bold w-24">保管员</th>
              <th className="px-3 py-2.5 font-bold bg-indigo-50/10 w-24">出库人</th>
              <th className="px-3 py-2.5 font-bold bg-indigo-50/10 w-24">接收人</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-center">
            {style2DatesArray.map((dayDateStr) => {
              const record = activeItem.dailyRecords[dayDateStr] || {
                inQuantity: 0, outQuantity: 0, buyer: "", inspector: "", keeper: "",
                produceDate: "", shelfLife: "", sensoryProperty: "", outHandler: "", outRecipient: ""
              };
              const balance = dailyStockBalances[dayDateStr] ?? activeItem.initialStock;
              const displayBalance = hasConversion ? Number((balance * dictItem!.conversionRatio!).toFixed(2)) : balance;

              const isRowEditable = isRecordingMode && dayDateStr === selectedDate;
              const dRec = draftRecords[activeItem.id];
              const recordToRender = isRowEditable ? (dRec || {
                inQuantity: 0, outQuantity: 0, buyer: "", inspector: "", keeper: "",
                produceDate: "", shelfLife: "", sensoryProperty: "", outHandler: "", outRecipient: ""
              }) : record;

              return (
                <tr key={dayDateStr} className={`hover:bg-slate-50/50 ${dayDateStr === selectedDate ? "bg-amber-50/20" : ""}`}>
                  <td className="px-4 py-2 font-mono text-slate-500 font-bold flex items-center justify-center gap-1">
                    <span>{dayDateStr}</span>
                    {dayDateStr === selectedDate && (
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping" title="当前选中同步日"></span>
                    )}
                  </td>
                  
                  {/* 采购数量 */}
                  <td className="px-2 py-1.5 bg-emerald-50/10">
                    <input 
                      type="number" step="any"
                      value={recordToRender.inQuantity || ""}
                      placeholder={isRowEditable ? "0" : "锁定"}
                      disabled={!isRowEditable}
                      onChange={(e) => handleDraftCellChange(activeItem.id, { inQuantity: Number(e.target.value) })}
                      className="w-full bg-white disabled:bg-slate-50/30 disabled:text-slate-400 border border-slate-200 px-2 py-1 rounded text-right font-mono outline-none"
                    />
                  </td>
                  
                  {/* 生产日期 */}
                  <td className="px-2 py-1.5">
                    <input 
                      type="date"
                      value={recordToRender.produceDate || ""}
                      disabled={!isRowEditable}
                      onChange={(e) => handleDraftCellChange(activeItem.id, { produceDate: e.target.value })}
                      className="w-full bg-white disabled:bg-slate-50/30 disabled:text-slate-300 border border-slate-200 px-1.5 py-1 rounded outline-none font-mono text-xs focus:border-emerald-500"
                    />
                  </td>

                  {/* 保质期 */}
                  <td className="px-2 py-1.5">
                    {isRowEditable ? (
                      <select
                        value={recordToRender.shelfLife || ""}
                        onChange={(e) => handleDraftCellChange(activeItem.id, { shelfLife: e.target.value })}
                        className="w-full bg-white border border-slate-200 px-2 py-1 rounded outline-none text-xs cursor-pointer focus:border-emerald-500"
                      >
                        <option value="">-- 选择 --</option>
                        {LedgerService.getHelperDict().shelfLifeOptions.map((opt) => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    ) : (
                      <input 
                        type="text"
                        value={recordToRender.shelfLife || ""}
                        placeholder="锁定"
                        disabled={true}
                        className="w-full bg-slate-50/30 text-slate-400 border border-slate-200 px-2 py-1 rounded outline-none"
                      />
                    )}
                  </td>

                  {/* 采购员 */}
                  <td className="px-2 py-1.5">
                    <HelperSelect
                      value={recordToRender.buyer || ""}
                      options={LedgerService.getHelperDict().buyers}
                      disabled={!isRowEditable}
                      onChange={(val) => handleDraftCellChange(activeItem.id, { buyer: val })}
                      placeholder="锁定"
                      className="w-full"
                      disabledClassName="bg-slate-50/30 text-slate-400 text-xs"
                      focusBorderClassName="focus:border-emerald-500"
                    />
                  </td>

                  {/* 感官性状 */}
                  <td className="px-2 py-1.5">
                    <SensorySelector
                      value={recordToRender.sensoryProperty || ""}
                      disabled={!isRowEditable}
                      onChange={(val) => handleDraftCellChange(activeItem.id, { sensoryProperty: val })}
                      disabledPlaceholder="锁定"
                      disabledClassName="disabled:bg-slate-50/30"
                      focusBorderClassName="focus:border-emerald-500"
                      minWidthPx={192}
                    />
                  </td>

                  {/* 检验员 */}
                  <td className="px-2 py-1.5">
                    <HelperSelect
                      value={recordToRender.inspector || ""}
                      options={LedgerService.getHelperDict().inspectors}
                      disabled={!isRowEditable}
                      onChange={(val) => handleDraftCellChange(activeItem.id, { inspector: val })}
                      placeholder="锁定"
                      className="w-full"
                      disabledClassName="bg-slate-50/30 text-slate-400 text-xs"
                      focusBorderClassName="focus:border-emerald-500"
                    />
                  </td>

                  {/* 出库数量 */}
                  <td className="px-2 py-1.5 bg-indigo-50/5">
                    <input 
                      type="number" step="any"
                      value={recordToRender.outQuantity || ""}
                      placeholder={isRowEditable ? "0" : "锁定"}
                      disabled={!isRowEditable}
                      onChange={(e) => handleDraftCellChange(activeItem.id, { outQuantity: Number(e.target.value) })}
                      className="w-full bg-white disabled:bg-slate-50/30 disabled:text-slate-400 border border-slate-200 px-2 py-1 rounded text-right font-mono outline-none"
                    />
                  </td>

                  {/* 当日库存/结余 (公式累算) */}
                  <td className="px-3 py-1.5 bg-slate-100/50 font-mono font-black text-slate-800 text-right">
                    {displayBalance}{displayUnit !== "" ? displayUnit : ""}
                  </td>

                  {/* 保管员 */}
                  <td className="px-2 py-1.5">
                    <HelperSelect
                      value={recordToRender.keeper || ""}
                      options={LedgerService.getHelperDict().keepers}
                      disabled={!isRowEditable}
                      onChange={(val) => handleDraftCellChange(activeItem.id, { keeper: val })}
                      placeholder="锁定"
                      className="w-full"
                      disabledClassName="bg-slate-50/30 text-slate-400 text-xs"
                      focusBorderClassName="focus:border-emerald-500"
                    />
                  </td>

                  {/* 出库人 */}
                  <td className="px-2 py-1.5 bg-indigo-50/5">
                    <HelperSelect
                      value={recordToRender.outHandler || ""}
                      options={LedgerService.getHelperDict().outHandlers}
                      disabled={!isRowEditable}
                      onChange={(val) => handleDraftCellChange(activeItem.id, { outHandler: val })}
                      placeholder="锁定"
                      className="w-full"
                      disabledClassName="bg-slate-50/30 text-slate-400 text-xs"
                      focusBorderClassName="focus:border-emerald-500"
                    />
                  </td>

                  {/* 接收人 */}
                  <td className="px-2 py-1.5 bg-indigo-50/5">
                    <HelperSelect
                      value={recordToRender.outRecipient || ""}
                      options={LedgerService.getHelperDict().outRecipients}
                      disabled={!isRowEditable}
                      onChange={(val) => handleDraftCellChange(activeItem.id, { outRecipient: val })}
                      placeholder="锁定"
                      className="w-full"
                      disabledClassName="bg-slate-50/30 text-slate-400 text-xs"
                      focusBorderClassName="focus:border-emerald-500"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}
