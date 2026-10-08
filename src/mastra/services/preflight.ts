import type { Mastra } from '@mastra/core'
import { anthropicOptions } from '../config.ts'
import { errorMessage } from './jobs.ts'

/**
 * 重いジョブを始める前に、モデル API が使える状態か (キー・残高・疎通) をごく小さな呼び出しで確かめる。
 * これが無いと「クレジット不足」などが数分後に初めて分かる。成功は 10 分間キャッシュする。
 */
const CACHE_MS = 10 * 60 * 1000
let okUntil = 0

export class PreflightError extends Error {}

export async function preflightModel(mastra: Mastra): Promise<void> {
  if (Date.now() < okUntil) return
  if (process.env.KAKOMON_SKIP_PREFLIGHT === '1') return
  try {
    const agent = mastra.getAgentById('exam-grader')
    await agent.generate('ping', {
      modelSettings: { maxOutputTokens: 16, maxRetries: 0 },
      providerOptions: anthropicOptions('low'),
    })
    okUntil = Date.now() + CACHE_MS
  } catch (err) {
    const msg = errorMessage(err)
    const hint = /credit balance/i.test(msg)
      ? 'Anthropic API のクレジットが不足しています。https://console.anthropic.com の Plans & Billing で購入してください。'
      : /invalid.*api key|authentication/i.test(msg)
        ? 'ANTHROPIC_API_KEY が無効です。.env の値を確認してください。'
        : 'モデル API に接続できません。'
    throw new PreflightError(`${hint} (${msg})`)
  }
}
