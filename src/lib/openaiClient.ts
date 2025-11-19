// src/lib/openaiClient.ts
import OpenAI from 'openai'

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  baseURL: process.env.OPENAI_BASE_URL, // ריק ל-OpenAI, או https://openrouter.ai/api/v1 ל-OpenRouter
})
