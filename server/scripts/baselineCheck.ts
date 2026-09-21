/**
 * 评估闭环 baseline:check（v0.1.5 D1）：语料指纹锚点对比。
 * 解决的问题：语料漂移后基线文档里的重放数字失效，无法机械检测——本脚本只读重算当前库指纹，
 * 与基线文档头部 `> corpusFingerprint: {...} generatedAt: ...` 锚点行对比，给出三态裁决：
 *   exit 0 = 语料一致，基线有效
 *   exit 1 = 基线已漂移（stdout 打印前后指纹），请重跑 searchBaseline 重放并更新基线
 *   exit 2 = 基线文档不存在或头部无指纹锚点行（旧版基线），请重跑 searchBaseline 生成
 * 其余错误（如库文件不存在）fail loud：stderr 报错并 exit 1（同 searchBaseline 口径）。
 *
 * 纯函数（锚点解析/指纹对比）在 src/baselineCheckCore.ts，便于测试直接覆盖。
 *
 * 用法：
 *   npx tsx server/scripts/baselineCheck.ts [--db <sqlite 路径>] [--doc <基线 md 路径>]
 *   --db  缺省 = $AGENTFEED_DATA_DIR/app.db，未设环境变量时为 server/data/app.db（与 src/db.ts 口径一致）
 *   --doc 缺省 = <仓库根>/docs/search-baseline-2026-10.md
 *
 * 红线：只读（OPEN_READONLY，绝不写库），绝不改基线文档（只读解析）。
 * 空库约定：files 表 0 行或表不存在 → 指纹 {filesCount:0, maxFileId:0}，正常走对比，不抛错。
 */

import { SqliteDatabase, OPEN_READONLY } from '@homeofthings/sqlite3'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { computeCorpusFingerprint } from '../src/exportWiki.js'
import { extractFingerprintFromDoc, compareFingerprints } from '../src/baselineCheckCore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 缺省基线文档相对仓库根解析（scripts/ → server/ → 仓库根）
const DEFAULT_DOC = path.resolve(__dirname, '../../docs/search-baseline-2026-10.md')

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** 库为空（表不存在）视为合法空数据；其余错误原样上抛，fail loud */
function isNoSuchTable(err: unknown): boolean {
  return String((err as any)?.message ?? err).includes('no such table')
}

/** 只读打开库并重算当前语料指纹（computeCorpusFingerprint 只做 SELECT，与 OPEN_READONLY 兼容）。
 * 注意：不调用 db.close()——prepare 的 statement 未暴露 finalize，close 会报 SQLITE_BUSY；
 * 一次性只读 CLI 由 OS 回收连接，无写残留风险（同 searchBaseline 口径）。 */
async function currentFingerprint(dbPath: string): Promise<{ filesCount: number, maxFileId: number }> {
  const db = await SqliteDatabase.open(dbPath, OPEN_READONLY)
  try {
    return await computeCorpusFingerprint(db)
  } catch (err) {
    if (!isNoSuchTable(err)) throw err
    return { filesCount: 0, maxFileId: 0 }
  }
}

async function main() {
  const dbPath = argValue('--db')
    ? path.resolve(argValue('--db')!)
    : path.join(
        process.env.AGENTFEED_DATA_DIR ? path.resolve(process.env.AGENTFEED_DATA_DIR) : path.resolve(__dirname, '../data'),
        'app.db'
      )
  const docPath = argValue('--doc') ? path.resolve(argValue('--doc')!) : DEFAULT_DOC

  const now = await currentFingerprint(dbPath)

  // 读基线文档：ENOENT = 文档不存在（走缺锚 exit 2）；其余读错误（权限等）fail loud 上抛
  let md: string
  try {
    md = await fs.readFile(docPath, 'utf8')
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      console.log(`基线文档缺失指纹锚点（旧版基线），请重跑 searchBaseline 生成（文档不存在：${docPath}）`)
      process.exit(2)
    }
    throw err
  }

  const anchor = extractFingerprintFromDoc(md)
  if (!anchor) {
    console.log(`基线文档缺失指纹锚点（旧版基线），请重跑 searchBaseline 生成（文档：${docPath}）`)
    process.exit(2)
  }

  if (compareFingerprints(anchor, now)) {
    console.log(`语料一致，基线有效（filesCount=${now.filesCount}, maxFileId=${now.maxFileId}）`)
    process.exit(0)
  }

  console.log(`基线指纹：${JSON.stringify(anchor)}`)
  console.log(`当前指纹：${JSON.stringify(now)}`)
  console.log('基线已漂移，请重跑 searchBaseline 重放并更新基线')
  process.exit(1)
}

main().catch(err => {
  console.error('baselineCheck 执行失败:', err?.message ?? err)
  process.exit(1)
})
