// src/server/askClaude.ts
import { anthropic } from '@/lib/anthropicClient'
import { limiter } from '@/lib/limiter'

export async function askClaude(prompt: string) {
  const maxTokens = Number(process.env.ANTHROPIC_MAX_TOKENS || 1024)

  return limiter.schedule(() =>
    anthropic.messages.create({
      model: 'claude-3-5-sonnet-latest',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    })
  )
}
