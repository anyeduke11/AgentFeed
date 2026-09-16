const base = '/api'

export async function getJSON<T = any>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function post(url: string, data?: any) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) }).then(r => r.json())
}
function patch(url: string, data: any) {
  return fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(r => r.json())
}
function del(url: string) {
  return fetch(url, { method: 'DELETE' }).then(r => r.json())
}

export const api = {
  files: {
    list: (params?: Record<string, string>) => {
      const qs = new URLSearchParams(params).toString()
      return getJSON<any>(`${base}/files${qs ? '?' + qs : ''}`)
    },
    open: (id: number, source?: string) => post(`${base}/files/${id}/open`, source ? { source } : undefined),
    reveal: (id: number) => post(`${base}/files/${id}/reveal`),
    update: (id: number, data: any) => patch(`${base}/files/${id}`, data),
    batchLlmTag: (fileIds: number[]) => post(`${base}/files/batch-llm-tag`, { fileIds }),
    batch: (ids: number[], action: 'delete' | 'restore' | 'domain', domain_id?: number | null) => post(`${base}/files/batch`, { ids, action, domain_id }),
    purgeOne: (id: number) => del(`${base}/files/${id}`),
    purgeDeleted: () => post(`${base}/files/purge-deleted`),
    versions: (id: number) => getJSON<any[]>(`${base}/files/${id}/versions`)
  },
  domains: {
    list: () => getJSON<any[]>(`${base}/domains`),
    create: (data: any) => post(`${base}/domains`, data),
    update: (id: number, data: any) => patch(`${base}/domains/${id}`, data),
    remove: (id: number) => del(`${base}/domains/${id}`)
  },
  tags: {
    list: (params?: Record<string, string>) => {
      const qs = new URLSearchParams(params).toString()
      return getJSON<{ items: any[]; total: number }>(`${base}/tags${qs ? '?' + qs : ''}`)
    },
    create: (data: any) => post(`${base}/tags`, data),
    update: (id: number, data: any) => patch(`${base}/tags/${id}`, data),
    merge: (id: number, into: number) => post(`${base}/tags/${id}/merge`, { into }),
    retire: (id: number) => post(`${base}/tags/${id}/retire`),
    restore: (id: number) => post(`${base}/tags/${id}/restore`),
    related: (id: number, limit = 12) => getJSON<any[]>(`${base}/tags/related?id=${id}&limit=${limit}`),
    proposals: (status = 'pending', kind?: string) => getJSON<any[]>(`${base}/tags/proposals?status=${status}${kind ? '&kind=' + kind : ''}`),
    proposalAccept: (id: number) => post(`${base}/tags/proposals/${id}/accept`),
    proposalReject: (id: number) => post(`${base}/tags/proposals/${id}/reject`),
    scanNormalize: () => post(`${base}/tags/scan/normalize`),
    scanSemantic: (batchSize = 400) => post(`${base}/tags/scan/semantic`, { batchSize }),
    scanLevel: (maxCount = 2, batchSize = 400) => post(`${base}/tags/scan/level`, { maxCount, batchSize }),
    scanStatus: () => getJSON<any>(`${base}/tags/scan/status`),
    stats: () => getJSON<any>(`${base}/tags/stats`),
    exportUrl: (format: 'json' | 'csv' = 'json') => `${base}/tags/export?format=${format}`,
    import: (tags: any[]) => post(`${base}/tags/import`, { tags }),
    ops: (limit = 100) => getJSON<any[]>(`${base}/tags/ops?limit=${limit}`)
  },
  scan: {
    roots: () => getJSON<any[]>(`${base}/scan/roots`),
    agents: () => getJSON<any[]>(`${base}/scan/agents`),
    addRoot: (path: string) => post(`${base}/scan/roots`, { path }),
    updateRoot: (id: number, enabled: boolean) => patch(`${base}/scan/roots/${id}`, { enabled }),
    removeRoot: (id: number) => del(`${base}/scan/roots/${id}`),
    rescanRoot: (id: number) => post(`${base}/scan/roots/${id}/rescan`),
    status: () => getJSON<any>(`${base}/scan/status`),
    run: (roots?: string[], full?: boolean) => post(`${base}/scan/run`, { roots, full })
  },
  config: {
    get: () => getJSON<Record<string, any>>(`${base}/config`),
    set: (data: Record<string, { value: any }>) => patch(`${base}/config`, data)
  },
  stats: {
    overview: () => getJSON<any>(`${base}/stats/overview`),
    llm: () => getJSON<any>(`${base}/stats/llm`),
    dashboard: () => getJSON<any>(`${base}/stats/dashboard`),
    board: () => getJSON<any>(`${base}/stats/board`),
    mcp: () => getJSON<any>(`${base}/stats/mcp`)
  },
  llm: {
    queue: () => getJSON<any>(`${base}/llm/queue`),
    pause: () => post(`${base}/llm/queue/pause`),
    resume: () => post(`${base}/llm/queue/resume`),
    setConcurrency: (value: number, provider?: string) => post(`${base}/llm/queue/concurrency`, { value, provider }),
    retry: (fileId: number) => post(`${base}/llm/queue/retry`, { fileId }),
    retryAll: () => post(`${base}/llm/queue/retry-all`),
    logs: (params?: Record<string, string>) => {
      const qs = new URLSearchParams({ page: '1', limit: '50', ...(params || {}) }).toString()
      return getJSON<{ items: any[]; total: number }>(`${base}/llm/logs?${qs}`)
    },
    mcpLogs: (kw = '', limit = 200) => getJSON<{ items: any[]; total: number }>(`${base}/llm/logs/mcp?kw=${encodeURIComponent(kw)}&limit=${limit}`),
    serviceLogs: (kw = '', lines = 500) => getJSON<{ items: string[]; total: number; file: string }>(`${base}/llm/logs/service?kw=${encodeURIComponent(kw)}&lines=${lines}`),
    providers: () => getJSON<any>(`${base}/llm/providers`),
    saveProviders: (payload: any) => post(`${base}/llm/providers`, payload),
    llmNodes: () => getJSON<any>(`${base}/llm/nodes`),
    llmNodeUpdate: (provider: string, model: string, patch: { enabled?: boolean; weight?: number }) => post(`${base}/llm/nodes/update`, { provider, model, ...patch }),
    llmNodeCheck: (provider?: string, model?: string) => post(`${base}/llm/nodes/check`, provider ? { provider, model } : undefined),
    saveProviderModels: (provider: string, models: string[]) => post(`${base}/llm/providers/models`, { provider, models }),
    manualTag: (fileId: number) => post(`${base}/llm/manual-tag`, { fileId }),
    ollamaModels: () => getJSON<any>(`${base}/llm/ollama/models`),
    providerModels: (name: string, creds?: { baseUrl?: string; apiKey?: string }) => post(`${base}/llm/providers/${name}/models`, creds),
    saveOllamaConfig: (payload: any) => post(`${base}/llm/ollama/config`, payload),
    embeddingsStatus: () => getJSON<any>(`${base}/llm/embeddings/status`),
    embeddingsBackfill: () => post(`${base}/llm/embeddings/backfill`),
    embeddingsSearch: (query: string, topK = 5) => post(`${base}/llm/embeddings/search`, { query, topK })
  },
  wiki: {
    list: (params?: Record<string, string>) => {
      const qs = new URLSearchParams(params).toString()
      return getJSON<any>(`${base}/wiki${qs ? '?' + qs : ''}`)
    },
    detail: (id: number) => getJSON<any>(`${base}/wiki/${id}`),
    detailImported: (metaId: number) => getJSON<any>(`${base}/wiki/imported/${metaId}`),
    importPreview: (dir: string) => post(`${base}/wiki/import/preview`, { dir }),
    importExec: (dir: string) => post(`${base}/wiki/import`, { dir })
  },
  gate: {
    validate: () => getJSON<{ masterEnabled: boolean; fields: any[] }>(`${base}/gate/validate`),
    records: (status: 'skipped' | 'restored' | 'all' = 'skipped', limit = 200) => getJSON<{ total: number; items: any[] }>(`${base}/gate/records?status=${status}&limit=${limit}`),
    restore: (id: number) => post(`${base}/gate/records/${id}/restore`),
    removeRecord: (id: number) => del(`${base}/gate/records/${id}`),
    archive: () => post(`${base}/gate/archive`),
    archives: () => getJSON<any[]>(`${base}/gate/archives`),
    searchArchives: (q: string, month?: string) => getJSON<{ results: any[] }>(`${base}/gate/archives/search?q=${encodeURIComponent(q)}${month ? '&month=' + month : ''}`)
  },
  recommend: {
    preview: (params: Record<string, string>) => {
      const qs = new URLSearchParams(params).toString()
      return getJSON<{ items: any[] }>(`${base}/recommend/preview${qs ? '?' + qs : ''}`)
    },
    list: (status = '') => getJSON<{ items: any[]; total: number }>(`${base}/recommend${status ? '?status=' + status : ''}`),
    add: (fileId: number) => post(`${base}/recommend`, { fileId }),
    update: (id: number, data: { status?: string }) => patch(`${base}/recommend/${id}`, data),
    remove: (id: number) => del(`${base}/recommend/${id}`),
    curated: () => getJSON<{ items: any[]; lastAt: string | null }>(`${base}/recommend/curated`),
    curate: () => post(`${base}/recommend/curate`)
  },
  reading: {
    rate: (fileId: number, stars: number, execIntent: 'now' | 'later' | 'info') => post(`${base}/reading/rate`, { fileId, stars, execIntent }),
    exec: () => getJSON<{ items: any[]; counts: { pending: number; overdue: number; doneToday: number } }>(`${base}/reading/exec`),
    execDone: (id: number) => post(`${base}/reading/exec/${id}/done`),
    execDismiss: (id: number) => post(`${base}/reading/exec/${id}/dismiss`),
    stats: () => getJSON<any>(`${base}/reading/stats`)
  }
}
