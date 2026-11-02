export interface SubscriptionUsage {
  uploadBytes: number
  downloadBytes: number
  totalBytes: number
  expireAtSeconds: number
  updatedAt: number
}

// -1 means absent. In particular, an absent counter must not look like zero use.
export function parseSubscriptionUsage(header: string, now: number): SubscriptionUsage | undefined {
  if (!header || header.length > 4096) return undefined
  const usage: SubscriptionUsage = { uploadBytes: -1, downloadBytes: -1, totalBytes: -1, expireAtSeconds: -1, updatedAt: now }
  let found: boolean = false
  for (const part of header.split(';')) {
    const pair: string[] = part.trim().split('=')
    if (pair.length !== 2 || !/^\d+$/.test(pair[1].trim())) continue
    const amount: number = Number(pair[1].trim())
    if (!Number.isSafeInteger(amount) || amount < 0) continue
    const key: string = pair[0].trim().toLowerCase()
    if (key === 'upload') { usage.uploadBytes = amount; found = true }
    if (key === 'download') { usage.downloadBytes = amount; found = true }
    if (key === 'total') { usage.totalBytes = amount; found = true }
    if (key === 'expire' && amount <= 8640000000000) { usage.expireAtSeconds = amount; found = true }
  }
  if (!found || !validSubscriptionUsage(usage)) return undefined
  return usage
}

export function validSubscriptionUsage(usage: SubscriptionUsage): boolean {
  return !!usage && [usage.uploadBytes, usage.downloadBytes, usage.totalBytes, usage.expireAtSeconds]
    .every((value: number) => Number.isSafeInteger(value) && value >= -1) &&
    usage.expireAtSeconds <= 8640000000000 && Number.isFinite(usage.updatedAt) && usage.updatedAt >= 0 &&
    (usage.uploadBytes < 0 || usage.downloadBytes < 0 || Number.isSafeInteger(usage.uploadBytes + usage.downloadBytes))
}

export function usageGiB(bytes: number): string { return (bytes / 1073741824).toFixed(2) + ' GiB' }

export function usageAmount(usage?: SubscriptionUsage): number {
  return usage && usage.uploadBytes >= 0 && usage.downloadBytes >= 0 ? usage.uploadBytes + usage.downloadBytes : -1
}

export function usageLabel(usage?: SubscriptionUsage): string {
  const used: number = usageAmount(usage)
  if (!usage || used < 0) return ''
  if (usage.totalBytes > 0) return usageGiB(used) + '/' + usageGiB(usage.totalBytes)
  return '已用 ' + usageGiB(used) + (usage.totalBytes === 0 ? ' · 不限量' : ' · 总量未知')
}

export function usageProgress(usage?: SubscriptionUsage): number {
  const used: number = usageAmount(usage)
  return usage && usage.totalBytes > 0 && used >= 0 ? Math.min(100, Math.max(0, used / usage.totalBytes * 100)) : -1
}

export function usageRemaining(usage?: SubscriptionUsage): string {
  const used: number = usageAmount(usage)
  return usage && usage.totalBytes > 0 && used >= 0 ? '剩余流量：' + usageGiB(Math.max(0, usage.totalBytes - used)) : ''
}

export function usageExpiry(usage?: SubscriptionUsage): string {
  if (!usage || usage.expireAtSeconds < 0) return ''
  if (usage.expireAtSeconds === 0) return '套餐到期：长期有效'
  const date: Date = new Date(usage.expireAtSeconds * 1000)
  return '套餐到期：' + date.getFullYear() + '-' + (date.getMonth() + 1).toString().padStart(2, '0') + '-' + date.getDate().toString().padStart(2, '0')
}
