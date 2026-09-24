<template>
  <div class="sup-grid">
    <div class="ov-col">
      <!-- MCP 服务状态 -->
      <div class="sect">
        <div class="sect-head"><span class="sq"></span><h2 class="stitle">MCP 服务状态</h2><span class="sect-en">MCP Status</span><div class="sright"><span class="cap">{{ mcpEnabled ? 'stdio 随客户端启动' : '已停用 · 工具调用将拒绝' }}</span><button class="switch" role="switch" :aria-checked="mcpEnabled ? 'true' : 'false'" aria-label="MCP 服务总闸" :disabled="mcpBusy" @click="toggleMcp"></button></div></div>
        <div class="kvgrid" style="padding:12px 14px">
          <span class="k">服务名</span><span class="mono">agentfeed-knowledge</span>
          <span class="k">版本</span><span class="mono">0.1.0</span>
          <span class="k">传输</span><span>stdio（不暴露 HTTP 端口）</span>
          <span class="k">数据目录</span><span class="mono">./server/data</span>
          <span class="k">监听</span><span>仅本机 127.0.0.1</span>
          <span class="k">累计发车</span><span class="mono">{{ mcp.total }} 次（本周 {{ mcp.week }} 次）</span>
        </div>
      </div>

      <!-- 工具发车统计 -->
      <div class="sect">
        <div class="sect-head"><span class="sq"></span><h2 class="stitle">工具发车统计</h2><span class="sect-en">Tool Dispatch</span><div class="sright"><span class="cap mono">本周 {{ mcp.week }} 次</span></div></div>
        <table class="rtable">
          <thead><tr><th>工具</th><th>调用次数</th><th>最近调用</th><th>占比</th></tr></thead>
          <tbody>
            <tr v-for="t in mcp.byTool" :key="t.n">
              <td class="c-main"><b class="mono">{{ t.n }}</b></td>
              <td class="c-dim" data-l="调用次数"><span class="cv">{{ t.calls }} 次</span></td>
              <td class="c-dim" data-l="最近调用"><span class="cv">{{ fmtTime(t.last) }}</span></td>
              <td data-l="占比"><span class="cv">
                <span class="bar-mini">
                  <span class="bar-track"><span class="bar-fill" :style="{ width: toolPct(t.calls) + '%' }"></span></span>
                  <span class="mono" style="font-size:11.5px">{{ toolPct(t.calls) }}%</span>
                </span>
              </span></td>
            </tr>
            <tr v-if="!(mcp.byTool || []).length">
              <td colspan="4" style="text-align:center;padding:18px">
                <span class="cap">暂无调用记录 · 在 AI 客户端挂载本服务并调用工具后，这里会显示发车统计。</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="ov-col">
      <!-- 工具清单 -->
      <div class="sect">
        <div class="sect-head"><span class="sq"></span><h2 class="stitle">工具清单（{{ TOOLS.length }} 个）</h2><span class="sect-en">Tool Catalog</span><div class="sright"><span class="cap">供 AI 客户端挂载调用</span></div></div>
        <div class="tools">
          <div v-for="t in TOOLS" :key="t.n" class="tool">
            <span class="tn">{{ t.n }}</span>
            <span class="td">{{ t.d }}</span>
          </div>
        </div>
      </div>

      <!-- 挂载配置：Tab = 常规客户端 + Agent 目录中本机检测到的 agent，形态按客户端区分 -->
      <div class="sect">
        <div class="sect-head"><span class="sq"></span><h2 class="stitle">客户端挂载配置</h2><span class="sect-en">Client Config</span><div class="sright"><span class="cap">形态按客户端区分 · 来自 Agent 目录检测</span></div></div>
        <div style="padding:12px 14px 14px">
          <div class="tabs" style="flex-wrap:wrap;border-bottom:1px solid var(--ink)">
            <button v-for="c in clientTabs" :key="c" class="tab" :class="{ on: tab === c }" @click="tab = c">{{ c }}</button>
          </div>
          <pre class="codeblock">{{ configText }}</pre>
          <div class="codebar">
            <span class="supply-note">{{ configHint }}</span>
            <span style="margin-left:auto"><button class="btn sm" @click="copyConfig"><Icon name="copy" :size="14" /> 复制配置</button></span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Agent 供给面板：MCP 状态 / 工具统计 / 挂载配置（Supply.vue 拆分，~230 行独立内聚域）
import { computed, onMounted, ref } from 'vue'
import Icon from '../Icon.vue'
import { useUiStore } from '../../stores/useUiStore'
import { api } from '../../api'
import { fmtTime, copyToClipboard } from '../../utils/format'

const ui = useUiStore()

const mcp = ref<any>({ week: 0, total: 0, byTool: [] })
const mcpEnabled = ref(true)
const mcpBusy = ref(false)
const tab = ref('Claude Desktop')

