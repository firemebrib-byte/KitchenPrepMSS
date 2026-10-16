/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 管理后台"台账人员与供货商"Tab：提供供货商及地址、采购员、检验员、保管员、出库人、接收人六大类常用名单的录入与删除，供台账录入界面自动升级为下拉选择框。
 */

import React, { useState } from "react";
import { LedgerService } from "../../services/ledgerStore.ts";
import { Plus, Trash2, ShieldCheck, HelpCircle } from "lucide-react";

/**
 * @description 管理后台台账辅助字典配置面板 (🚚 供货商及人员名单)
 */
export const AdminLedgerHelpersTab: React.FC = () => {
  // --- 触发组件局部重绘的状态 ---
  const [, setTick] = useState(0);

  // --- 每个列表的输入框状态 ---
  const [inputs, setInputs] = useState({
    suppliers: "",
    supplierContact: "", // 供货商专属的联系方式输入
    buyers: "",
    inspectors: "",
    keepers: "",
    outHandlers: "",
    outRecipients: "",
    sensoryOptions: "",
    shelfLifeOptions: ""
  });

  const dict = LedgerService.getHelperDict();

  /**
   * @description 一键添加项并保存
   */
  const handleAddItem = (key: keyof typeof inputs) => {
    if (key === "supplierContact") return;
    
    let val = inputs[key].trim();
    if (!val) return;

    if (key === "suppliers") {
      const contact = inputs.supplierContact.trim();
      val = contact ? `${val}|${contact}` : val;
    }

    // 防止同名重复 (供货商按名称去重)
    const currentList = dict[key] || [];
    const isDuplicate = currentList.some(item => {
      if (key === "suppliers") {
        return item.split("|")[0] === val.split("|")[0];
      }
      return item === val;
    });

    if (isDuplicate) {
      alert("该项目已存在，请勿重复添加！");
      return;
    }

    const updated = {
      ...dict,
      [key]: [...currentList, val]
    };
    LedgerService.updateHelperDict(updated);
    
    // 清空对应输入框并触发重绘
    setInputs(prev => ({ ...prev, [key]: "", ...(key === "suppliers" ? { supplierContact: "" } : {}) }));
    setTick(t => t + 1);
  };

  /**
   * @description 一键删除项并保存
   */
  const handleDeleteItem = (key: keyof typeof inputs, itemVal: string) => {
    const currentList = dict[key] || [];
    const updated = {
      ...dict,
      [key]: currentList.filter(v => v !== itemVal)
    };
    LedgerService.updateHelperDict(updated);
    setTick(t => t + 1);
  };

  // --- 6 大常备配置列表描述映射 ---
  const CONFIG_ITEMS = [
    {
      key: "suppliers" as const,
      title: "供货商及地址",
      emoji: "🚚",
      placeholder: "名称 (例: 绿野蔬菜)",
      colorClass: "border-t-sky-500 bg-sky-50/10 text-sky-800"
    },
    {
      key: "buyers" as const,
      title: "采购员",
      emoji: "🛒",
      placeholder: "例如: 张采购",
      colorClass: "border-t-emerald-500 bg-emerald-50/10 text-emerald-800"
    },
    {
      key: "inspectors" as const,
      title: "检验员",
      emoji: "🔍",
      placeholder: "例如: 王检验",
      colorClass: "border-t-amber-500 bg-amber-50/10 text-amber-800"
    },
    {
      key: "keepers" as const,
      title: "保管员",
      emoji: "🔑",
      placeholder: "例如: 李保管",
      colorClass: "border-t-indigo-500 bg-indigo-50/10 text-indigo-800"
    },
    {
      key: "outHandlers" as const,
      title: "出库人",
      emoji: "📤",
      placeholder: "例如: 吴发料",
      colorClass: "border-t-violet-500 bg-violet-50/10 text-violet-800"
    },
    {
      key: "outRecipients" as const,
      title: "接收人",
      emoji: "📥",
      placeholder: "例如: 赵领料",
      colorClass: "border-t-rose-500 bg-rose-50/10 text-rose-800"
    },
    {
      key: "sensoryOptions" as const,
      title: "感官性状候选项",
      emoji: "🔬",
      placeholder: "例如: 新鲜",
      colorClass: "border-t-lime-500 bg-lime-50/10 text-lime-800"
    },
    {
      key: "shelfLifeOptions" as const,
      title: "保质期候选项",
      emoji: "⏳",
      placeholder: "例如: 3个月",
      colorClass: "border-t-orange-500 bg-orange-50/10 text-orange-800"
    }
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      {/* 顶部简易说明横幅 */}
      <section className="bg-white rounded-xl shadow-xs border border-slate-200 p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5 flex-wrap">
            <ShieldCheck className="text-teal-600 shrink-0" size={16} />
            台账常用人员与供货商字典库 (Ledger Helper Dictionary)
          </h3>
          <p className="text-[11px] text-slate-500">
            在此处录入供货商名称、采购员、检验员等名单后，台账数据录入界面对应的文本输入框将自动升级为下拉菜单，大幅提升填报规范性与效率；
            "感官性状候选项""保质期候选项"两栏则用于自定义台账录入界面里对应下拉框可选的内容。
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] bg-slate-100 px-3 py-1.5 rounded-lg text-slate-600 shrink-0 select-none">
          <HelpCircle size={12} className="text-slate-400 shrink-0" />
          <span>输入完成后按回车(Enter)即可快速新增</span>
        </div>
      </section>

      {/* 六大列表网格布局 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {CONFIG_ITEMS.map((config) => {
          const list = dict[config.key] || [];
          return (
            <div 
              key={config.key} 
              className={`bg-white rounded-xl shadow-xs border-t-4 border-x border-b border-slate-200 overflow-hidden flex flex-col h-[320px] transition-all hover:shadow-sm ${config.colorClass.split(" ")[0]}`}
            >
              {/* 卡片头部 */}
              <div className={`p-4 border-b border-slate-150 flex items-center justify-between ${config.colorClass.split(" ").slice(1).join(" ")}`}>
                <div className="flex items-center space-x-2">
                  <span className="text-lg select-none">{config.emoji}</span>
                  <span className="text-xs font-black">{config.title}</span>
                </div>
                <span className="text-[10px] font-mono font-bold bg-white border border-slate-200 text-slate-500 px-2 py-0.5 rounded-full shadow-2xs">
                  {list.length} 项记录
                </span>
              </div>

              {/* 输入区域 */}
              <div className="p-3 border-b border-slate-100 bg-slate-50/50">
                {config.key === "suppliers" ? (
                  <div className="flex flex-col space-y-2">
                    <input
                      type="text"
                      value={inputs[config.key]}
                      onChange={(e) => setInputs(prev => ({ ...prev, [config.key]: e.target.value }))}
                      placeholder={config.placeholder}
                      className="w-full bg-white border border-slate-250 px-2.5 py-1.5 rounded-lg text-xs outline-none focus:border-teal-500 placeholder-slate-400"
                    />
                    <div className="flex items-center space-x-1.5">
                      <input
                        type="text"
                        value={inputs.supplierContact}
                        onChange={(e) => setInputs(prev => ({ ...prev, supplierContact: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleAddItem(config.key);
                          }
                        }}
                        placeholder="联系方式(电话等)"
                        className="flex-1 bg-white border border-slate-250 px-2.5 py-1.5 rounded-lg text-xs outline-none focus:border-teal-500 placeholder-slate-400"
                      />
                      <button
                        type="button"
                        onClick={() => handleAddItem(config.key)}
                        className="p-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded-lg cursor-pointer transition-all shadow-xs shrink-0 flex items-center justify-center"
                        title="添加新项"
                      >
                        <Plus size={15} />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center space-x-1.5">
                    <input
                      type="text"
                      value={inputs[config.key]}
                      onChange={(e) => setInputs(prev => ({ ...prev, [config.key]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleAddItem(config.key);
                        }
                      }}
                      placeholder={config.placeholder}
                      className="flex-1 bg-white border border-slate-250 px-2.5 py-1.5 rounded-lg text-xs outline-none focus:border-teal-500 placeholder-slate-400"
                    />
                    <button
                      type="button"
                      onClick={() => handleAddItem(config.key)}
                      className="p-1.5 bg-teal-600 hover:bg-teal-700 text-white rounded-lg cursor-pointer transition-all shadow-xs shrink-0 flex items-center justify-center"
                      title="添加新项"
                    >
                      <Plus size={15} />
                    </button>
                  </div>
                )}
              </div>

              {/* 列表展示区 */}
              <div className="flex-1 overflow-y-auto scrollbar-thin p-3 divide-y divide-slate-100">
                {list.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-[11px] text-slate-400 italic select-none">
                    暂未录入任何名单
                  </div>
                ) : (
                  list.map((item, idx) => {
                    let displayName = item;
                    let contactInfo = "";
                    if (config.key === "suppliers" && item.includes("|")) {
                      const parts = item.split("|");
                      displayName = parts[0];
                      contactInfo = parts[1] || "";
                    }
                    return (
                      <div key={idx} className="flex items-center justify-between py-2 text-xs group hover:bg-slate-50 px-1 rounded transition-colors">
                        <div className="flex flex-col pr-2 overflow-hidden">
                          <span className="text-slate-700 font-medium truncate" title={displayName}>
                            {displayName}
                          </span>
                          {contactInfo && (
                            <span className="text-[10px] text-slate-400 truncate" title={contactInfo}>
                              联系方式: {contactInfo}
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => handleDeleteItem(config.key, item)}
                          className="text-slate-350 hover:text-rose-600 cursor-pointer p-1 rounded hover:bg-rose-50 transition-colors shrink-0"
                          title={`删除 ${displayName}`}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
