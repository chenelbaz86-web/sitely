// src/server/askAI.ts
import { openai } from '@/lib/openaiClient'

export async function askAI(messages: Array<{role: 'user'|'assistant'|'system'; content: string;}>) {
  const model = process.env.MODEL_NAME || 'gpt-4o-mini'
  const maxTokens = Number(process.env.OPENAI_MAX_TOKENS || 768)

  const resp = await openai.chat.completions.create({
    model,
    messages,               // [{role:'user', content:'...'}] וכו'
    max_tokens: maxTokens,
    temperature: 0.2,
  })

  return resp.choices[0]?.message?.content ?? ''
}
