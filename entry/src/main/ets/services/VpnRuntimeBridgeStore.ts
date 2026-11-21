import { fileIo } from '@kit.CoreFileKit'
import {
  isConfirmedRuntimeStop,
  isRuntimeStartTicketFresh,
  isStaleCurrentRuntimeSession,
  isStalePreviousRuntimeSession,
  isSystemLifecycleStopped,
  normalizeRuntimeProtocolGeneration,
  VPN_RUNTIME_PROTOCOL_CURRENT,
  VPN_SYSTEM_LIFECYCLE_STOPPED_STAGE,
  VpnRuntimeCommand,
  VpnRuntimeResponse,
  VpnRuntimeStatus
} from './VpnRuntimeProtocol'
import { writeAtomicText } from './AtomicFileWriter'

const RUNTIME_DIRECTORY: string = 'runtime'
const STATUS_FILE: string = 'status.json'
const COMMAND_FILE: string = 'command.json'
const RESPONSE_FILE: string = 'response.json'
const STARTUP_LOCK_FILE: string = 'startup.lock'
const MAX_BRIDGE_FILE_BYTES: number = 512 * 1024

export interface VpnOwnerLease {
  sessionId: string
  updatedAt: number
}

export interface VpnTaskNotification {
  sessionId: string
  notificationId: number
}

export class VpnRuntimeBridgeStore {
  private runtimeDirectory: string
  private statusPath: string
  private commandPath: string
  private responsePath: string
  private startupLockPath: string
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(filesDir: string) {
    this.runtimeDirectory = `${filesDir}/${RUNTIME_DIRECTORY}`
    this.statusPath = `${this.runtimeDirectory}/${STATUS_FILE}`
    this.commandPath = `${this.runtimeDirectory}/${COMMAND_FILE}`
    this.responsePath = `${this.runtimeDirectory}/${RESPONSE_FILE}`
    this.startupLockPath = `${this.runtimeDirectory}/${STARTUP_LOCK_FILE}`
  }

  private async ensureDirectory(): Promise<void> {
    try {
      const exists: boolean = await fileIo.access(this.runtimeDirectory)
      if (!exists) await fileIo.mkdir(this.runtimeDirectory, true)
    } catch (error) {
      // Directory failures are fatal for the bridge; preserve the original
      // file-system error for the coordinator/extension to report.
      throw error
    }
  }

  private async writeAtomicNow(path: string, serialized: string): Promise<void> {
    if (serialized.length > MAX_BRIDGE_FILE_BYTES) throw new Error('VPN 运行状态文件超过安全上限')
    await this.ensureDirectory()
    await writeAtomicText(path, serialized)
  }

  private writeAtomic(path: string, serialized: string): Promise<void> {
    const task: Promise<void> = this.writeQueue.then(() => this.writeAtomicNow(path, serialized))
    this.writeQueue = task.catch(() => {
      // Keep the queue usable after a failed write; the caller still receives the failure.
    })
    return task
  }

  private async withStartupLock<T>(action: () => Promise<T>): Promise<T> {
    await this.ensureDirectory()
    let lockFile: fileIo.File | null = null
    let locked: boolean = false
    try {
      lockFile = await fileIo.open(this.startupLockPath,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE)
      await lockFile.lock(true)
      locked = true
      return await action()
    } catch (error) {
      // Lock/open/action failures are state-safety failures and must reach the
      // coordinator or Extension; never reinterpret them as an empty status.
      throw error
    } finally {
      if (lockFile !== null && locked) {
        try {
          lockFile.unlock()
        } catch (_) {
          // The protected read-check-write has already completed or failed.
        }
      }
      if (lockFile !== null) {
        try {
          await fileIo.close(lockFile)
        } catch (_) {
          // Closing the lock descriptor must not replace the operation result.
        }
      }
    }
  }

