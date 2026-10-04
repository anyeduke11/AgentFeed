import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// 连接级语句/事务卫生（db.ts AppSqliteDatabase）钉死两条不变量——它们是自动扫描存活的前提：
// 1. get() 命中行后必须释放游标：驱动 SqliteStatement.get() 停在 SQLITE_ROW（busy 态）且不 reset，
//    持引用语句（GC 无法兜底回收）会让下一次 transactionalize 的 COMMIT 报 SQLITE_BUSY
//    「cannot commit transaction - SQL statements in progress」——scan_jobs 台账 interval 轮
//    连续三轮即此死因。测试持引用复现原始失败条件，修复退回即红。
// 2. 并发 transactionalize 必须串行：事务回调 await 间隙放行调度，另一事务的 BEGIN 撞上打开的
//    事务 → SQLITE_ERROR cannot start a transaction within a transaction（台账 311 实证）。
// 3. 嵌套调用必须 fail-fast：互斥队列下嵌套会永久死锁，必须立刻报错而非静默排队。

const DATA_TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'agentfeed-busyguard-'))
process.env.AGENTFEED_DATA_DIR = DATA_TMP

const { getDb, closeDb } = await import('../src/db.js')

after(async () => {
  try { await closeDb() } catch { /* 临时库句柄未全部 finalize，进程退出自然释放 */ }
  await fs.rm(DATA_TMP, { recursive: true, force: true })
})

test('get 命中行不留 busy 游标：持引用语句 get 后事务必须能提交（修复退回即 SQLITE_BUSY）', async () => {
  const db = await getDb()
  await db.exec("INSERT INTO config (key, value, type) VALUES ('busyguard.a', '1', 'string')")
  // 持引用 = GC 兜底失效，复现线上 COMMIT 失败的确定性条件
  const stmt = await db.prepare("SELECT value FROM config WHERE key = 'busyguard.a'")
  const row = await stmt.get()
  assert.ok(row, '前置：get 必须命中行（命中才会留 busy 游标）')
  // 未修复时此处 COMMIT 撞 SQLITE_ROW 游标 → SQLITE_BUSY statements in progress
  await db.transactionalize(async () => {
    await db.exec("INSERT INTO config (key, value, type) VALUES ('busyguard.committed', '1', 'string')")
  })
  const check = await (await db.prepare("SELECT COUNT(*) AS n FROM config WHERE key = 'busyguard.committed'")).get() as any
  assert.equal(Number(check.n), 1, '事务必须成功提交（get 的游标不得阻塞 COMMIT）')
})

test('get 空结果与参数重绑定语义不变：无行不误 reset 报错，两次 get 各取各的行', async () => {
  const db = await getDb()
  const stmt = await db.prepare('SELECT value FROM config WHERE key = ?')
  assert.equal(await stmt.get('busyguard.none'), undefined, '空结果返回 undefined（驱动已自复位）')
  assert.equal((await stmt.get('busyguard.a'))?.value, '1')
  assert.equal((await stmt.get('busyguard.committed'))?.value, '1', '重绑定参数必须生效（auto-reset 不得改变逐次 get 语义）')
  await stmt.finalize()
})

test('并发 transactionalize 串行执行：A 回调 await 间隙 B 排队，双方完整提交无 nested 错误', async () => {
  const db = await getDb()
  const order: string[] = []
  const txA = db.transactionalize(async () => {
    order.push('A-begin')
    await new Promise(r => setTimeout(r, 30)) // 放行调度：未修复时 B 的 BEGIN 在此插入并报错
    await db.exec("INSERT INTO config (key, value, type) VALUES ('busyguard.txA', 'A', 'string')")
    order.push('A-commit')
  })
  const txB = (async () => {
    await db.transactionalize(async () => {
      order.push('B-begin')
      await db.exec("INSERT INTO config (key, value, type) VALUES ('busyguard.txB', 'B', 'string')")
      order.push('B-commit')
    })
  })()
  await Promise.all([txA, txB])
  assert.deepEqual(order, ['A-begin', 'A-commit', 'B-begin', 'B-commit'], 'B 必须整体排在 A 提交之后（互斥链语义）')
  const n = await (await db.prepare("SELECT COUNT(*) AS n FROM config WHERE key LIKE 'busyguard.tx%'")).get() as any
  assert.equal(Number(n.n), 2, '两个事务都必须落库')
})

test('嵌套事务 fail-fast：外层回调内再调 transactionalize 立即报错，不静默排队不死锁', async () => {
  const db = await getDb()
  await assert.rejects(
    db.transactionalize(async () => db.transactionalize(async () => { /* 不会执行 */ })),
    /嵌套/,
    '嵌套必须立刻抛错（互斥队列会死锁，静默比崩溃更危险）'
  )
})
