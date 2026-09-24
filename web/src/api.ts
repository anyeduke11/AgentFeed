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
function put(url: string, data: any) {
  return fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(r => r.json())
}

export const api = {
  // Web 混合检索（三路 RRF：files LIKE + wiki FTS5 + 分块向量）——与 MCP search_knowledge 同内核
  search: {
    knowledge: (params: Record<string, string>) => {
      const qs = new URLSearchParams(params).toString()
      return getJSON<{ success: boolean; items: any[]; total: number; message?: string }>(`${base}/search?${qs}`)
    },
    doctor: () => getJSON<{ success: boolean; checks: { key: string; ok: boolean; detail: string }[] }>(`${base}/search/doctor`),
    // 点击归因：搜索结果被点击时落 read_history(file_id, source=search, query)——Web 漏斗 level1
    click: (fileId: number, query: string) => post(`${base}/search/click`, { fileId, query }),
  },
  // 网页剪藏（收件坪 tab）：URL → Playwright 抓取 → md/html 双文件落盘 → 既有管线蒸馏/向量化
  webclip: {
    getConfig: () => getJSON<any>(`${base}/webclip/config`),
    putConfig: (storageRoot: string) => put(`${base}/webclip/config`, { storageRoot }),
    convert: (payload: { url: string; snapshot?: boolean; force?: boolean }) => post(`${base}/webclip/convert`, payload),
    records: (params?: Record<string, string>) => {
      const qs = params ? new URLSearchParams(params).toString() : ''
      return getJSON<any>(`${base}/webclip/records${qs ? '?' + qs : ''}`)
    },
  },
  files: {
    list: (params?: Record<string, string>) => {
      const qs = new URLSearchParams(params).toString()
      return getJSON<any>(`${base}/files${qs ? '?' + qs : ''}`)
    },
    open: (id: number, source?: string) => post(`${base}/files/${id}/open`, source ? { source } : undefined),
    content: (id: number) => getJSON<{ success: boolean; html?: string; toc?: { level: number; text: string; id: string }[]; title?: string; truncated?: boolean; unsupported?: boolean; inPool?: boolean; lastProgress?: number; path?: string; message?: string }>(`${base}/files/${id}/content`),
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
    proposalAcceptBatch: () => post(`${base}/tags/proposals/accept-batch`, { kind: 'semantic' }),
    proposalReject: (id: number) => post(`${base}/tags/proposals/${id}/reject`),
    scanNormalize: () => post(`${base}/tags/scan/normalize`),
    scanSemantic: (batchSize = 400) => post(`${base}/tags/scan/semantic`, { batchSize }),
    scanLevel: (minCount = 50, batchSize = 50) => post(`${base}/tags/scan/level`, { minCount, batchSize }),
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
    jobs: () => getJSON<{ success: boolean; total: number; items: any[] }>(`${base}/scan/jobs`),
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
    mcp: () => getJSON<any>(`${base}/stats/mcp`),
    funnel: () => getJSON<any>(`${base}/stats/funnel`)
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
    embeddingsSearch: (query: string, topK = 5) => post(`${base}/llm/embeddings/search`, { query, topK }),
    qualityBackfill: () => post(`${base}/llm/quality-backfill`),
    qualityBackfillProgress: () => getJSON<any>(`${base}/llm/quality-backfill`)
  },
  wiki: {
    list: (params?: Record<string, string>) => {
      const qs = new URLSearchParams(params).toString()
      return getJSON<any>(`${base}/wiki${qs ? '?' + qs : ''}`)
    },
    detail: (id: number) => getJSON<any>(`${base}/wiki/${id}`),
    detailImported: (metaId: number) => getJSON<any>(`${base}/wiki/imported/${metaId}`),
    importPreview: (dir: string) => post(`${base}/wiki/import/preview`, { dir }),
    importExec: (dir: string) => post(`${base}/wiki/import`, { dir }),
    chunkBackfillStatus: () => getJSON<any>(`${base}/wiki/chunks/backfill/status`),
    chunkBackfillStart: (limit = 50) => post(`${base}/wiki/chunks/backfill/start`, { limit }),
    chunkBackfillStop: () => post(`${base}/wiki/chunks/backfill/stop`)
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
    curate: () => post(`${base}/recommend/curate`),
    daily: () => getJSON<{ items: any[]; date: string }>(`${base}/recommend/daily`)
  },
  reading: {
    rate: (fileId: number, stars: number, execIntent: 'now' | 'later' | 'info') => post(`${base}/reading/rate`, { fileId, stars, execIntent }),
    progress: (fileId: number, progress: number) => post(`${base}/reading/progress`, { fileId, progress }),
    exec: () => getJSON<{ items: any[]; counts: { pending: number; overdue: number; doneToday: number } }>(`${base}/reading/exec`),
    execDone: (id: number) => post(`${base}/reading/exec/${id}/done`),
    execDismiss: (id: number) => post(`${base}/reading/exec/${id}/dismiss`),
    goal: (weeklyGoal: number) => post(`${base}/reading/goal`, { weeklyGoal }),
    stats: () => getJSON<any>(`${base}/reading/stats`),
    related: (fileId: number) => getJSON<{ success: boolean; items: Array<{ id: number; title: string; path: string; opens: number }> }>(`${base}/reading/related/${fileId}`),
    feedback: (fileId: number | null, path: string, rating: number, feedback?: string) => post(`${base}/reading/feedback`, { fileId, path, rating, feedback })
  },

  profile: {
    get: (scope: 'global' | 'domain', domainId?: number) =>
      getJSON<any>(`${base}/profile?scope=${scope}${domainId ? `&domainId=${domainId}` : ''}`),
    versions: (scope: 'global' | 'domain', domainId?: number) =>
      getJSON<any>(`${base}/profile/versions?scope=${scope}${domainId ? `&domainId=${domainId}` : ''}`),
    versionDetail: (id: number) => getJSON<any>(`${base}/profile/versions/${id}`),
    veto: (versionId: number, claim: string) => post(`${base}/profile/veto`, { versionId, claim }),
    addClaim: (scope: 'global' | 'domain', claim: string, domainId?: number) =>
      post(`${base}/profile/claim`, { scope, claim, domainId }),
    revert: (versionId: number) => post(`${base}/profile/revert`, { versionId }),
    evidence: (ptr: string) => getJSON<any>(`${base}/profile/evidence?ptr=${encodeURIComponent(ptr)}`),
    distill: () => post(`${base}/profile/distill`),
    status: () => getJSON<any>(`${base}/profile/status`)
  },

  chat: {
    sessions: (qs = '') => getJSON<{ success: boolean; sessions: Array<{ sessionId: string; title: string; domain: string | null; tags: string[]; archived: boolean; preview: string; msgCount: number; lastAt: string }> }>(`${base}/chat/sessions${qs}`),
    sessionDetail: (id: string) => getJSON<{ success: boolean; messages: Array<{ id: number; role: string; content: string; createdAt: string; refs?: Array<{ id: number; title: string }> }> }>(`${base}/chat/sessions/${encodeURIComponent(id)}`),
    patchSession: (id: string, payload: { title?: string; domain?: string | null; tags?: string[]; archived?: boolean }) => patch(`${base}/chat/sessions/${encodeURIComponent(id)}`, payload),
    deleteSession: (id: string) => del(`${base}/chat/sessions/${encodeURIComponent(id)}`),
    deletions: () => getJSON<{ success: boolean; deletions: Array<{ sessionId: string; preview: string; msgCount: number; deletedAt: string }> }>(`${base}/chat/deletions`),
    exportPreview: (id: string, refined = false, dir = '') => getJSON<{ success: boolean; markdown: string; dir: string; fileName: string; refined: boolean; message?: string }>(`${base}/chat/sessions/${encodeURIComponent(id)}/export/preview?${new URLSearchParams({ ...(refined ? { refined: '1' } : {}), ...(dir ? { dir } : {}) })}`),
    exportSave: (id: string, payload: { markdown: string; dir?: string }) => post(`${base}/chat/sessions/${encodeURIComponent(id)}/export`, payload),
    distill: (id: string, payload: { markdown: string; dir?: string }) => post(`${base}/chat/sessions/${encodeURIComponent(id)}/distill`, payload),
    exportLogs: () => getJSON<{ success: boolean; total: number; logs: Array<{ id: number; kind: string; sessionId: string; title: string; path: string; match: string | null; entryId: number | null; chars: number; createdAt: string }> }>(`${base}/chat/export-logs`),
    recap: (sessionId: string) => post(`${base}/chat/recap`, { sessionId })
  },

  rsi: {
    suggestions: (peek = false) => getJSON<{ success: boolean; items: Array<{ fileId: number; title: string; reason: string }>; generated: boolean; hardBlocked?: 'daily-cap' | 'disabled' }>(`${base}/rsi/suggestions${peek ? '?peek=1' : ''}`),
    quiz: (fileId: number) => getJSON<{ success: boolean; questions?: Array<{ q: string; a: string }>; error?: string; message?: string }>(`${base}/rsi/quiz/${fileId}`),
    answer: (fileId: number, correct: boolean, execQueueId?: number) => post(`${base}/rsi/quiz/answer`, { fileId, correct, execQueueId }),
    status: () => getJSON<{ success: boolean; quizEnabled: boolean; suggestionsEnabled: boolean; lastSuggestionDay: string | null }>(`${base}/rsi/status`),
    toggle: (key: 'quiz' | 'suggestions', value: boolean) => post(`${base}/rsi/toggle`, { key, value })
  }
}
