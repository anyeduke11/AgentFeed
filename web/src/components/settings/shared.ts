/** 设置页各 tab 共享的展示工具（跨子组件复用，避免重复定义） */

/** 服务商显示名（预设目录之外的条目回退原名） */
export const PRESET_LABELS: Record<string, string> = {
  sensenova: '商汤 SenseNova',
  agnes: 'Agnes',
  deepseek: 'DeepSeek',
  zhipu: '智谱 GLM',
  moonshot: '月之暗面 Kimi',
  qwen: '通义千问 Qwen',
  xfyun: '讯飞星火',
  ollama: 'Ollama 本地',
}

export function providerLabel(name: string) {
  return PRESET_LABELS[name] || name
}
