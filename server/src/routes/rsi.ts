// I3 RSI 成长闭环路由（挂载 /api/rsi）：学习建议 / 理解度检查出题与答题 / 状态与开关。
// 硬顶在 rsi.ts 内核强制（先于模型），路由层不重复实现打扰控制逻辑。
import { Router } from 'express'
import { buildLearningSuggestions, isQuizEnabled, generateQuiz, applyQuizResult, getRsiStatus, setRsiToggle } from '../rsi.js'

export const rsiRouter = Router()

/**
 * GET /suggestions —— 今日学习建议（≤3 条）。
 * 默认正式触发（生成即记 rsi.lastSuggestionDay，当日后续调用被硬顶拦截）；?peek=1 只看不记账（测试/预览不消耗）。
 */
rsiRouter.get('/suggestions', async (req, res) => {
  try {
    const r = await buildLearningSuggestions({ peek: req.query?.peek === '1' || req.query?.peek === 'true' })
    res.json({ success: true, ...r })
  } catch (e: any) {
    console.error('rsi suggestions failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** GET /quiz/:fileId —— 理解度检查出题（未开启 200 + success:false 简单口径，不烧模型） */
rsiRouter.get('/quiz/:fileId', async (req, res) => {
  const fileId = parseInt(req.params.fileId)
  if (isNaN(fileId)) return res.json({ success: false, message: 'fileId 必填' })
  try {
    if (!(await isQuizEnabled())) return res.json({ success: false, error: 'quiz disabled' })
    const quiz = await generateQuiz(fileId)
    if (!quiz) return res.json({ success: false, message: '出题失败：无可用要点或模型未按约定格式返回' })
    res.json({ success: true, questions: quiz.questions })
  } catch (e: any) {
    console.error('rsi quiz failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** POST /quiz/answer —— body { fileId, correct, execQueueId? }：调整间隔重复档位（只调既有行） */
rsiRouter.post('/quiz/answer', async (req, res) => {
  const fileId = parseInt(req.body?.fileId)
  const correct = req.body?.correct === true || req.body?.correct === 'true'
  const execQueueId = Number.isFinite(parseInt(req.body?.execQueueId)) ? parseInt(req.body.execQueueId) : null
  if (isNaN(fileId)) return res.status(400).json({ success: false, message: 'fileId 必填' })
  try {
    const adjusted = await applyQuizResult(execQueueId, fileId, correct)
    res.json({ success: true, adjusted })
  } catch (e: any) {
    console.error('rsi quiz answer failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** GET /status —— 设置页展示：quizEnabled / suggestionsEnabled / lastSuggestionDay */
rsiRouter.get('/status', async (_req, res) => {
  try {
    res.json({ success: true, ...(await getRsiStatus()) })
  } catch (e: any) {
    console.error('rsi status failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})

/** POST /toggle —— body { key: 'quiz'|'suggestions', value: boolean } 写对应 config 键 */
rsiRouter.post('/toggle', async (req, res) => {
  const key = req.body?.key
  const value = req.body?.value === true || req.body?.value === 'true'
  if (key !== 'quiz' && key !== 'suggestions') return res.status(400).json({ success: false, message: 'key 需为 quiz 或 suggestions' })
  try {
    const ok = await setRsiToggle(key, value)
    if (!ok) return res.status(400).json({ success: false, message: '不支持的开关' })
    res.json({ success: true, key, value })
  } catch (e: any) {
    console.error('rsi toggle failed', e)
    res.status(500).json({ success: false, message: String(e) })
  }
})