  private async readJson<T>(path: string): Promise<T | null> {
    let serialized: string
    try {
      const exists: boolean = await fileIo.access(path)
      if (!exists) return null
      serialized = await fileIo.readText(path)
    } catch (error) {
      // A real I/O failure is different from a missing/corrupt transient
      // bridge record and must reach the caller.
      throw error
    }
    if (serialized.length === 0 || serialized.length > MAX_BRIDGE_FILE_BYTES) return null
    try {
      return JSON.parse(serialized) as T
    } catch (_) {
      return null
    }
  }

  async writeOwnerLease(lease: VpnOwnerLease): Promise<void> {
    await this.withStartupLock<void>(async (): Promise<void> => {
      const current = await this.loadLatestStatus()
      if (current?.sessionId !== lease.sessionId || current.state === 'stopped') return
      await this.writeAtomicNow(this.runtimeDirectory + '/owner-lease.json', JSON.stringify(lease))
    })
  }

  loadOwnerLease(): Promise<VpnOwnerLease | null> {
    return this.readJson<VpnOwnerLease>(this.runtimeDirectory + '/owner-lease.json')
  }

  writeTaskNotification(notification: VpnTaskNotification): Promise<void> {
    return this.writeAtomic(this.runtimeDirectory + '/task-notification.json', JSON.stringify(notification))
  }

  loadTaskNotification(): Promise<VpnTaskNotification | null> {
    return this.readJson<VpnTaskNotification>(this.runtimeDirectory + '/task-notification.json')
  }

  async publishStatus(status: VpnRuntimeStatus): Promise<void> {
    // Every status mutation participates in the same cross-process lock as
    // recovery. Without this, a heartbeat could land between recovery's read
    // and write and be overwritten by a fabricated stopped record.
    await this.withStartupLock<void>(async (): Promise<void> => {
      const current: VpnRuntimeStatus | null = await this.loadLatestStatus()
      if (current === null || current.sessionId !== status.sessionId) {
        throw new Error('VPN 运行会话已改变，拒绝写入过期状态')
      }
      if ((current.state === 'stopped' && status.state !== 'stopped') ||
        (isSystemLifecycleStopped(current) &&
          status.stage !== VPN_SYSTEM_LIFECYCLE_STOPPED_STAGE)) {
        throw new Error('VPN 终止状态已确认，拒绝回退到较早生命周期')
      }
      status.revision = current.revision + 1
      await this.writeAtomicNow(this.statusPath, JSON.stringify(status))
    })
  }

  async publishStartTicket(status: VpnRuntimeStatus,
    prepareConfig: () => Promise<void>): Promise<void> {
    await this.withStartupLock<void>(async (): Promise<void> => {
      const current: VpnRuntimeStatus | null = await this.loadLatestStatus()
      if (current !== null && current.state !== 'stopped') {
        throw new Error('已有 VPN 会话尚未安全停止')
      }
      // Serialize config replacement with session creation. A second UI
      // caller cannot overwrite the winner's shared config before claim.
      await prepareConfig()
      status.revision = 1
      await this.writeAtomicNow(this.statusPath, JSON.stringify(status))
    })
  }

  async loadLatestStatus(): Promise<VpnRuntimeStatus | null> {
    const status: VpnRuntimeStatus | null = await this.readJson<VpnRuntimeStatus>(this.statusPath)
    if (!status || typeof status.sessionId !== 'string' || typeof status.state !== 'string' ||
      typeof status.stage !== 'string' || typeof status.version !== 'string' ||
      typeof status.error !== 'string' || typeof status.updatedAt !== 'number') {
      return null
    }
    const normalizedGeneration = normalizeRuntimeProtocolGeneration(
      typeof status.protocolGeneration === 'string' ? status.protocolGeneration : undefined)
    if (normalizedGeneration === null) return null
    status.protocolGeneration = normalizedGeneration
    // Pre-revision private bridge records normalize to zero. The first locked
    // write by this build advances them to revision one; zero is never reused.
    if (typeof status.revision !== 'number') status.revision = 0
    // Status files from an older installed build do not contain runtime
    // counters. Normalize those private records to zero; every new heartbeat
    // replaces them with values read from the live sing-box tracker.
    if (typeof status.uploadBytes !== 'number') status.uploadBytes = 0
    if (typeof status.downloadBytes !== 'number') status.downloadBytes = 0
    if (typeof status.activeConnections !== 'number') status.activeConnections = 0
    if (typeof status.selectedOutboundTag !== 'string') status.selectedOutboundTag = ''
    if (status.revision < 0 || status.uploadBytes < 0 || status.downloadBytes < 0 ||
      status.activeConnections < 0) return null
    return status
  }

