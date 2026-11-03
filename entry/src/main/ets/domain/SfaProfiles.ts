import type { SubscriptionUsage } from './SubscriptionUsage.ts'
import { validSubscriptionUsage } from './SubscriptionUsage.ts'

export interface SfaProfile {
  id: string
  name: string
  kind: string
  url: string
  content: string
  updatedAt: number
  usage?: SubscriptionUsage
  localNodeEdits?: boolean
}

export const BUILTIN_PROFILE_IDS: string[] = ['builtin-base', 'builtin-mainland', 'builtin-gfw']

export interface SfaCatalog {
  version: number
  selectedId: string
  profiles: SfaProfile[]
}

export function emptySfaCatalog(): SfaCatalog {
  return { version: 1, selectedId: '', profiles: [] }
}

// The original JSON is persisted verbatim. TUN adaptation happens only when
// a selected profile is passed to the VPN extension; no subscription conversion.
export function validateSfaContent(text: string): void {
  const value: Record<string, Object> = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, Object>
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('配置必须是 sing-box JSON 对象')
  if (text.length > 4 * 1024 * 1024) throw new Error('配置不能超过 4 MiB')
}

export function parseSfaCatalog(text: string): SfaCatalog {
  const value: SfaCatalog = JSON.parse(text) as SfaCatalog
  if (value.version !== 1 || !Array.isArray(value.profiles) || typeof value.selectedId !== 'string') {
    throw new Error('配置目录无效')
  }
  const ids: string[] = []
  for (const profile of value.profiles) {
    if (!profile || typeof profile.id !== 'string' || profile.id.length === 0 ||
      typeof profile.name !== 'string' || typeof profile.content !== 'string' ||
      typeof profile.url !== 'string' || typeof profile.updatedAt !== 'number' ||
      !['local', 'remote', 'builtin'].includes(profile.kind) || ids.includes(profile.id)) throw new Error('配置条目无效')
    if ((profile.kind === 'builtin') !== BUILTIN_PROFILE_IDS.includes(profile.id)) throw new Error('内置配置标识无效')
    if (profile.kind === 'remote' && !/^https:\/\//i.test(profile.url)) throw new Error('远程配置需要 HTTPS 地址')
    validateSfaContent(profile.content)
    if (profile.usage !== undefined && !validSubscriptionUsage(profile.usage)) throw new Error('订阅流量信息无效')
    if (profile.localNodeEdits !== undefined && typeof profile.localNodeEdits !== 'boolean') throw new Error('节点修改标识无效')
    ids.push(profile.id)
  }
  if (value.selectedId.length > 0 && !ids.includes(value.selectedId)) throw new Error('选中的配置不存在')
  return value
}

export function saveSfaProfile(catalog: SfaCatalog, profile: SfaProfile): SfaCatalog {
  validateSfaContent(profile.content)
  const profiles: SfaProfile[] = catalog.profiles.filter((item: SfaProfile) => item.id !== profile.id)
  const previousIndex: number = catalog.profiles.findIndex((item: SfaProfile) => item.id === profile.id)
  profiles.splice(previousIndex < 0 ? profiles.length : previousIndex, 0, profile)
  const next: SfaCatalog = { version: 1, profiles: profiles, selectedId: catalog.selectedId || profile.id }
  return parseSfaCatalog(JSON.stringify(next))
}

export function deleteSfaProfile(catalog: SfaCatalog, id: string): SfaCatalog {
  if (BUILTIN_PROFILE_IDS.includes(id)) throw new Error('内置基础配置不能删除')
  const profiles: SfaProfile[] = catalog.profiles.filter((item: SfaProfile) => item.id !== id)
  return { version: 1, profiles: profiles,
    selectedId: catalog.selectedId === id ? (profiles.length > 0 ? profiles[0].id : '') : catalog.selectedId }
}