// Agent 目录（/api/scan/agents）同源：本机检测到的 agent 也进挂载配置 Tab（KimiCode/CodexCLI 等）
const agentClients = ref<any[]>([])
const clientTabs = computed(() => ['Claude Desktop', ...agentClients.value.filter(a => a.exists).map(a => a.name)])

/** 通用 Stdio 服务定义（mcpServers 形态客户端共用） */
const REPO_SERVER = '<AgentFeed 仓库路径>/server'
const SERVER_DEF = { command: 'npm', args: ['run', 'mcp'], cwd: REPO_SERVER }
function mcpServersJson(): string {
  return JSON.stringify({ mcpServers: { 'agentfeed-knowledge': SERVER_DEF } }, null, 2)
}

/** 按客户端区分配置形态：JSON 键位/文件路径各异，CodexCLI 是 TOML，OpenCode 是 command 数组 */
const CLIENT_CONFIGS: Record<string, { text: string; hint: string }> = {
  'Claude Desktop': { text: mcpServersJson(), hint: '粘贴到 claude_desktop_config.json（macOS：~/Library/Application Support/Claude/）后重启应用' },
  ClaudeCode: { text: mcpServersJson(), hint: '合并进 ~/.claude.json 顶层的 mcpServers 键（或项目根 .mcp.json）后重启会话' },
  Trae: { text: mcpServersJson(), hint: '粘贴到 Trae 的 MCP 配置（mcp.json）后重启客户端' },
  Cursor: { text: mcpServersJson(), hint: '粘贴到 ~/.cursor/mcp.json 后重启编辑器' },
  GeminiCLI: { text: mcpServersJson(), hint: '合并进 ~/.gemini/settings.json 的 mcpServers 键后重启 CLI' },
  CodexCLI: {
    text: `[mcp_servers.agentfeed-knowledge]\ncommand = "npm"\nargs = ["--prefix", "${REPO_SERVER}", "run", "mcp"]`,
    hint: '合并进 ~/.codex/config.toml（TOML 格式；经 --prefix 指定仓库路径）后重启 CLI'
  },
  OpenCode: {
    text: JSON.stringify({ mcp: { 'agentfeed-knowledge': { type: 'local', command: ['npm', '--prefix', REPO_SERVER, 'run', 'mcp'] } } }, null, 2),
    hint: '合并进 ~/.config/opencode/opencode.json 的 mcp 键（command 为数组形态）后重启'
  }
}
/** 未收录形态的 agent 走通用 mcpServers JSON（Stdio 三键在各 OpenAI 兼容客户端最通用） */
const fallbackConfig = (name: string) => ({ text: mcpServersJson(), hint: `在 ${name} 客户端的 MCP 设置（Stdio 形态）中添加以下配置` })
const agentConfig = computed(() => CLIENT_CONFIGS[tab.value] || fallbackConfig(tab.value))
const configText = computed(() => agentConfig.value.text)
const configHint = computed(() => agentConfig.value.hint)

const TOOLS = [
  { n: 'search_knowledge', d: '按关键词 / 领域 / 标签检索资料库，返回文件与词条摘要' },
  { n: 'read_entry', d: '读取某个文件对应的 wiki 词条（摘要 / 要点 / 实体 / 关系）' },
  { n: 'get_source', d: '获取源文件路径与元信息，用于回链定位本地原文' },
  { n: 'list_domains', d: '列出知识领域树及各领域文件计数' },
  { n: 'list_agents', d: '列出资料来源 agent 及文件数分布' },
  { n: 'list_tags', d: '列出全部标签及使用情况' },
  { n: 'stats', d: '返回知识库总体统计（文件 / 词条 / 队列 / 调用）' }
]

// 占比分母 = 全部工具调用总数（曾误用最大值：榜首恒 100%，各行占比和超 100%）
const totalToolCalls = computed(() => (mcp.value.byTool || []).reduce((s: number, t: any) => s + (t.calls || 0), 0))
const toolPct = (calls: number) => totalToolCalls.value ? Math.round((calls / totalToolCalls.value) * 100) : 0

// MCP 总闸：失败回滚乐观更新
async function toggleMcp() {
  if (mcpBusy.value) return
  mcpBusy.value = true
  const next = !mcpEnabled.value
  mcpEnabled.value = next
  try {
    await api.config.set({ 'mcp.enabled': { value: next } })
  } catch {
    mcpEnabled.value = !next
  } finally {
    mcpBusy.value = false
  }
}

async function refresh() {
  mcp.value = await api.stats.mcp()
  api.config.get().then((cfg: any) => {
    const entry = cfg?.['mcp.enabled']
    if (entry) mcpEnabled.value = entry.value !== false
  }).catch(() => {})
  api.scan.agents().then((r: any) => { agentClients.value = Array.isArray(r) ? r : [] }).catch(() => {})
}

async function copyConfig() {
  const ok = await copyToClipboard(configText.value)
  ui.toast(ok ? '配置已复制，粘贴到对应客户端即可' : '复制失败，请手动选择复制')
}

onMounted(refresh)

defineExpose({ refresh })
</script>