  async loadStatus(sessionId: string): Promise<VpnRuntimeStatus | null> {
    const status: VpnRuntimeStatus | null = await this.loadLatestStatus()
    return status && status.sessionId === sessionId ? status : null
  }

  async claimFreshStartTicket(sessionId: string): Promise<VpnRuntimeStatus | null> {
    return this.withStartupLock<VpnRuntimeStatus | null>(async (): Promise<VpnRuntimeStatus | null> => {
      const ticket: VpnRuntimeStatus | null = await this.loadStatus(sessionId)
      if (ticket === null || ticket.stage !== 'await-authorization' ||
        !isRuntimeStartTicketFresh(ticket, Date.now())) {
        return null
      }
      const claimed: VpnRuntimeStatus = {
        protocolGeneration: VPN_RUNTIME_PROTOCOL_CURRENT,
        revision: ticket.revision + 1,
        sessionId: ticket.sessionId,
        state: 'starting',
        stage: 'claim-session',
        version: ticket.version,
        error: '',
        uploadBytes: 0,
        downloadBytes: 0,
        activeConnections: 0,
        selectedOutboundTag: '',
        updatedAt: Date.now()
      }
      await this.writeAtomicNow(this.statusPath, JSON.stringify(claimed))
      return claimed
    })
  }

  async closeUnclaimedStartTicket(sessionId: string, stage: string): Promise<boolean> {
    return this.withStartupLock<boolean>(async (): Promise<boolean> => {
      const ticket: VpnRuntimeStatus | null = await this.loadStatus(sessionId)
      if (ticket === null || ticket.state !== 'starting' ||
        ticket.stage !== 'await-authorization') {
        return false
      }
      const stopped: VpnRuntimeStatus = {
        protocolGeneration: VPN_RUNTIME_PROTOCOL_CURRENT,
        revision: ticket.revision + 1,
        sessionId: ticket.sessionId,
        state: 'stopped',
        stage: stage,
        version: ticket.version,
        error: '',
        uploadBytes: 0,
        downloadBytes: 0,
        activeConnections: 0,
        selectedOutboundTag: '',
        updatedAt: Date.now()
      }
      await this.writeAtomicNow(this.statusPath, JSON.stringify(stopped))
      return true
    })
  }

  /**
   * Retires only a stale status owned by an older installed runtime protocol,
   * after the caller has successfully returned from
   * stopVpnExtensionAbility(). The startup lock and revision comparison make
   * this a cross-process CAS: a concurrent Extension write wins and cannot be
   * overwritten by package-upgrade recovery.
   */
  async closeStalePreviousRuntimeAfterSystemStop(sessionId: string,
    expectedRevision: number, expectedUpdatedAt: number, nowMillis: number): Promise<boolean> {
    return this.withStartupLock<boolean>(async (): Promise<boolean> => {
      const status: VpnRuntimeStatus | null = await this.loadStatus(sessionId)
      if (status === null || status.revision !== expectedRevision ||
        status.updatedAt !== expectedUpdatedAt ||
        !isStalePreviousRuntimeSession(status, nowMillis)) {
        return false
      }
      const stopped: VpnRuntimeStatus = {
        protocolGeneration: VPN_RUNTIME_PROTOCOL_CURRENT,
        revision: status.revision + 1,
        sessionId: status.sessionId,
        state: 'stopped',
        // The caller has already received the platform lifecycle-stop
        // acknowledgement. Persist the final state directly so another UI
        // process cannot repeat or reinterpret this one-time migration.
        stage: VPN_SYSTEM_LIFECYCLE_STOPPED_STAGE,
        version: status.version,
        error: '',
        uploadBytes: 0,
        downloadBytes: 0,
        activeConnections: 0,
        selectedOutboundTag: '',
        updatedAt: Date.now()
      }
      await this.writeAtomicNow(this.statusPath, JSON.stringify(stopped))
      return true
    })
  }

