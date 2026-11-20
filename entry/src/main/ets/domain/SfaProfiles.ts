import type { SubscriptionUsage } from './SubscriptionUsage.ts'
import { validSubscriptionUsage } from './SubscriptionUsage.ts'
import { copyProfileNode, profileNodes } from './ProfileNodes.ts'
import type { ProfileNode } from './ProfileNodes.ts'

export interface SfaProfile {
  id: string
  name: string
  kind: string
  url: string
  content: string
  updatedAt: number
  usage?: SubscriptionUsage
  localNodeEdits?: boolean
  retainedNodeTags?: string[]
  autoUpdate?: boolean
  autoUpdateInterval?: number
}

export const BUILTIN_PROFILE_IDS: string[] = ['builtin-base', 'builtin-mainland', 'builtin-gfw']
export const MIN_AUTO_UPDATE_INTERVAL_MINUTES: number = 15
export const DEFAULT_AUTO_UPDATE_INTERVAL_MINUTES: number = 60

// SFA parity: only remote profiles can auto-update. The interval is stored in
// minutes and clamped to the 15 minute floor SFA uses for its periodic worker.
export function effectiveAutoUpdateInterval(profile: SfaProfile): number {
  const value: number | undefined = profile.autoUpdateInterval
  if (value === undefined || !Number.isFinite(value) || value < MIN_AUTO_UPDATE_INTERVAL_MINUTES) {
    return DEFAULT_AUTO_UPDATE_INTERVAL_MINUTES
  }
  return Math.trunc(value)
}

export function profileAutoUpdateDue(profile: SfaProfile, now: number): boolean {
  if (profile.kind !== 'remote' || profile.autoUpdate !== true) return false
  if (!/^https:\/\//i.test(profile.url)) return false
  return now - profile.updatedAt >= effectiveAutoUpdateInterval(profile) * 60000
}

export interface SfaCatalog {
  version: number
  selectedId: string
  profiles: SfaProfile[]
}

export function emptySfaCatalog(): SfaCatalog {
  return { version: 1, selectedId: '', profiles: [] }
}

export function removeLegacyBuiltinProfiles(catalog: SfaCatalog): SfaCatalog {
  const profiles: SfaProfile[] = catalog.profiles.filter((profile: SfaProfile): boolean => {
    if (profile.kind === 'builtin') return false
    // The previous migration used this label and reserved ID pattern.
    return !(profile.kind === 'local' && profile.name === '旧版节点配置' &&
      /^migrated-builtin-(base|mainland|gfw)(-local)*$/.test(profile.id))
  })
  if (profiles.length === catalog.profiles.length) return catalog
  const selectedId: string = catalog.selectedId === '' ||
    profiles.some((profile: SfaProfile) => profile.id === catalog.selectedId)
    ? catalog.selectedId : (profiles[0]?.id || '')
  return { version: catalog.version, selectedId: selectedId, profiles: profiles }
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
    if (profile.retainedNodeTags !== undefined && (!Array.isArray(profile.retainedNodeTags) ||
      profile.retainedNodeTags.some((tag: string) => typeof tag !== 'string' || tag.length === 0))) throw new Error('保留节点标识无效')
    if (profile.autoUpdate !== undefined && typeof profile.autoUpdate !== 'boolean') throw new Error('自动更新标识无效')
    if (profile.autoUpdateInterval !== undefined && (typeof profile.autoUpdateInterval !== 'number' ||
      !Number.isFinite(profile.autoUpdateInterval) || profile.autoUpdateInterval < MIN_AUTO_UPDATE_INTERVAL_MINUTES)) {
      throw new Error('自动更新间隔无效')
    }
    ids.push(profile.id)
  }
  if (value.selectedId.length > 0 && !ids.includes(value.selectedId)) throw new Error('选中的配置不存在')
  return value
}

// Decides whether an editor save creates a new profile or overwrites an
// existing one. A repeat scan/save of the same remote URL targets the
// catalog entry that already holds it (aligned with SFA andSelect=true),
// instead of piling up duplicates.
export interface ProfileSaveTarget {
  mode: string // 'create' | 'update'
  targetId: string
}

export function resolveProfileSaveTarget(catalog: SfaCatalog, editingId: string, kind: string, url: string): ProfileSaveTarget {
  if (editingId.length > 0) return { mode: 'update', targetId: editingId }
  const trimmed: string = url.trim()
  if (kind === 'remote' && trimmed.length > 0) {
    const existing: SfaProfile | undefined = catalog.profiles.find((item: SfaProfile) => item.kind === 'remote' && item.url === trimmed)
    if (existing) return { mode: 'update', targetId: existing.id }
  }
  return { mode: 'create', targetId: '' }
}

export function saveSfaProfile(catalog: SfaCatalog, profile: SfaProfile): SfaCatalog {
  validateSfaContent(profile.content)
  const profiles: SfaProfile[] = catalog.profiles.filter((item: SfaProfile) => item.id !== profile.id)
  const previousIndex: number = catalog.profiles.findIndex((item: SfaProfile) => item.id === profile.id)
  profiles.splice(previousIndex < 0 ? profiles.length : previousIndex, 0, profile)
  const next: SfaCatalog = { version: 1, profiles: profiles, selectedId: catalog.selectedId || profile.id }
  return parseSfaCatalog(JSON.stringify(next))
}

export function mergeRetainedProfileNodes(profile: SfaProfile, downloaded: string): string {
  validateSfaContent(downloaded)
  if (!profile.retainedNodeTags || profile.retainedNodeTags.length === 0) return downloaded
  const available: string[] = profileNodes(profile.content).map((node: ProfileNode) => node.tag)
  let content: string = downloaded
  for (const tag of profile.retainedNodeTags || []) {
    if (available.includes(tag)) content = copyProfileNode(profile.content, tag, content, true).content
  }
  return content
}

export function deleteSfaProfile(catalog: SfaCatalog, id: string): SfaCatalog {
  if (BUILTIN_PROFILE_IDS.includes(id)) throw new Error('内置基础配置不能删除')
  const profiles: SfaProfile[] = catalog.profiles.filter((item: SfaProfile) => item.id !== id)
  return { version: 1, profiles: profiles,
    selectedId: catalog.selectedId === id ? (profiles.length > 0 ? profiles[0].id : '') : catalog.selectedId }
}
