export type UnderlayTransition = 'wait' | 'unchanged' | 'reset' | 'rebuild'

interface UnderlayFields {
  id?: number
  kind?: string
  interface?: string
  addresses?: string[]
  dns?: string[]
}

interface UnderlayIdentity { id: number; kind: string; interface: string; addresses: string[]; dns: string[] }

function normalized(values: string[] | undefined): string[] | null {
  if (values === undefined) return []
  if (!Array.isArray(values) || values.some((value: string): boolean => typeof value !== 'string')) return null
  return Array.from(new Set(values)).sort()
}

function parseUnderlay(text: string): UnderlayIdentity | null {
  if (!text || text === 'none') return null
  try {
    const fields: UnderlayFields = JSON.parse(text) as UnderlayFields
    if (!fields || !Number.isSafeInteger(fields.id) || (fields.id || 0) <= 0 ||
      (fields.kind !== 'wifi' && fields.kind !== 'cellular') ||
      typeof fields.interface !== 'string' || fields.interface.length === 0) return null
    const addresses: string[] | null = normalized(fields.addresses)
    const dns: string[] | null = normalized(fields.dns)
    if (addresses === null || dns === null) return null
    return { id: fields.id as number, kind: fields.kind, interface: fields.interface, addresses: addresses, dns: dns }
  } catch (_) { return null }
}

function sameValues(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value: string, index: number): boolean => value === right[index])
}

/**
 * Radio technology and signal strength are deliberately not identity fields.
 * A new default SIM/netId, interface or address set may need OS IPv6 routes
 * reinstalled even when both networks have the same cellular bearer type.
 */
export function classifyUnderlayTransition(previous: string, next: string,
  ipv6Enabled: boolean, interrupted: boolean): UnderlayTransition {
  const current: UnderlayIdentity | null = parseUnderlay(next)
  if (current === null) return 'wait'
  const old: UnderlayIdentity | null = parseUnderlay(previous)
  if (old === null) return interrupted ? 'reset' : 'unchanged'
  const replaced: boolean = old.id !== current.id || old.kind !== current.kind ||
    old.interface !== current.interface || !sameValues(old.addresses, current.addresses)
  if (replaced) return ipv6Enabled ? 'rebuild' : 'reset'
  if (interrupted || !sameValues(old.dns, current.dns)) return 'reset'
  return 'unchanged'
}
