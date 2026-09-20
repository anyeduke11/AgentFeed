import os from 'os'
import path from 'path'
import fs from 'fs'
import { normalizeRootPath } from './gate.js'

/** 国内外常见 agent 智能体的默认数据目录（home 下候选，按顺序取第一个存在的） */
export interface KnownAgent {
  name: string
  candidates: string[]
}

export const KNOWN_AGENTS: KnownAgent[] = [
  { name: 'ClaudeCode', candidates: ['.claude'] },
  { name: 'OpenCode', candidates: ['.opencode', '.config/opencode'] },
  { name: 'OpenClaw', candidates: ['.openclaw'] },
  { name: 'AutoClaw', candidates: ['.openclaw-autoclaw', '.autoclaw'] },
  { name: 'Hermes', candidates: ['.hermes'] },
  { name: 'Trae', candidates: ['.trae', '.trae-cn'] },
  { name: 'TraeWork', candidates: ['.trae-work', '.traework'] },
  { name: 'Qoder', candidates: ['.qoder', 'Documents/Qoder'] },
  { name: 'Workbuddy', candidates: ['.workbuddy'] },
  { name: 'Codebuddy', candidates: ['.codebuddy', '.codebuddycn'] },
  { name: 'Loomy', candidates: ['.loomy'] },
  { name: 'Zcode', candidates: ['.zcode'] },
  { name: 'MiniMaxCode', candidates: ['.minimax-code', '.minimaxcode'] },
  { name: 'KimiCode', candidates: ['.kimi-code', '.kimicode', '.kimi'] },
  { name: 'KimiWork', candidates: ['.kimi-work', '.kimiwork'] },
  { name: 'CodexCLI', candidates: ['.codex'] },
  { name: 'Cursor', candidates: ['.cursor'] },
  { name: 'GeminiCLI', candidates: ['.gemini'] },
  { name: 'Coze', candidates: ['.coze'] },
  { name: 'DoubaoWork', candidates: ['DoubaoWork', 'Doubao', '.doubao'] },
  { name: 'QwenWork', candidates: ['.qwenpaw', '.qwen', '.qianwen'] },
  { name: 'LingxiClaw', candidates: ['Documents/lingxi-claw', 'lingxi-claw', '.lingxi-claw'] }
]

export interface AgentDirInfo {
  name: string
  path: string
  exists: boolean
}

/** 解析各 agent 在本机的实际目录（第一个存在的候选；都不存在则取第一个候选路径） */
export function resolveAgentDirs(): AgentDirInfo[] {
  const home = os.homedir()
  return KNOWN_AGENTS.map(a => {
    let resolved = path.join(home, a.candidates[0])
    let exists = false
    for (const c of a.candidates) {
      const p = path.join(home, c)
      try {
        if (fs.statSync(p).isDirectory()) {
          resolved = p
          exists = true
          break
        }
      } catch {
        if (p === path.join(home, a.candidates[0])) resolved = p
      }
    }
    return { name: a.name, path: resolved, exists }
  })
}

/**
 * 启动/周期增量扫描的根选择口径：只剔除「本机不存在的已知 agent 目录」，
 * 其余启用根（含手工挂载的普通目录）一律保留。
 * 反例：曾用「存在的 agent 目录 ∩ 启用根」，手工根因此失去自动增量通道——
 * watcher 只覆盖运行期变化，停机期间的文件增改再没有人补齐。
 */
export function selectPeriodicRoots(enabledPaths: string[], agentDirs: AgentDirInfo[]): string[] {
  const absent = new Set(agentDirs.filter(a => !a.exists).map(a => normalizeRootPath(a.path)))
  return enabledPaths.filter(p => !absent.has(normalizeRootPath(p)))
}
