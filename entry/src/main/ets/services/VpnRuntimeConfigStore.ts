import { util } from '@kit.ArkTS'
import { fileIo } from '@kit.CoreFileKit'
import { SecureFileStore } from './SecureFileStore'
import {
  normalizeVpnApplicationScope,
  VpnApplicationScope
} from '../domain/NetworkSettings'

const RUNTIME_DIRECTORY: string = 'runtime'
const LEGACY_CORE_CONFIG_FILE: string = 'sing-box.json'
const SECURE_CORE_CONFIG_FILE: string = 'sing-box.secure.json'
const MAX_CORE_CONFIG_BYTES: number = 4 * 1024 * 1024
const LEGACY_APPLICATION_SCOPE_FILE: string = 'vpn-application-scope.json'
const SECURE_APPLICATION_SCOPE_FILE: string = 'vpn-application-scope.secure.json'
const MAX_APPLICATION_SCOPE_BYTES: number = 128 * 1024

interface RuntimeConfigInbound {
  type: string
}

interface RuntimeConfigOutbound {
  type: string
}

interface RuntimeConfigShape {
  dns: Object
  inbounds: RuntimeConfigInbound[]
  outbounds: RuntimeConfigOutbound[]
  route: Object
}

function validateRuntimeConfig(configJson: string): void {
  if (configJson.trim().length === 0) throw new Error('代理配置为空')
  let decoded: RuntimeConfigShape
  try {
    decoded = JSON.parse(configJson) as RuntimeConfigShape
  } catch (_) {
    throw new Error('代理配置不是有效 JSON')
  }
  if (!decoded || !decoded.route ||
    !Array.isArray(decoded.inbounds) || decoded.inbounds.length === 0 ||
    !Array.isArray(decoded.outbounds) || decoded.outbounds.length === 0) {
    throw new Error('代理配置结构不完整')
  }
  let hasTunInbound: boolean = false
  for (let index: number = 0; index < decoded.inbounds.length; index++) {
    if (decoded.inbounds[index].type === 'tun') hasTunInbound = true
  }
  if (!hasTunInbound) throw new Error('代理配置缺少 TUN 入站')
}

function validateApplicationScope(serialized: string): void {
  let decoded: VpnApplicationScope
  try {
    decoded = JSON.parse(serialized) as VpnApplicationScope
  } catch (_) {
    throw new Error('应用接管范围不是有效 JSON')
  }
  normalizeVpnApplicationScope(decoded)
}

/**
 * Stores the active sing-box configuration inside the application sandbox.
 *
 * Callers pass only a fixed private path to the VPN extension. Subscription
 * URLs and node credentials must never be copied into Want parameters or logs.
 */
export class VpnRuntimeConfigStore {
  private runtimeDirectory: string
  private secureStore: SecureFileStore
  private applicationScopeStore: SecureFileStore
  private profileIdStore: SecureFileStore

  constructor(filesDir: string) {
    this.runtimeDirectory = `${filesDir}/${RUNTIME_DIRECTORY}`
    this.profileIdStore = new SecureFileStore(this.runtimeDirectory + '/profile-id.secure.json', this.runtimeDirectory + '/profile-id.json',
      'runtime-profile-id-v1', 4096, (text: string): void => {
        const id: string = JSON.parse(text) as string
        if (typeof id !== 'string' || id.length === 0 || id.length > 1024) throw new Error('配置标识无效')
      })
    this.secureStore = new SecureFileStore(
      `${this.runtimeDirectory}/${SECURE_CORE_CONFIG_FILE}`,
      `${this.runtimeDirectory}/${LEGACY_CORE_CONFIG_FILE}`,
      'sing-box-runtime-config',
      MAX_CORE_CONFIG_BYTES,
      validateRuntimeConfig)
    this.applicationScopeStore = new SecureFileStore(
      `${this.runtimeDirectory}/${SECURE_APPLICATION_SCOPE_FILE}`,
      `${this.runtimeDirectory}/${LEGACY_APPLICATION_SCOPE_FILE}`,
      'vpn-application-scope',
      MAX_APPLICATION_SCOPE_BYTES,
      validateApplicationScope)
  }

  private utf8ByteLength(value: string): number {
    const bytes: Uint8Array = new util.TextEncoder().encodeInto(value)
    const length: number = bytes.length
    bytes.fill(0)
    return length
  }

  private async ensureRuntimeDirectory(): Promise<void> {
    let directoryExists: boolean
    try {
      directoryExists = await fileIo.access(this.runtimeDirectory)
    } catch (error) {
      // An I/O error is not an absent directory: preserve it so callers never
      // write sensitive runtime configuration to an unverified path.
      throw error
    }
    if (!directoryExists) {
      try {
        await fileIo.mkdir(this.runtimeDirectory, true)
      } catch (error) {
        throw error
      }
    }
  }

  async load(): Promise<string> {
    await this.ensureRuntimeDirectory()
    const serialized: string | null = await this.secureStore.load()
    if (serialized === null) throw new Error('尚未生成可运行的代理配置')
    validateRuntimeConfig(serialized)
    if (this.utf8ByteLength(serialized) > MAX_CORE_CONFIG_BYTES) {
      throw new Error('代理配置超过 4 MiB 安全上限')
    }
    return serialized
  }

  async loadApplicationScope(): Promise<VpnApplicationScope> {
    await this.ensureRuntimeDirectory()
    const serialized: string | null = await this.applicationScopeStore.load()
    // Existing installations predate per-application capture and therefore
    // retain their previous all-app behaviour until the user changes it.
    if (serialized === null) return { mode: 'all', trustedApplications: [] }
    return normalizeVpnApplicationScope(JSON.parse(serialized) as VpnApplicationScope)
  }

  async loadProfileId(): Promise<string> {
    const text: string | null = await this.profileIdStore.load()
    return text === null ? 'legacy-default' : JSON.parse(text) as string
  }

  async save(configJson: string, applicationScope: VpnApplicationScope, profileId: string = 'legacy-default'): Promise<void> {
    if (!profileId || profileId.length > 1024) throw new Error('配置标识无效')
    validateRuntimeConfig(configJson)
    if (this.utf8ByteLength(configJson) > MAX_CORE_CONFIG_BYTES) {
      throw new Error('代理配置超过 4 MiB 安全上限')
    }
    const normalizedScope: VpnApplicationScope = normalizeVpnApplicationScope(applicationScope)
    await this.ensureRuntimeDirectory()
    // This is a derived launch snapshot, not the user's profile repository.
    // ConnectionCoordinator calls save inside publishStartTicket's exclusive
    // lock, after proving that the previous session has stopped and before
    // any Extension can claim the new ticket. Recreate both snapshots from
    // validated input so damaged bytes from an old launch cannot permanently
    // prevent a newly selected profile from starting. Never clear profiles or
    // HUKS keys here; SecureFileStore's authenticated user-data rules remain.
    await this.secureStore.clear()
    await this.applicationScopeStore.clear()
    await this.secureStore.save(configJson)
    await this.applicationScopeStore.save(JSON.stringify(normalizedScope))
    await this.profileIdStore.clear()
    await this.profileIdStore.save(JSON.stringify(profileId))
  }

  async clear(): Promise<void> {
    await this.profileIdStore.clear()
    await this.ensureRuntimeDirectory()
    await this.secureStore.clear()
    await this.applicationScopeStore.clear()
  }
}