  /**
   * Completes an explicit same-build disconnect recovery after the caller has
   * both a platform lifecycle-stop acknowledgement and authoritative proof
   * that no system VPN bearer remains. The exact revision prevents a live or
   * newly restarted Extension heartbeat from being overwritten.
   */
  async closeStaleCurrentRuntimeAfterSystemStop(sessionId: string,
    expectedRevision: number, expectedUpdatedAt: number, nowMillis: number): Promise<boolean> {
    return this.withStartupLock<boolean>(async (): Promise<boolean> => {
      const status: VpnRuntimeStatus | null = await this.loadStatus(sessionId)
      if (status === null) return false

      // The stop command may have completed while system state was being
      // verified. A same-session stopped acknowledgement is stronger than the
      // earlier stale snapshot and may be finalized directly.
      const stoppedByExtension: boolean = isConfirmedRuntimeStop(status, sessionId)
      const exactStaleOrphan: boolean = status.revision === expectedRevision &&
        status.updatedAt === expectedUpdatedAt &&
        isStaleCurrentRuntimeSession(status, nowMillis)
      if (!stoppedByExtension && !exactStaleOrphan) return false

      const finalized: VpnRuntimeStatus = {
        protocolGeneration: VPN_RUNTIME_PROTOCOL_CURRENT,
        revision: status.revision + 1,
        sessionId: status.sessionId,
        state: 'stopped',
        stage: VPN_SYSTEM_LIFECYCLE_STOPPED_STAGE,
        version: status.version,
        error: status.error,
        uploadBytes: status.uploadBytes,
        downloadBytes: status.downloadBytes,
        activeConnections: 0,
        selectedOutboundTag: status.selectedOutboundTag,
        updatedAt: Date.now()
      }
      await this.writeAtomicNow(this.statusPath, JSON.stringify(finalized))
      return true
    })
  }

  writeCommand(command: VpnRuntimeCommand): Promise<void> {
    return this.writeAtomic(this.commandPath, JSON.stringify(command))
  }

  async loadCommand(sessionId: string): Promise<VpnRuntimeCommand | null> {
    const command: VpnRuntimeCommand | null = await this.readJson<VpnRuntimeCommand>(this.commandPath)
    if (!command || sessionId.length === 0 || command.sessionId !== sessionId ||
      (command.type !== 'url-test' && command.type !== 'select-outbound' && command.type !== 'control' && command.type !== 'stop') ||
      typeof command.requestId !== 'string' || typeof command.nodeTag !== 'string' ||
      typeof command.createdAt !== 'number') {
      return null
    }
    if (command.requestId.length === 0 ||
      ((command.type === 'url-test' || command.type === 'select-outbound') && command.nodeTag.length === 0) ||
      (command.type === 'stop' && command.nodeTag.length !== 0)) {
      return null
    }
    return command
  }

  writeResponse(response: VpnRuntimeResponse): Promise<void> {
    return this.writeAtomic(this.responsePath, JSON.stringify(response))
  }

  async loadResponse(sessionId: string, requestId: string): Promise<VpnRuntimeResponse | null> {
    const response: VpnRuntimeResponse | null = await this.readJson<VpnRuntimeResponse>(this.responsePath)
    if (!response || response.sessionId !== sessionId || response.requestId !== requestId ||
      typeof response.success !== 'boolean' || typeof response.latencyMs !== 'number' ||
      typeof response.selectedOutboundTag !== 'string' ||
      typeof response.error !== 'string' || typeof response.completedAt !== 'number') {
      return null
    }
    return response
  }
}
