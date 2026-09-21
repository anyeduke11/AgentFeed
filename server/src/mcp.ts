import { McpServer } from '@modelcontextprotocol/sdk/server/mcp'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio'
import { z } from 'zod'
import fs from 'fs/promises'
import path from 'path'
import { getDb } from './db.js'
import { searchKnowledgeCore } from './knowledge.js'
import { cleanTitle, cleanSummary } from './formatter.js'
import { disabledResponse, getContextHandler, getUserContextHandler, isMcpEnabled, logToolCall } from './mcpTools.js'

const DATA_DIR = path.join(process.cwd(), 'data')
const WIKI_DIR = path.join(DATA_DIR, 'wiki', 'entries')

const server = new McpServer(
  { name: 'agentfeed-knowledge', version: '0.1.0' },
  { capabilities: { logging: {} } }
)

// 总闸/停用响应/埋点三守卫自 mcpTools.ts 迁入（v0.1.5 E2：handler 需可单测，mcp.ts 顶层 main() 有 stdio 副作用）

const searchKnowledge = server.registerTool(
  'search_knowledge',
  {
    title: 'Search Knowledge',
    description: 'Search wiki entries and files by query, domain, tags, or agent; optional since/until (ISO date, inclusive) filter by file mtime. Hybrid recall: files LIKE + wiki FTS + vector fusion with RRF (k=60)',
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
      // 混合召回下 wiki 命中可能无关联 file（id = 词条 id），此时行内自带 entry_path 真实词条路径
      const entryPath = typeof r.entry_path === 'string' && r.entry_path
        ? r.entry_path
        : path.join(WIKI_DIR, String(r.id), 'entry.md')
      return {
        id: r.id,
        // A3 双保险：searchKnowledgeCore 已清洗，这里再过一遍 formatter（幂等），
        // 兜底 wiki 词条独立映射分支等未来直连数据源的行
        title: typeof r.title === 'string' ? cleanTitle(r.title) : r.title,
        summary: typeof r.summary === 'string' ? cleanSummary(r.summary) : r.summary,
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
    description: 'Read the full distilled wiki entry (markdown) by file id. After search_knowledge returns results, call this to deep-read any promising hit — the search summary is only a teaser, the entry contains key points and detail. Takes the id field from search results.',
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
    description: 'Get the original source file absolute path by file id, for opening in your own tools. Pair it after read_entry when you need the raw artifact behind the distilled wiki entry.',
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

// E2 第 8 工具：领域开工上下文（handler 逻辑在 mcpTools.ts，便于无副作用单测）
server.registerTool(
  'getContext',
  {
    title: 'Get Domain Context',
    description: 'Get a domain overview to inject at task start: top distilled entries with key points, prioritized by quality. Call this BEFORE searching when starting work in a domain you know the name of — it gives you a map first, then use search_knowledge to drill down. Takes a domain name (see list_domains).',
    inputSchema: z.object({
      domain: z.string().describe('Domain name (from list_domains)'),
    }),
  },
  async (args) => getContextHandler(args)
)

// J3 第 9 工具：机读画像第一出口（handler 逻辑在 mcpTools.ts，便于无副作用单测）
server.registerTool(
  'get_user_context',
  {
    title: 'Get User Context',
    description: 'Get the user role profile and domain-tendency claims distilled from local reading history — use it as grounding for personalized answers or recommendations. Vetoed claims never appear. Optional domain (from list_domains) appends that domain\'s claims.',
    inputSchema: z.object({
      domain: z.string().optional().describe('Optional domain name to append domain-level claims'),
    }),
  },
  async (args) => getUserContextHandler(args)
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error('MCP server error:', error)
  process.exit(1)
})
