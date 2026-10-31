import { fileIo } from '@kit.CoreFileKit'
import {
  TailscaleRuntimeCommand,
  TailscaleRuntimeResponse,
  TailscaleRuntimeStatus,
  TailscaleCommandType
} from './VpnRuntimeProtocol'
import { writeAtomicText } from './AtomicFileWriter'

const RUNTIME_DIRECTORY: string = 'runtime'
const TAILSCALE_STATUS_FILE: string = 'tailscale-status.json'
const TAILSCALE_COMMAND_FILE: string = 'tailscale-command.json'
const TAILSCALE_RESPONSE_FILE: string = 'tailscale-response.json'
const MAX_TAILSCALE_FILE_BYTES: number = 512 * 1024

/**
 * File-based IPC store for Tailscale operations, separate from the main
 * VpnRuntimeBridgeStore command channel. This ensures Tailscale commands
 * (status polling, exit node selection, taildrop) never block or are blocked
 * by URLTest / select-outbound / stop commands.
 *
 * Both the UI process and the VPN extension process share the same filesDir,
 * so they communicate through atomic file writes in the private sandbox.
 */
export class TailscaleBridgeStore {
  private runtimeDirectory: string
  private statusPath: string
  private commandPath: string
  private responsePath: string
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(filesDir: string) {
    this.runtimeDirectory = `${filesDir}/${RUNTIME_DIRECTORY}`
    this.statusPath = `${this.runtimeDirectory}/${TAILSCALE_STATUS_FILE}`
    this.commandPath = `${this.runtimeDirectory}/${TAILSCALE_COMMAND_FILE}`
    this.responsePath = `${this.runtimeDirectory}/${TAILSCALE_RESPONSE_FILE}`
  }

  private async ensureDirectory(): Promise<void> {
    try {
      const exists: boolean = await fileIo.access(this.runtimeDirectory)
      if (!exists) await fileIo.mkdir(this.runtimeDirectory, true)
    } catch (error) {
      throw error
    }
  }

  private async writeAtomicNow(path: string, serialized: string): Promise<void> {
    if (serialized.length > MAX_TAILSCALE_FILE_BYTES) throw new Error('Tailscale IPC 文件超过安全上限')
    await this.ensureDirectory()
    await writeAtomicText(path, serialized)
  }

  private writeAtomic(path: string, serialized: string): Promise<void> {
    const task: Promise<void> = this.writeQueue.then(() => this.writeAtomicNow(path, serialized))
    this.writeQueue = task.catch(() => {})
    return task
  }

  private async readJson<T>(path: string): Promise<T | null> {
    let serialized: string
    try {
      const exists: boolean = await fileIo.access(path)
      if (!exists) return null
      serialized = await fileIo.readText(path)
    } catch (error) {
      throw error
    }
    if (serialized.length === 0 || serialized.length > MAX_TAILSCALE_FILE_BYTES) return null
    try {
      return JSON.parse(serialized) as T
    } catch (_) {
      return null
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Status — written by VPN extension, read by UI
  // ───────────────────────────────────────────────────────────────────────────

  async writeStatus(status: TailscaleRuntimeStatus): Promise<void> {
    await this.writeAtomic(this.statusPath, JSON.stringify(status))
  }

  async loadStatus(): Promise<TailscaleRuntimeStatus | null> {
    const status: TailscaleRuntimeStatus | null = await this.readJson<TailscaleRuntimeStatus>(this.statusPath)
    if (!status || typeof status.sessionId !== 'string' ||
      typeof status.statusJson !== 'string' || typeof status.updatedAt !== 'number') {
      return null
    }
    return status
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Command — written by UI, read by VPN extension
  // ───────────────────────────────────────────────────────────────────────────

  writeCommand(command: TailscaleRuntimeCommand): Promise<void> {
    return this.writeAtomic(this.commandPath, JSON.stringify(command))
  }

  async loadCommand(sessionId: string): Promise<TailscaleRuntimeCommand | null> {
    const command: TailscaleRuntimeCommand | null = await this.readJson<TailscaleRuntimeCommand>(this.commandPath)
    if (!command || sessionId.length === 0 || command.sessionId !== sessionId) return null
    const validTypes: TailscaleCommandType[] = [
      'tailscale-status', 'tailscale-set-exit-node', 'tailscale-logout',
      'tailscale-ping', 'taildrop-subscribe', 'taildrop-inbox',
      'taildrop-download', 'taildrop-delete', 'taildrop-mark-read',
      'taildrop-cancel-receive'
    ]
    let typeValid: boolean = false
    for (const t of validTypes) {
      if (command.type === t) { typeValid = true; break }
    }
    if (!typeValid) return null
    if (typeof command.requestId !== 'string' || command.requestId.length === 0 ||
      typeof command.payloadJson !== 'string' || typeof command.createdAt !== 'number') {
      return null
    }
    return command
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Response — written by VPN extension, read by UI
  // ───────────────────────────────────────────────────────────────────────────

  writeResponse(response: TailscaleRuntimeResponse): Promise<void> {
    return this.writeAtomic(this.responsePath, JSON.stringify(response))
  }

  async loadResponse(sessionId: string, requestId: string): Promise<TailscaleRuntimeResponse | null> {
    const response: TailscaleRuntimeResponse | null = await this.readJson<TailscaleRuntimeResponse>(this.responsePath)
    if (!response || response.sessionId !== sessionId || response.requestId !== requestId ||
      typeof response.success !== 'boolean' || typeof response.payloadJson !== 'string' ||
      typeof response.error !== 'string' || typeof response.completedAt !== 'number') {
      return null
    }
    return response
  }
}
