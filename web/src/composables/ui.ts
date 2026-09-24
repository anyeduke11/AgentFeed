// 组合函数（Vue composables）：从视图重复逻辑中提取的状态ful复用单元
// （vercel-composition-patterns · state/patterns：把逻辑收进可组合单元，视图只消费接口）。
import { computed, watch, type WatchSource } from 'vue'
import { copyToClipboard } from '../utils/format'
import { useUiStore } from '../stores/useUiStore'

/**
 * 剪贴板复制 + toast 反馈：Entry/FileDrawer/Supply 四处重复实现的统一收口。
 * 用法：const { copy } = useCopyToClipboard(); await copy(text, '已复制路径')
 */
export function useCopyToClipboard() {
  const ui = useUiStore()
  async function copy(text: string, okMsg = '已复制到剪贴板', failMsg = '复制受限，请手动选择文本') {
    const ok = await copyToClipboard(text)
    ui.toast(ok ? okMsg : failMsg)
    return ok
  }
  return { copy }
}

/**
 * 输入防抖 watch：Entry(350ms)/Library(350ms)/Domains(300ms) 三处手写 kwTimer 的收口。
 * 组件卸载时自动清理定时器（旧实现存在卸载后定时器仍触发的隐患）。
 * 用法：useDebouncedWatch(() => kw.value, reload, 350)
 */
export function useDebouncedWatch(source: WatchSource<string>, fn: () => void, delay = 350) {
  let timer: ReturnType<typeof setTimeout> | null = null
  const stop = watch(source, () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(fn, delay)
  })
  const flush = () => { if (timer) { clearTimeout(timer); timer = null } }
  if (typeof window !== 'undefined') window.addEventListener('unload', flush)
  return { stop, flush }
}

/**
 * LLM 调用趋势图（按模型堆叠柱）共享逻辑：Overview 与 Pipeline 的逐行重复收口。
 * 同一份 api.stats.dashboard 数据、同一调色板——单点维护防止两视图漂移。
 */
export const MODEL_COLORS = ['#2456A6', '#B4651A', '#2E7D4F', '#7B4BA6', '#B3402A', '#1F7A8C', '#8C6D1F', '#5A5A5A']

export function useTrendChart(trend: () => { labels: string[]; vals: number[]; models?: any[] }) {
  const trendModels = computed<any[]>(() => trend().models || [])
  function trendH(v: number): number {
    const max = Math.max(1, ...(trend().vals || []))
    return Math.max(4, Math.round((v / max) * 100))
  }
  function modelColor(i: number): string {
    return MODEL_COLORS[i % MODEL_COLORS.length]
  }
  function segPct(m: any, i: number): number {
    const total = trend().vals?.[i] || 0
    return total > 0 ? ((m.vals?.[i] || 0) / total) * 100 : 0
  }
  return { trendModels, trendH, modelColor, segPct }
}

/** llm_state → 文案/色点 映射：Library(STATE_MAP) 与 FileDrawer(stLabel/stColor) 的收口（色值与设计令牌一一对应） */
export const LLM_STATE_MAP: Record<string, { t: string; dot: string; color: string }> = {
  done: { t: '已蒸馏', dot: 'dot-done', color: 'var(--ok)' },
  running: { t: '编目中', dot: 'dot-run', color: 'var(--run)' },
  pending: { t: '待处理', dot: 'dot-pend', color: 'var(--wait)' },
  failed: { t: '失败', dot: 'dot-fail', color: 'var(--fail)' },
  skipped: { t: '已跳过', dot: 'dot-skip', color: 'var(--skip)' }
}
export const llmStateText = (s: string) => LLM_STATE_MAP[s]?.t || s
export const llmStateDot = (s: string) => LLM_STATE_MAP[s]?.dot || 'dot-pend'
export const llmStateColor = (s: string) => LLM_STATE_MAP[s]?.color || 'var(--wait)'
