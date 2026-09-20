import { McpServer } from '@modelcontextprotocol/sdk/server/mcp'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio'
import { z } from 'zod'
import fs from 'fs/promises'
import path from 'path'
import { getDb } from './db.js'
import { searchKnowledgeCore } from './knowledge.js'

const DATA_DIR = path.join(process.cwd(), 'data')
const WIKI_DIR = path.join(DATA_DIR, 'wiki', 'entries')

const server = new McpServer(
  { name: 'agentfeed-knowledge', version: '0.1.0' },
  { capabilities: { logging: {} } }
)

/** MCP 总闸：关闭后所有工具调用拒绝响应（config 表 mcp.enabled，缺省/异常视为开启） */
async function isMcpEnabled(): Promise<boolean> {
  try {
    const db = await getDb()
    const row = await (await db.prepare("SELECT value FROM config WHERE key = 'mcp.enabled'")).get() as any
    return row ? String(row.value) !== 'false' : true
  } catch { return true }
}

function disabledResponse() {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'MCP 服务已停用（总闸关闭），可在看板发车区重新开启' }) }] }
}

/** 工具调用落库（发车统计；args 摘要截断 200 字符，供盘点 agent 实际查询内容） */
async function logToolCall(tool: string, args?: unknown) {
  try {
    const db = await getDb()
    let argsSummary: string | null = null
    if (args !== undefined) {
      const full = JSON.stringify(args)
      argsSummary = full.length > 200 ? full.slice(0, 200) : full
    }
    await (await db.prepare('INSERT INTO mcp_call_logs (tool, client, args) VALUES (?, ?, ?)')).run([tool, 'unknown', argsSummary])
  } catch { /* 日志失败不影响工具调用 */ }
}

const searchKnowledge = server.registerTool(
  'search_knowledge',
  {
    title: 'Search Knowledge',
    description: 'Search wiki entries and files by query, domain, tags, or agent; optional since/until (ISO date, inclusive) filter by file mtime',
    inputSchema: z.object({
      query: z.string().describe('Search query for title/summary/path'),
      domain: z.string().optional().describe('Domain name filter'),
      tags: z.array(z.string()).optional().describe('Tag names filter'),
      agent: z.string().optional().describe('Source agent filter'),
      limit: z.number().int().optional().describe('Max results'),
      since: z.string().optional().describe('ISO 8601 date lower bound on file mtime (inclusive)'),
      until: z.string().optional().describe('ISO 8601 date upper bound on file mtime (inclusive)'),
    }),
  },
  async (args, extra) => {
    if (!(await isMcpEnabled())) return disabledResponse()
    await logToolCall('search_knowledge', args)
    const db = await getDb()
    const rows = await searchKnowledgeCore(db, args)
    const results = rows.map((r) => {
      const entryPath = path.join(WIKI_DIR, String(r.id), 'entry.md')
      return {
        id: r.id,
        title: r.title,
        summary: r.summary,
        path: r.path,
        source_agent: r.source_agent,
        domain: r.domain_name,
        file_mtime: r.file_mtime,
        wiki_entry_path: entryPath,
      }
    })
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] }
  }
)

server.registerTool(
  'read_entry',
  {
    title: 'Read Wiki Entry',
    description: 'Read wiki entry markdown by file id',
    inputSchema: z.object({
      id: z.number().int().describe('File id'),
    }),
  },
  async (args) => {
    if (!(await isMcpEnabled())) return disabledResponse()
    await logToolCall('read_entry', args)
    const db = await getDb()
    const stmt = await db.prepare('SELECT path, title FROM files WHERE id = ?')
    const row = await stmt.get(args.id) as any
    if (!row) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'file not found' }) }] }
    }
    const entryPath = path.join(WIKI_DIR, String(args.id), 'entry.md')
    try {
      const text = await fs.readFile(entryPath, 'utf8')
      return { content: [{ type: 'text', text }] }
    } catch (e) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'entry not found', path: row.path, title: row.title }) }] }
    }
  }
)

server.registerTool(
  'get_source',
  {
    title: 'Get Source Path',
    description: 'Get original source file absolute path by file id',
    inputSchema: z.object({
      id: z.number().int().describe('File id'),
    }),
  },
  async (args) => {
    if (!(await isMcpEnabled())) return disabledResponse()
    await logToolCall('get_source', args)
    const db = await getDb()
    const stmt = await db.prepare('SELECT path FROM files WHERE id = ?')
    const row = await stmt.get(args.id) as any
    if (!row) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'file not found' }) }] }
    }
    return { content: [{ type: 'text', text: row.path }] }
  }
)

server.registerTool(
  'list_domains',
  {
    title: 'List Domains',
    description: 'List all domains',
  },
  async () => {
    if (!(await isMcpEnabled())) return disabledResponse()
    await logToolCall('list_domains')
    const db = await getDb()
    const rows = await (await db.prepare('SELECT name, parent_id FROM domains ORDER BY sort, name')).all() as any[]
    const simple = rows.map((r) => ({ name: r.name, parent_id: r.parent_id }))
    return { content: [{ type: 'text', text: JSON.stringify(simple, null, 2) }] }
  }
)

server.registerTool(
  'list_agents',
  {
    title: 'List Agents',
    description: 'List distinct source agents',
  },
  async () => {
    if (!(await isMcpEnabled())) return disabledResponse()
    await logToolCall('list_agents')
    const db = await getDb()
    const rows = await (await db.prepare('SELECT DISTINCT source_agent FROM files WHERE status = ?')).all('active') as any[]
    const agents = rows.map((r) => r.source_agent).filter(Boolean)
    return { content: [{ type: 'text', text: JSON.stringify(agents, null, 2) }] }
  }
)

server.registerTool(
  'list_tags',
  {
    title: 'List Tags',
    description: 'List all tags',
  },
  async () => {
    if (!(await isMcpEnabled())) return disabledResponse()
    await logToolCall('list_tags')
    const db = await getDb()
    const rows = await (await db.prepare('SELECT name, color FROM tags ORDER BY name')).all() as any[]
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] }
  }
)

server.registerTool(
  'stats',
  {
    title: 'Stats',
    description: 'Get basic knowledge stats',
  },
  async () => {
    if (!(await isMcpEnabled())) return disabledResponse()
    await logToolCall('stats')
    const db = await getDb()
    const filesRow = await (await db.prepare('SELECT COUNT(*) as cnt FROM files WHERE status = ?')).get('active') as any
    const wikiRow = await (await db.prepare('SELECT COUNT(*) as cnt FROM wiki_entries_meta')).get() as any
    const agentsRow = await (await db.prepare('SELECT COUNT(DISTINCT source_agent) as cnt FROM files WHERE status = ?')).all('active') as any[]
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              files: filesRow.cnt,
              wiki_entries: wikiRow.cnt,
              agents: agentsRow.length,
            },
            null,
            2
          ),
        },
      ],
    }
  }
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error('MCP server error:', error)
  process.exit(1)
})
