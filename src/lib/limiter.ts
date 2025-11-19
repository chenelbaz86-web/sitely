// src/lib/limiter.ts
import Bottleneck from 'bottleneck'

const rpm = Number(process.env.ANTHROPIC_RPM_BUDGET || 50) // בקשות לדקה
const minTime = Math.ceil(60_000 / Math.max(rpm, 1))       // מרווח מינימלי בין קריאות

export const limiter = new Bottleneck({
  minTime,                  // מרווח בין קריאות, מונע ניצול יתר
  maxConcurrent: 1,         // לא מריצים קריאות במקביל
  reservoir: rpm,           // כמה קריאות זמינות בדקה
  reservoirRefreshAmount: rpm,
  reservoirRefreshInterval: 60_000,
})
