/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @description 账期 / 日期区间切换时的"加载中 → 阻断操作 → 成功放行 / 失败可重试"控制器。
 *
 * 背景：系统对台账逐日流水按月懒加载，切换查看账期会触发一次向服务器补拉该月区间的请求（SyncHelper.refreshNow）。
 * 这个请求以前是「fire-and-forget + console.error」：慢或失败时用户毫无感知，还可能对着一份不完整的数据继续操作
 * （合计汇总缺项、台账缺行）。本 Hook 把这段补拉过程显式化：
 *   - 依赖变化（首次建立基线不算）→ loading=true，调用方据此渲染遮罩、拦截交互；
 *   - 依赖 SyncHelper 的 strict 模式，真实的网络失败 / 5xx 会被捕获为 error（遮罩保持），retry() 可重试；
 *   - 用递增的 seq 忽略过期响应，避免快速连续切月时旧请求的结果错误地收掉最新一次的 loading；
 *   - minVisibleMs：本地/缓存命中时补拉可能只要几毫秒，遮罩一闪而过等于没有。成功分支强制让遮罩至少停留
 *     minVisibleMs 毫秒，用户才看得到"切换 → 加载 → 完成"这个过程；真正慢的请求则按实际耗时显示。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { DependencyList } from "react";
import { SyncHelper } from "../services/syncHelper.ts";
import { LogBroker } from "../utils.ts";

/** useRangeLoad 返回值 */
export interface RangeLoadState {
  /** 正在补拉该区间数据：调用方应据此渲染阻断式遮罩 */
  loading: boolean;
  /** 补拉失败的提示文案（非 null 时应保持遮罩并提供重试入口） */
  error: string | null;
  /** 手动重试上一次失败的补拉 */
  retry: () => void;
}

/** useRangeLoad 选项 */
export interface RangeLoadOptions {
  /** 成功分支下遮罩的最短可见时长（毫秒），默认 500；设为 0 则拉多久显示多久 */
  minVisibleMs?: number;
}

/**
 * @description 见文件顶部说明。
 * @param {string} start 本视图需要的数据起始日期 (YYYY-MM-DD)
 * @param {string} end 本视图需要的数据结束日期 (YYYY-MM-DD)
 * @param {DependencyList} deps 触发补拉的依赖（如 [selectedYear, selectedMonth]）；首次仅建立基线不补拉，之后每次变化都补拉
 * @param {RangeLoadOptions} [options]
 * @returns {RangeLoadState}
 */
export function useRangeLoad(
  start: string,
  end: string,
  deps: DependencyList,
  options?: RangeLoadOptions
): RangeLoadState {
  const minVisibleMs = options?.minVisibleMs ?? 500;

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  /** 递增序号：只有最新一次补拉的结果才允许改动 loading/error，旧响应直接丢弃 */
  const seqRef = useRef<number>(0);
  /** 上一次见到的依赖值快照。null=尚未建立基线；靠"值比对"而非"是否首帧"来判断，天然免疫 StrictMode 的双调用 */
  const prevDepsRef = useRef<DependencyList | null>(null);
  /** run() 用最新的区间值 / 最短可见时长，避免把它们放进 useCallback 依赖导致其频繁重建 */
  const paramsRef = useRef<{ start: string; end: string; minVisibleMs: number }>({ start, end, minVisibleMs });
  paramsRef.current = { start, end, minVisibleMs };
  /** 成功分支收起遮罩的延时器，卸载/新一轮补拉时清掉 */
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(() => {
    const seq = ++seqRef.current;
    const { start: s, end: e, minVisibleMs: minMs } = paramsRef.current;
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    const startedAt = Date.now();
    setLoading(true);
    setError(null);

    SyncHelper.refreshNow(s, e, { strict: true })
      .then(() => {
        if (seqRef.current !== seq) return;
        const wait = Math.max(0, minMs - (Date.now() - startedAt));
        hideTimerRef.current = setTimeout(() => {
          hideTimerRef.current = null;
          if (seqRef.current === seq) setLoading(false);
        }, wait);
      })
      .catch((err: unknown) => {
        if (seqRef.current !== seq) return;
        // 失败立即亮出错误态（遮罩保持），不走最短可见时长
        setLoading(false);
        const msg = err instanceof Error ? err.message : String(err);
        setError(`账期数据加载失败：${msg}。当前数据可能不完整，请重试。`);
        LogBroker.publish("ERROR", "RangeLoad", `切换账期补拉失败 [${s} ~ ${e}]: ${msg}`);
      });
  }, []);

  useEffect(() => {
    const prev = prevDepsRef.current;
    const changed =
      prev !== null &&
      (prev.length !== deps.length || deps.some((d, i) => !Object.is(d, prev[i])));
    prevDepsRef.current = deps;
    if (changed) run();
    // 依赖由调用方通过 deps 显式提供（start/end 均由这些依赖派生）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // 卸载时清掉悬空的收起延时器
  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  return { loading, error, retry: run };
}
