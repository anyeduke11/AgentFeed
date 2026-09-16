export interface LlmJob {
  id: number
  fileId: number
  provider: string
  model: string
  prompt: string
  options?: Record<string, any>
  /** 优先级：越大越先出队（默认 0 = 蒸馏；assess/curate 用 1 插队到积压蒸馏之前） */
  priority?: number
}

export interface QueueEvents {
  onProgress?: (job: LlmJob, state: 'queued' | 'running' | 'done' | 'failed' | 'skipped') => void
}

export class LlmQueue {
  private queue: LlmJob[] = []
  private running = 0
  private runningFileIds = new Set<number>()
  /** 运行任务实际调度到的节点（fileId → provider/model，供前端展示真实模型） */
  private runningMeta = new Map<number, { provider: string; model: string }>()
  private maxConcurrency: number
  /** 并发可调上限（按机器性能动态计算，默认 4） */
  private maxCapacity: number
  /** 各服务商并发限额覆盖（未设置的服务商跟随 maxConcurrency）；调度按服务商独立计数，互不挤占 */
  private providerLimits = new Map<string, number>()
  private runningByProvider = new Map<string, number>()
  private paused = false
  private processing = false
  private events?: QueueEvents
  private nextId = 1
  /** 蒸馏任务出队调度器（节点池分配）：pick 就地写入 job.provider/model，release 释放节点份额 */
  private dispatcher?: { pick(job: LlmJob): boolean; release(job: LlmJob): void }

  constructor(maxConcurrency = 2, events?: QueueEvents, maxCapacity = 4) {
    this.maxConcurrency = maxConcurrency
    this.maxCapacity = maxCapacity
    this.events = events
  }

  setDispatcher(d: { pick(job: LlmJob): boolean; release(job: LlmJob): void }) {
    this.dispatcher = d
  }

  enqueue(job: Omit<LlmJob, 'id'>): LlmJob {
    const full: LlmJob = { ...job, id: this.nextId++ }
    // 按优先级插入：排在最后一个「同级或更高优先级」任务之后（低优先级蒸馏保持 FIFO）
    const pr = full.priority || 0
    if (pr > 0) {
      let idx = this.queue.length
      for (let i = this.queue.length - 1; i >= 0; i--) {
        if ((this.queue[i].priority || 0) >= pr) { idx = i + 1; break }
        if (i === 0) idx = 0
      }
      this.queue.splice(idx, 0, full)
    } else {
      this.queue.push(full)
    }
    this.events?.onProgress?.(full, 'queued')
    this.process()
    return full
  }

  pause() {
    this.paused = true
  }

  resume() {
    if (!this.paused) return
    this.paused = false
    this.process()
  }

  get isPaused() {
    return this.paused
  }

  get concurrency() {
    return this.maxConcurrency
  }

  /** 并发可调上限 */
  get capacity() {
    return this.maxCapacity
  }

  setConcurrency(n: number) {
    this.maxConcurrency = Math.max(1, Math.min(this.maxCapacity, n))
    this.process()
  }

  /** 某服务商的并发限额（未设置 → 全局值） */
  providerLimit(provider: string): number {
    return this.providerLimits.get(provider) ?? this.maxConcurrency
  }

  setProviderConcurrency(provider: string, n: number) {
    if (!provider) return
    this.providerLimits.set(provider, Math.max(1, Math.min(this.maxCapacity, n)))
    this.process()
  }

  /** 各服务商并发限额视图（前端展示用） */
  get providerConcurrencies(): Record<string, number> {
    return Object.fromEntries(this.providerLimits)
  }

  /** 某服务商当前运行数（节点池调度时做服务商聚合限额校验用） */
  runningOf(provider: string): number {
    return this.runningByProvider.get(provider) || 0
  }

  /** 外部事件（节点启停/健康恢复）后唤醒调度循环 */
  kick() {
    this.process()
  }

  /** 当前运行中的任务（文件维度，含实际调度节点） */
  get runningJobs() {
    return Array.from(this.runningMeta.entries()).map(([fileId, meta]) => ({ fileId, ...meta }))
  }

  /** 该文件是否已在内存队列或运行中（feeder 去重用） */
  hasFile(fileId: number): boolean {
    if (this.runningFileIds.has(fileId)) return true
    return this.queue.some(j => j.fileId === fileId)
  }

  get pending() {
    return this.queue.length
  }

  get active() {
    return this.running
  }

  private async process() {
    if (this.processing) return
    this.processing = true
    try {
      while (!this.paused && this.queue.length > 0) {
        // 取第一个可调度的任务：
        // - 蒸馏任务（无 options.type）走节点池 dispatcher（多模型并行 + 存活过滤 + 差异化份额）
        // - 其他类型（embed/assess 等）沿用服务商并发限额，互不挤占
        const idx = this.queue.findIndex(j =>
          this.dispatcher && !j.options?.type
            ? this.dispatcher.pick(j)
            : (this.runningByProvider.get(j.provider) || 0) < this.providerLimit(j.provider),
        )
        if (idx === -1) break
        const job = this.queue.splice(idx, 1)[0]
        this.running++
        this.runningByProvider.set(job.provider, (this.runningByProvider.get(job.provider) || 0) + 1)
        this.runningFileIds.add(job.fileId)
        this.runningMeta.set(job.fileId, { provider: job.provider, model: job.model })
        this.events?.onProgress?.(job, 'running')
        // 不 await：任务并发执行（多服务商/多节点同时蒸馏），完成回调收尾并唤醒调度循环
        void this.execute(job)
          .then(() => this.events?.onProgress?.(job, 'done'))
          .catch(() => this.events?.onProgress?.(job, 'failed'))
          .finally(() => {
            this.running--
            this.runningByProvider.set(job.provider, Math.max(0, (this.runningByProvider.get(job.provider) || 0) - 1))
            this.runningFileIds.delete(job.fileId)
            this.runningMeta.delete(job.fileId)
            if (this.dispatcher && !job.options?.type) this.dispatcher.release(job)
            this.process()
          })
      }
    } finally {
      this.processing = false
    }
  }

  private async execute(_job: LlmJob): Promise<void> {
    // Will be replaced by worker logic in next step
    throw new Error('LlmQueue executor not implemented')
  }

  setExecutor(fn: (job: LlmJob) => Promise<void>) {
    this.execute = fn
  }
}
