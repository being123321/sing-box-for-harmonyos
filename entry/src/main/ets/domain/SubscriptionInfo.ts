export interface SubscriptionInfo { remaining: string; expiry: string }
interface InfoOutbound { tag?: string; outbounds?: string[] }
interface InfoConfig { outbounds?: InfoOutbound[] }

// Some providers encode account metadata as display-only outbound names.
// These are provider snapshots, never locally estimated account balances.
export function subscriptionInfoFromNames(names: string[]): SubscriptionInfo {
  const info: SubscriptionInfo = { remaining: '', expiry: '' }
  for (const name of names) {
    if (typeof name !== 'string' || name.length > 256) continue
    if (!info.remaining) {
      const match = name.match(/(?:剩余流量|流量剩余|remaining\s*(?:traffic|data))\s*[:：]\s*(\d+(?:\.\d+)?\s*(?:[KMGTPE]i?B|B))\b/i)
      if (match) info.remaining = '剩余流量：' + match[1]
    }
    if (!info.expiry) {
      const match = name.match(/(?:套餐到期|到期时间|有效期至|expire(?:s|\s*date)?)\s*[:：]\s*([^\r\n]{1,64})/i)
      if (match) info.expiry = '套餐到期：' + match[1].trim()
    }
    if (info.remaining && info.expiry) break
  }
  return info
}

export function subscriptionInfoFromJson(text: string): SubscriptionInfo {
  try {
    const config: InfoConfig = JSON.parse(text.replace(/^\uFEFF/, '')) as InfoConfig
    if (!config || !Array.isArray(config.outbounds)) return { remaining: '', expiry: '' }
    const names: string[] = []
    for (const outbound of config.outbounds) {
      if (!outbound || typeof outbound !== 'object') continue
      if (typeof outbound.tag === 'string') names.push(outbound.tag)
      if (Array.isArray(outbound.outbounds)) {
        for (const name of outbound.outbounds) if (typeof name === 'string') names.push(name)
      }
    }
    return subscriptionInfoFromNames(names)
  } catch (_) { return { remaining: '', expiry: '' } }
}
