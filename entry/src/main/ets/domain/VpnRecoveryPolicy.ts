export interface RecoveryBudget { windowAt: number; attempts: number; retryAt: number }
export function nextRecoveryAttempt(previous: RecoveryBudget, now: number): RecoveryBudget | null {
  const attempts: number = now - previous.windowAt >= 120000 ? 0 : previous.attempts
  if (now < previous.retryAt || attempts >= 3) return null
  return { windowAt: attempts === 0 ? now : previous.windowAt, attempts: attempts + 1, retryAt: now + [5000, 15000, 60000][attempts] }
}
