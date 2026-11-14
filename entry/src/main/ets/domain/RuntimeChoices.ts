export interface GroupChoice { group: string; outbound: string }
export interface ProfileChoices { profileId: string; mode: string; groups: GroupChoice[] }
export interface ChoicesCatalog { version: number; profiles: ProfileChoices[] }
export interface ChoiceCommand { action: string; group?: string; outbound?: string; mode?: string }

export function emptyChoices(profileId: string): ProfileChoices {
  return { profileId: profileId, mode: '', groups: [] }
}

export function parseChoices(text: string): ChoicesCatalog {
  const value: ChoicesCatalog = JSON.parse(text) as ChoicesCatalog
  if (value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 4096) throw new Error('节点选择记录格式无效，原记录已保留')
  const ids: string[] = []
  for (const profile of value.profiles) {
    if (!profile || typeof profile.profileId !== 'string' || profile.profileId.length === 0 || ids.includes(profile.profileId) ||
      !['', 'rule', 'global', 'direct'].includes(profile.mode) || !Array.isArray(profile.groups) || profile.groups.length > 4096) throw new Error('节点选择记录格式无效，原记录已保留')
    ids.push(profile.profileId)
    const tags: string[] = []
    for (const group of profile.groups) {
      if (!group || typeof group.group !== 'string' || group.group.length === 0 || typeof group.outbound !== 'string' || group.outbound.length === 0 || tags.includes(group.group)) throw new Error('节点选择记录格式无效，原记录已保留')
      tags.push(group.group)
    }
  }
  return value
}

export function recordChoice(previous: ProfileChoices, command: ChoiceCommand): ProfileChoices {
  const next: ProfileChoices = { profileId: previous.profileId, mode: previous.mode, groups: previous.groups.slice() }
  if (command.action === 'mode' && command.mode) {
    const canonical: string = command.mode.toLowerCase()
    if (['rule', 'global', 'direct'].includes(canonical)) next.mode = canonical
  }
  if (command.action === 'select' && command.group && command.outbound) {
    next.groups = next.groups.filter((item: GroupChoice) => item.group !== command.group)
    next.groups.push({ group: command.group, outbound: command.outbound })
  }
  return next
}

function collectChoiceModes(rules: Record<string, Object>[], modes: string[]): void {
  for (const rule of rules) {
    if (typeof rule.clash_mode === 'string' && !modes.includes(rule.clash_mode)) modes.push(rule.clash_mode)
    if (Array.isArray(rule.rules)) collectChoiceModes(rule.rules as Record<string, Object>[], modes)
  }
}

// Only change the derived launch configuration, never the user's JSON file.
// Explicit selector defaults otherwise override remembered choices in this core.
// The remembered Clash mode is deliberately NOT written into
// experimental.clash_api.default_mode: the core derives its mode list from the
// routing/DNS clash_mode values plus default_mode, so overwriting default_mode
// with a remembered "direct"/"global" drops the original "Rule" entry from the
// mode list after a restart (the mode buttons disappear). The Extension
// restores the remembered mode via core.control once the core is running.
export function applyChoices(text: string, choices: ProfileChoices): string {
  const config: Record<string, Object> = JSON.parse(text) as Record<string, Object>
  const outbounds: Record<string, Object>[] = (config.outbounds || []) as Record<string, Object>[]
  for (const outbound of outbounds) {
    if (outbound.type !== 'selector' || !Array.isArray(outbound.outbounds)) continue
    const choice: GroupChoice | undefined = choices.groups.find((item: GroupChoice) => item.group === outbound.tag)
    if (choice && (outbound.outbounds as string[]).includes(choice.outbound)) outbound.default = choice.outbound
  }
  return JSON.stringify(config)
}

// The stored choice is canonical lowercase ("rule"), while an imported config may
// spell the same mode differently ("Rule"/"Global"/"Direct"). sing-box matches
// clash_mode case-insensitively, but the native bridge rejects any value that is
// not byte-identical - and a rejected mode aborts the whole tunnel start.
export function resolveClashModeSpelling(configText: string, mode: string): string {
  if (!mode) return ''
  try {
    const config: Record<string, Object> = JSON.parse(configText) as Record<string, Object>
    const modes: string[] = []
    collectChoiceModes((((config.route || {}) as Record<string, Object>).rules || []) as Record<string, Object>[], modes)
    collectChoiceModes((((config.dns || {}) as Record<string, Object>).rules || []) as Record<string, Object>[], modes)
    const experimental: Record<string, Object> = (config.experimental || {}) as Record<string, Object>
    const clash: Record<string, Object> = (experimental.clash_api || {}) as Record<string, Object>
    if (typeof clash.default_mode === 'string' && !modes.includes(clash.default_mode)) modes.push(clash.default_mode)
    const key: string = mode.toLowerCase()
    return modes.find((item: string) => item.toLowerCase() === key) || ''
  } catch (_) { return '' }
}
