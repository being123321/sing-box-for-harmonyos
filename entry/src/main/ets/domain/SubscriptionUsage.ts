export interface SubscriptionUsage {
  uploadBytes: number
  downloadBytes: number
  totalBytes: number
  expireAtSeconds: number
  updatedAt: number
}

// Mirrors Clash Meta's adapter/provider/subscription_info.go parser. The header
// value is `upload=..; download=..; total=..; expire=..`, field names are
// case-insensitive, spaces are ignored, and a malformed number only drops that
// field instead of the whole header. Bytes are bytes; expire is Unix seconds.
// -1 means absent. In particular, an absent counter must not look like zero use.
export function parseSubscriptionUsage(header: string, now: number): SubscriptionUsage | undefined {
  if (!header || header.length > 4096) return undefined
  const normalized: string = header.toLowerCase().replace(/\s+/g, '')
  const usage: SubscriptionUsage = { uploadBytes: -1, downloadBytes: -1, totalBytes: -1, expireAtSeconds: -1, updatedAt: now }
  let found: boolean = false
  for (const part of normalized.split(';')) {
    const separator: number = part.indexOf('=')
    if (separator <= 0 || separator === part.length - 1) continue
    const key: string = part.slice(0, separator)
    const raw: string = part.slice(separator + 1)
    if (!/^\d+(?:\.\d+)?$/.test(raw)) continue
    const amount: number = Math.floor(Number(raw))
    if (!Number.isSafeInteger(amount) || amount < 0) continue
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

// Clash Meta shows `used/total` and hides the traffic row entirely when the
// airport sent nothing usable (its layout gates on download < 2). `total` has no
// "unlimited" meaning there, so a zero total only drops the total and the bar.
export function usageLabel(usage?: SubscriptionUsage): string {
  const used: number = usageAmount(usage)
  if (!usage || used < 2) return ''
  if (usage.totalBytes >= 2) return usageGiB(used) + '/' + usageGiB(usage.totalBytes)
  return '已用 ' + usageGiB(used)
}

export function usageProgress(usage?: SubscriptionUsage): number {
  const used: number = usageAmount(usage)
  return usage && usage.totalBytes >= 2 && used >= 2 ? Math.min(100, Math.max(0, used / usage.totalBytes * 100)) : -1
}

export function usageRemaining(usage?: SubscriptionUsage): string {
  const used: number = usageAmount(usage)
  return usage && usage.totalBytes >= 2 && used >= 2 ? '剩余流量：' + usageGiB(Math.max(0, usage.totalBytes - used)) : ''
}

function twoDigit(value: number): string { return value.toString().padStart(2, '0') }

// Clash Meta formats expire as an absolute local timestamp and hides it when the
// header carries no expiry (expire=0), so there is no "长期有效" placeholder.
export function usageExpiry(usage?: SubscriptionUsage): string {
  if (!usage || usage.expireAtSeconds <= 0) return ''
  const date: Date = new Date(usage.expireAtSeconds * 1000)
  return '套餐到期：' + date.getFullYear() + '-' + twoDigit(date.getMonth() + 1) + '-' + twoDigit(date.getDate()) +
    ' ' + twoDigit(date.getHours()) + ':' + twoDigit(date.getMinutes()) + ':' + twoDigit(date.getSeconds())
}
