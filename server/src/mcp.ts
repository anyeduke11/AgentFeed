import { McpServer } from '@modelcontextprotocol/sdk/server/mcp'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio'
import { z } from 'zod'
import fs from 'fs/promises'
import path from 'path'
import { getDb } from './db.js'

const DATA_DIR = path.join(process.cwd(), 'data')
const WIKI_DIR = path.join(DATA_DIR, 'wiki', 'entries')

const server = new McpServer(
  { name: 'agentfeed-knowledge', version: '0.1.0' },
  { capabilities: { logging: {} } }
)

/** 工具调用落库（发车统计） */
async function logToolCall(tool: string, client = 'unknown') {
  try {
    const db = await getDb()
    const escapedTool = String(tool).replace(/'/g, "''")
    const escapedClient = String(client).replace(/'/g, "''")
    await db.exec(`INSERT INTO mcp_call_logs (tool, client) VALUES ('${escapedTool}', '${escapedClient}')`)
  } catch { /* 日志失败不影响工具调用 */ }
}

const searchKnowledge = server.registerTool(
  'search_knowledge',
  {
    title: 'Search Knowledge',
    description: 'Search wiki entries and files by query, domain, tags, or agent',
    inputSchema: z.object({
      query: z.string().describe('Search query for title/summary/path'),
      domain: z.string().optional().describe('Domain name filter'),
      tags: z.array(z.string()).optional().describe('Tag names filter'),
      agent: z.string().optional().describe('Source agent filter'),
      limit: z.number().int().optional().describe('Max results'),
    }),
  },
  async (args, extra) => {
    await logToolCall('search_knowledge')
    const db = await getDb()
    const limit = args.limit ?? 20
    let sql = `SELECT f.id, f.title, f.summary, f.path, f.source_agent, f.file_mtime, d.name as domain_name
               FROM files f
               LEFT JOIN domains d ON f.domain_id = d.id
               WHERE f.status = 'active'`
    const params: any[] = []
    if (args.query) {
      sql += ` AND (f.title LIKE ? OR f.summary LIKE ? OR f.path LIKE ?)`
      params.push(`%${args.query}%`, `%${args.query}%`, `%${args.query}%`)
    }
    if (args.domain) {
      sql += ` AND d.name = ?`
      params.push(args.domain)
    }
    if (args.agent) {
      sql += ` AND f.source_agent = ?`
      params.push(args.agent)
    }
    if (args.tags && args.tags.length > 0) {
      sql += ` AND f.id IN (
        SELECT ft.file_id FROM file_tags ft
        JOIN tags t ON ft.tag_id = t.id
        WHERE t.name IN (${args.tags.map(() => '?').join(',')})
      )`
      params.push(...args.tags)
    }
    sql += ` ORDER BY f.file_mtime DESC LIMIT ${limit}`
    const stmt = await db.prepare(sql)
    const rows = await stmt.all(params) as any[]
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
    await logToolCall('read_entry')
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
    await logToolCall('get_source')
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
