import { CoreMetadataGateway } from '../core/CoreMetadataGateway'
import { common, Want } from '@kit.AbilityKit'
import { bundleManager } from '@kit.AbilityKit'
import { vpnExtension } from '@kit.NetworkKit'
import { hilog } from '@kit.PerformanceAnalysisKit'
import type { CoreInfo, CoreStatus } from '../core/CoreGateway'
import type {
  TailscaleStatusUpdate, TailscalePingResult, TaildropInbox, TaildropSendFile, TailscaleCoordinator
} from '../domain/TailscaleTypes'
import { VpnRuntimeBridgeStore } from './VpnRuntimeBridgeStore'
import { VpnRuntimeConfigStore } from './VpnRuntimeConfigStore'
import { TailscaleBridgeStore } from './TailscaleBridgeStore'
import { waitForSystemVpnBearerAbsent } from './SystemVpnStateVerifier'
import { VpnApplicationScope } from '../domain/NetworkSettings'
import {
  createRuntimeRequestId,
  createRuntimeSessionId,
  decideStaleRuntimeRecovery,
  decideVpnStartGate,
  isConfirmedRuntimeStop,
  isExactAwaitAuthorizationTicket,
  isStaleCurrentRuntimeSession,
  isStalePreviousRuntimeSession,
  isSystemLifecycleStopped,
  isRuntimeStartTicketFresh,
  isRuntimeStatusFresh,
  isRuntimeUnclaimedTicketSafeToDiscard,
  settleVpnStartRequest,
  VpnRuntimeCommand,
  VpnRuntimeResponse,
  VpnRuntimeStatus,
  VpnStartGateDecision,
  VpnStartRequestOutcome,
  VpnStartRequestState,
  SystemVpnBearerState,
  TailscaleRuntimeCommand,
  TailscaleRuntimeResponse,
  TailscaleRuntimeStatus,
  TailscaleCommandType,
  isTailscaleStatusFresh,
  TAILSCALE_COMMAND_TIMEOUT_MS,
  TAILSCALE_DOWNLOAD_TIMEOUT_MS,
  VPN_START_TICKET_EXPIRES_AFTER_MS,
  VPN_RUNTIME_PROTOCOL_CURRENT,
  VPN_SYSTEM_LIFECYCLE_STOPPED_STAGE
} from './VpnRuntimeProtocol'

function currentBundleName(): string {
  try {
    return bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT).name
  } catch (_) { return 'com.harmonynet.assistant' }
}

function vpnWant(): Want {
  return { deviceId: '', bundleName: currentBundleName(), abilityName: 'NetworkVpnExtAbility' }
}

const START_POLL_ATTEMPTS: number = 120
// HnaCoreURLTest is serialized with stop and may take up to 15 seconds. Give
// the extension enough time to finish that bounded request, stop the core and
// destroy TUN before declaring the shutdown acknowledgement missing.
const STOP_POLL_ATTEMPTS: number = 100
const MIN_STOP_ACK_POLLS_BEFORE_RECOVERY: number = 8
const URL_TEST_POLL_ATTEMPTS: number = 120
const SELECT_OUTBOUND_POLL_ATTEMPTS: number = 120
const POLL_INTERVAL_MS: number = 250
const VPN_START_REQUEST_FAILED_MESSAGE: string = 'VPN 扩展启动请求失败'
const VPN_START_REQUEST_TIMEOUT_MESSAGE: string = 'VPN 扩展启动请求超时'
const VPN_START_CANCELLED_MESSAGE: string = 'VPN 扩展启动请求已取消，未创建 TUN'
const VPN_START_ROLLED_BACK_PREFIX: string = 'VPN 启动失败且已安全回滚'

interface VpnStartRequestTracker {
  state: VpnStartRequestState
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve: () => void) => {
    setTimeout(resolve, milliseconds)
  })
}

export function isConfirmedNoTunStartupError(message: string): boolean {
  return message === VPN_START_CANCELLED_MESSAGE ||
    message.startsWith(VPN_START_ROLLED_BACK_PREFIX)
}

/**
 * UI-side orchestration only. TUN ownership and core start/stop ordering remain
 * inside NetworkVpnExtAbility. Runtime state and URLTest commands cross the
 * process boundary through small atomic files in the private application
 * sandbox. No subscription URL, node secret or config JSON is placed in Want
 * parameters or runtime status files.
 */
export class ConnectionCoordinator implements TailscaleCoordinator {
  private gateway: CoreMetadataGateway
  private configStore: VpnRuntimeConfigStore
  private runtimeBridge: VpnRuntimeBridgeStore
  private tailscaleBridge: TailscaleBridgeStore
  private activeSessionId: string = ''
  // URLTest and selector mutations share the Extension's single command file.
  // Serialize them here so neither request can overwrite another before the
  // Extension consumes it. disconnectTask is set synchronously and therefore
  // rejects queued/new work before it can replace a stop command.
  private runtimeCommandQueue: Promise<void> = Promise.resolve()
  private disconnectTask: Promise<CoreStatus> | null = null
  // Tailscale commands use a separate IPC channel so they never block or are
  // blocked by URLTest / select-outbound / stop commands.
  private tailscaleCommandQueue: Promise<void> = Promise.resolve()

  constructor(context: common.UIAbilityContext) {
    this.gateway = new CoreMetadataGateway()
    this.configStore = new VpnRuntimeConfigStore(context.filesDir)
    this.runtimeBridge = new VpnRuntimeBridgeStore(context.filesDir)
    this.tailscaleBridge = new TailscaleBridgeStore(context.filesDir)
  }

  getInfo(): CoreInfo {
    return this.gateway.getInfo()
  }

  private emptyStatus(lastError: string = ''): CoreStatus {
    return {
      running: false,
      uploadBytes: 0,
      downloadBytes: 0,
      activeConnections: 0,
      selectedOutboundTag: '',
      version: this.gateway.getVersion(),
      lastError: lastError
    }
  }

  private mapRuntimeStatus(status: VpnRuntimeStatus): CoreStatus {
    return {
      // Freshness is validated exactly once by the caller. Rechecking the
      // clock here could cross the 8-second boundary and falsely map a live
      // session to idle while its TUN still exists.
      running: status.state === 'running',
      uploadBytes: status.uploadBytes,
      downloadBytes: status.downloadBytes,
      activeConnections: status.activeConnections,
      selectedOutboundTag: status.selectedOutboundTag,
      snapshotJson: status.snapshotJson,
      stage: status.stage,
      sessionId: status.sessionId,
      version: status.version.length > 0 ? status.version : this.gateway.getVersion(),
      lastError: status.state === 'error' ?
        (status.error.length > 0 ? status.error : 'VPN 扩展报告错误，请执行安全停止') : ''
    }
  }

  private async recoverActiveSession(): Promise<void> {
    if (this.activeSessionId.length > 0) return
    const latest: VpnRuntimeStatus | null = await this.runtimeBridge.loadLatestStatus()
    // Retain even a stale or errored unfinished session so the UI stays
    // locked and can explicitly ask the system to stop that VPN extension.
    // Treating an unreadable heartbeat as "idle" could unlock configuration
    // while an old TUN still exists.
    if (latest !== null &&
      (latest.state === 'starting' || latest.state === 'running' ||
        latest.state === 'error' ||
        (latest.state === 'stopped' && !isSystemLifecycleStopped(latest)))) {
      this.activeSessionId = latest.sessionId
    }
  }

  private async recoverStalePreviousRuntime(status: VpnRuntimeStatus,
    nowMillis: number): Promise<CoreStatus | null> {
    if (!isStalePreviousRuntimeSession(status, nowMillis)) return null

    // A protocol mismatch is an install/upgrade boundary: the current
    // Extension can never own this stale heartbeat. Ask the platform to stop
    // any remaining old lifecycle first, then wait until NetManager proves the
    // VPN bearer has disappeared before retiring the exact unchanged record
    // under the same cross-process startup lock used for session claim. If any
    // proof fails or another writer advances the record, remain fail-closed
    // instead of manufacturing an idle result.
    try {
      await vpnExtension.stopVpnExtensionAbility(vpnWant())
    } catch (_) {
      throw new Error('VPN 升级恢复无法确认系统扩展已停止')
    }
    if (!await waitForSystemVpnBearerAbsent()) {
      throw new Error('系统仍未确认旧 VPN 网络已消失，升级会话仍保持锁定')
    }
    const closed: boolean = await this.runtimeBridge.closeStalePreviousRuntimeAfterSystemStop(
      status.sessionId, status.revision, status.updatedAt, nowMillis)
    if (!closed) throw new Error('VPN 升级恢复状态已改变，请重新检查')
    this.activeSessionId = ''
    return this.emptyStatus()
  }

  async getStatus(): Promise<CoreStatus> {
    await this.recoverActiveSession()
    if (this.activeSessionId.length === 0) return this.emptyStatus()
    const status: VpnRuntimeStatus | null = await this.runtimeBridge.loadStatus(this.activeSessionId)
    if (status === null) throw new Error('VPN 运行状态暂不可读，请执行安全停止')
    const nowMillis: number = Date.now()
    const recovered: CoreStatus | null = await this.recoverStalePreviousRuntime(status, nowMillis)
    if (recovered !== null) return recovered
    if (status.state === 'starting' && status.stage === 'await-authorization' &&
      isRuntimeUnclaimedTicketSafeToDiscard(status, nowMillis)) {
      // Claim and discard both use the same cross-process OS file lock. Only
      // the winner of that locked read-check-write may advance the ticket.
      const closed: boolean = await this.runtimeBridge.closeUnclaimedStartTicket(
        status.sessionId, 'authorization-ticket-expired')
      if (closed) {
        this.activeSessionId = ''
        return this.emptyStatus()
      }
      throw new Error('VPN 授权会话状态已改变，请重新检查')
    }
    if (status.state === 'starting' && status.stage === 'await-authorization') {
      throw new Error(isRuntimeStartTicketFresh(status, nowMillis) ?
        '正在等待系统 VPN 授权' :
        '正在确认超时的 VPN 授权会话已结束')
    }
    if (!isRuntimeStatusFresh(status, nowMillis) &&
      (status.state === 'starting' || status.state === 'running')) {
      throw new Error('VPN 扩展心跳已中断，请执行安全停止')
    }
    if (status.state === 'starting') {
      throw new Error('VPN 扩展仍在启动，请等待或执行安全停止')
    }
    if (status.state === 'stopped') {
      if (isSystemLifecycleStopped(status)) {
        this.activeSessionId = ''
        return this.mapRuntimeStatus(status)
      }
      // The Extension has proved core/TUN cleanup, but its system lifecycle
      // may still be alive. Finalize it before exposing an editable idle UI.
      return await this.finishAcknowledgedDisconnect(status)
    }
    return this.mapRuntimeStatus(status)
  }

  async recoverOrphanedSession(profileId: string): Promise<boolean> {
    if (this.disconnectTask !== null) return false
    await this.recoverActiveSession()
    if (!this.activeSessionId) return false
    const status: VpnRuntimeStatus | null = await this.runtimeBridge.loadStatus(this.activeSessionId)
    if (status === null || status.state !== 'running' || Date.now() - status.updatedAt < 30000 ||
      !isStaleCurrentRuntimeSession(status, Date.now())) return false
    if (await this.configStore.loadProfileId() !== profileId) return false
    const command: VpnRuntimeCommand | null = await this.runtimeBridge.loadCommand(status.sessionId)
    if (command !== null && command.type === 'stop') return false
    if (!await waitForSystemVpnBearerAbsent()) return false
    const latest: VpnRuntimeStatus | null = await this.runtimeBridge.loadStatus(status.sessionId)
    if (latest === null || latest.revision !== status.revision || isRuntimeStatusFresh(latest, Date.now())) return false
    // Use the existing stop-command, OS stop, absent-bearer and locked CAS
    // protocol; stale UI telemetry alone never authorizes a second VPN.
    await this.disconnect()
    return true
  }

  async urlTest(nodeTag: string): Promise<number> {
    if (this.disconnectTask !== null) throw new Error('VPN 正在安全停止，不能再提交代理 URLTest')
    const task: Promise<number> = this.runtimeCommandQueue.then(() => this.performUrlTest(nodeTag))
    this.runtimeCommandQueue = task.then((): void => {}, (): void => {})
    return task
  }

  async selectOutbound(nodeTag: string): Promise<CoreStatus> {
    if (this.disconnectTask !== null) throw new Error('VPN 正在安全停止，不能再切换节点')
    const task: Promise<CoreStatus> = this.runtimeCommandQueue.then(() =>
      this.performSelectOutbound(nodeTag))
    this.runtimeCommandQueue = task.then((): void => {}, (): void => {})
    return task
  }

  async control(payload: string): Promise<void> {
    if (this.disconnectTask !== null) throw new Error('VPN 正在停止')
    const task: Promise<void> = this.runtimeCommandQueue.then(() => this.performControl(payload))
    this.runtimeCommandQueue = task.then((): void => {}, (): void => {})
    return task
  }

  private async performControl(payload: string): Promise<void> {
    if (this.disconnectTask !== null) throw new Error('VPN 正在停止')
    await this.recoverActiveSession()
    const sessionId: string = this.activeSessionId
    const status: VpnRuntimeStatus | null = await this.runtimeBridge.loadStatus(sessionId)
    if (!status || status.state !== 'running' || !isRuntimeStatusFresh(status, Date.now())) throw new Error('请先连接')
    const requestId: string = createRuntimeRequestId(Date.now(), Math.random())
    if (this.disconnectTask !== null) throw new Error('VPN 正在停止')
    await this.runtimeBridge.writeCommand({ sessionId: sessionId, requestId: requestId,
      type: 'control', nodeTag: payload, createdAt: Date.now() })
    for (let attempt: number = 0; attempt < 120; attempt++) {
      if (this.disconnectTask !== null) throw new Error('VPN 正在停止')
      const current: VpnRuntimeStatus | null = await this.runtimeBridge.loadStatus(sessionId)
      if (!current || current.state !== 'running' || !isRuntimeStatusFresh(current, Date.now())) throw new Error('运行会话已结束')
      const response: VpnRuntimeResponse | null = await this.runtimeBridge.loadResponse(sessionId, requestId)
      if (response) { if (!response.success) throw new Error(response.error); return }
      await delay(POLL_INTERVAL_MS)
    }
    throw new Error('内核命令超时')
  }

  private async performSelectOutbound(nodeTag: string): Promise<CoreStatus> {
    if (this.disconnectTask !== null) throw new Error('VPN 正在安全停止，不能再切换节点')
    if (nodeTag.length === 0) throw new Error('尚未选择切换节点')
    await this.recoverActiveSession()
    if (this.activeSessionId.length === 0) throw new Error('请先连接 VPN，再切换节点')
    const sessionId: string = this.activeSessionId
    const status: VpnRuntimeStatus | null = await this.runtimeBridge.loadStatus(sessionId)
    if (status === null || status.state !== 'running' || !isRuntimeStatusFresh(status, Date.now())) {
      throw new Error('请先连接 VPN，再切换节点')
    }

    const requestId: string = createRuntimeRequestId(Date.now(), Math.random())
    const command: VpnRuntimeCommand = {
      sessionId: sessionId,
      requestId: requestId,
      type: 'select-outbound',
      nodeTag: nodeTag,
      createdAt: Date.now()
    }
    if (this.disconnectTask !== null) throw new Error('VPN 正在安全停止，不能再切换节点')
    await this.runtimeBridge.writeCommand(command)

    for (let attempt: number = 0; attempt < SELECT_OUTBOUND_POLL_ATTEMPTS; attempt++) {
      const response: VpnRuntimeResponse | null = await this.runtimeBridge.loadResponse(sessionId, requestId)
      if (response !== null) {
        if (this.disconnectTask !== null) throw new Error('VPN 正在安全停止，节点切换结果已作废')
        if (!response.success) {
          throw new Error(response.error.length > 0 ? response.error : '代理节点切换失败')
        }
        if (response.selectedOutboundTag.length === 0) {
          throw new Error('代理核心未返回实际选中节点')
        }
        const selectedStatus: VpnRuntimeStatus | null = await this.runtimeBridge.loadStatus(sessionId)
        if (selectedStatus === null || selectedStatus.state !== 'running' ||
          !isRuntimeStatusFresh(selectedStatus, Date.now()) ||
          selectedStatus.selectedOutboundTag !== response.selectedOutboundTag) {
          throw new Error('代理节点已切换，但运行状态读回未确认')
        }
        return this.mapRuntimeStatus(selectedStatus)
      }
      const current: VpnRuntimeStatus | null = await this.runtimeBridge.loadStatus(sessionId)
      if (current === null || current.state !== 'running' || !isRuntimeStatusFresh(current, Date.now())) {
        throw new Error('VPN 连接已停止，无法完成节点切换')
      }
      await delay(POLL_INTERVAL_MS)
    }
    throw new Error('代理节点切换超时')
  }

  private async performUrlTest(nodeTag: string): Promise<number> {
    if (this.disconnectTask !== null) throw new Error('VPN 正在安全停止，不能再提交代理 URLTest')
    if (nodeTag.length === 0) throw new Error('尚未选择测速节点')
    await this.recoverActiveSession()
    if (this.activeSessionId.length === 0) throw new Error('请先连接 VPN，再进行代理 URLTest')
    const sessionId: string = this.activeSessionId
    const status: VpnRuntimeStatus | null = await this.runtimeBridge.loadStatus(sessionId)
    if (status === null || status.state !== 'running' || !isRuntimeStatusFresh(status, Date.now())) {
      throw new Error('请先连接 VPN，再进行代理 URLTest')
    }

    const requestId: string = createRuntimeRequestId(Date.now(), Math.random())
    const command: VpnRuntimeCommand = {
      sessionId: sessionId,
      requestId: requestId,
      type: 'url-test',
      nodeTag: nodeTag,
      createdAt: Date.now()
    }
    // A queued URLTest may have reached this point while disconnect() was
    // preparing the stop request. Recheck immediately before the serialized
    // bridge write so a later URLTest can never overwrite the stop command.
    if (this.disconnectTask !== null) throw new Error('VPN 正在安全停止，不能再提交代理 URLTest')
    await this.runtimeBridge.writeCommand(command)

    for (let attempt: number = 0; attempt < URL_TEST_POLL_ATTEMPTS; attempt++) {
      // disconnect() installs disconnectTask synchronously before its first
      // bridge write completes. Stop waiting immediately so a UI batch cannot
      // submit any following node while the Extension gives the in-flight
      // native URLTest a bounded chance to return and consume the stop command.
      if (this.disconnectTask !== null) {
        throw new Error('VPN 正在安全停止，代理 URLTest 结果已作废')
      }
      const response: VpnRuntimeResponse | null = await this.runtimeBridge.loadResponse(sessionId, requestId)
      if (response !== null) {
        if (this.disconnectTask !== null) throw new Error('VPN 正在安全停止，代理 URLTest 结果已作废')
        if (response.success) return response.latencyMs
        throw new Error(response.error.length > 0 ? response.error : '代理 URLTest 失败')
      }
      const current: VpnRuntimeStatus | null = await this.runtimeBridge.loadStatus(sessionId)
      if (current === null || current.state !== 'running' || !isRuntimeStatusFresh(current, Date.now())) {
        throw new Error('VPN 连接已停止，无法完成代理 URLTest')
      }
      await delay(POLL_INTERVAL_MS)
    }
    throw new Error('代理 URLTest 超时')
  }

  private async requestVpnExtensionStart(sessionId: string): Promise<void> {
    const tracker: VpnStartRequestTracker = { state: 'pending' }
    let platformSettlement: Promise<void>
    try {
      // On API 26 an already trusted application is started without showing a
      // second authorization dialog. The fulfilled platform Promise is the
      // authoritative acceptance signal for both first authorization and the
      // already-authorized path. Do not create VpnObserver here: it is not a
      // prerequisite for start and some API 26 Beta2 builds crash in its NAPI
      // constructor before the UI can observe the accepted start request.
      const request: Promise<void> = vpnExtension.startVpnExtensionAbility(vpnWant())
      platformSettlement = settleVpnStartRequest(request).then((outcome: VpnStartRequestOutcome): void => {
        tracker.state = outcome
      })
    } catch (_) {
      // This also normalizes a synchronous platform throw. The caller will
      // close only a still-unclaimed start ticket through the locked CAS.
      throw new Error(VPN_START_REQUEST_FAILED_MESSAGE)
    }

    const deadlineAt: number = Date.now() + VPN_START_TICKET_EXPIRES_AFTER_MS
    while (true) {
      const status: VpnRuntimeStatus | null = await this.runtimeBridge.loadStatus(sessionId)
      const deadlineReached: boolean = Date.now() >= deadlineAt
      const platformState: VpnStartRequestState = tracker.state
      const decision: VpnStartGateDecision = decideVpnStartGate(
        platformState, status, deadlineReached)
      if (decision === 'continue-runtime') return
      if (decision === 'cancel-unclaimed') {
        throw new Error(platformState === 'rejected' ?
          VPN_START_REQUEST_FAILED_MESSAGE : VPN_START_REQUEST_TIMEOUT_MESSAGE)
      }
      // Poll the cross-process claim while also waking immediately when the
      // platform Promise settles. A fulfilled Promise needs no observer, and a
      // claimed ticket wins over a delayed rejection or a wall-clock deadline.
      await Promise.race([platformSettlement, delay(POLL_INTERVAL_MS)])
    }
  }

  private async closeProvenUnclaimedStartTicket(sessionId: string,
    stage: string): Promise<boolean> {
    // Both this close and Extension claim are serialized by the same OS file
    // lock inside VpnRuntimeBridgeStore; this is a real cross-process CAS.
    const closed: boolean = await this.runtimeBridge.closeUnclaimedStartTicket(sessionId, stage)
    if (closed) this.activeSessionId = ''
    return closed
  }

  private async waitUntilRunning(sessionId: string): Promise<CoreStatus> {
    for (let attempt: number = 0; attempt < START_POLL_ATTEMPTS; attempt++) {
      const status: VpnRuntimeStatus | null = await this.runtimeBridge.loadStatus(sessionId)
      if (status !== null) {
        if (status.state === 'running' && isRuntimeStatusFresh(status, Date.now())) {
          return this.mapRuntimeStatus(status)
        }
        if (status.state === 'error') {
          throw new Error(status.error.length > 0 ? status.error : 'VPN 代理核心启动失败')
        }
        if (status.state === 'stopped') {
          const detail: string = status.error.length > 0 ? status.error : 'VPN 扩展在启动完成前已停止'
          throw new Error(`${VPN_START_ROLLED_BACK_PREFIX}：${detail}`)
        }
        if (status.state === 'starting' && status.stage === 'await-authorization') {
          if (!isRuntimeStartTicketFresh(status, Date.now())) {
            throw new Error('VPN 授权会话已过期')
          }
          await delay(POLL_INTERVAL_MS)
          continue
        }
        if (!isRuntimeStatusFresh(status, Date.now())) {
          throw new Error('VPN 扩展启动心跳已中断')
        }
      }
      await delay(POLL_INTERVAL_MS)
    }
    throw new Error('VPN 扩展已启动，但代理核心未进入运行状态')
  }

  async connect(configJson: string, applicationScope: VpnApplicationScope, profileId: string = 'legacy-default'): Promise<CoreStatus> {
    const coreInfo: CoreInfo = this.gateway.getInfo()
    if (!coreInfo.available) throw new Error(coreInfo.reason)
    await this.recoverActiveSession()
    if (this.activeSessionId.length > 0) {
      throw new Error('已有 VPN 会话尚未安全停止')
    }
    // Do not initialize or validate libbox in the UI process here. The VPN
    // extension must call protectProcessNet() before any core work that could
    // create a socket, then creates the TUN, validates, and starts in order.
    const sessionId: string = createRuntimeSessionId(Date.now(), Math.random())
    await this.runtimeBridge.publishStartTicket({
      protocolGeneration: VPN_RUNTIME_PROTOCOL_CURRENT,
      revision: 0,
      sessionId: sessionId,
      state: 'starting',
      stage: 'await-authorization',
      version: coreInfo.version,
      error: '',
      uploadBytes: 0,
      downloadBytes: 0,
      activeConnections: 0,
      selectedOutboundTag: '',
      updatedAt: Date.now()
    }, async (): Promise<void> => {
      await this.configStore.save(configJson, applicationScope, profileId)
    })
    this.activeSessionId = sessionId
    try {
      await this.requestVpnExtensionStart(sessionId)
      // Do not refresh or overwrite the ticket from the UI after the start
      // request. The Extension owns the next transition via claim-session.
      return await this.waitUntilRunning(sessionId)
    } catch (error) {
      let startupError: Error = error instanceof Error ? error : new Error('VPN 连接失败')
      let message: string = startupError.message

      // Close the exact UI-owned ticket before asking the system to stop. This
      // locked CAS is the claim/timeout arbitration point: if it succeeds, a
      // late Extension cannot claim or create a TUN; if it loses, runtime owns
      // the session and a delayed Promise rejection must not stop it.
      let closeChecked: boolean = false
      let closedUnclaimed: boolean = false
      try {
        closedUnclaimed = await this.closeProvenUnclaimedStartTicket(
          sessionId, message === VPN_START_REQUEST_TIMEOUT_MESSAGE ?
            'start-request-timeout' : 'startup-aborted-unclaimed')
        closeChecked = true
      } catch (_) {
        // A bridge I/O or lock failure cannot prove either ownership outcome.
      }

      if (closedUnclaimed) {
        // No Extension can advance this ticket after the successful CAS. The
        // best-effort system stop only dismisses a pending lifecycle request;
        // idle is already proven by the bridge transition.
        try {
          await vpnExtension.stopVpnExtensionAbility(vpnWant())
        } catch (_) {
          // The stopped ticket remains authoritative: claimFreshStartTicket()
          // re-reads it under the same lock and therefore cannot create TUN.
        }
        throw new Error(VPN_START_CANCELLED_MESSAGE)
      }

      // A false CAS result means the Extension claimed or otherwise advanced
      // the ticket. Let that runtime outcome win over a delayed platform
      // rejection/deadline. Only an actual runtime startup failure below may
      // trigger a system stop.
      if (closeChecked && (message === VPN_START_REQUEST_FAILED_MESSAGE ||
        message === VPN_START_REQUEST_TIMEOUT_MESSAGE)) {
        try {
          return await this.waitUntilRunning(sessionId)
        } catch (runtimeError) {
          startupError = runtimeError instanceof Error ? runtimeError : startupError
          message = startupError.message
        }
      }

      // A claimed Extension that failed during protect/TUN/core startup must
      // use the same command -> cleanup acknowledgement -> system lifecycle
      // stop ordering as an explicit disconnect. This is immediate when the
      // startup rollback already published stopped, and remains fail-closed
      // when cleanup could not be confirmed.
      try {
        await this.disconnect()
      } catch (_) {
        // Preserve the original startup/runtime error.
      }
      // Do not forge stopped after an Extension has claimed the session. Only
      // the Extension may acknowledge core.stop() and TUN destroy.
      throw startupError
    }
  }

  disconnect(): Promise<CoreStatus> {
    if (this.disconnectTask !== null) return this.disconnectTask
    const task: Promise<CoreStatus> = this.performDisconnect()
    this.disconnectTask = task
    task.then((): void => {
      if (this.disconnectTask === task) this.disconnectTask = null
    }).catch((): void => {
      if (this.disconnectTask === task) this.disconnectTask = null
    })
    return task
  }

  private async finishAcknowledgedDisconnect(status: VpnRuntimeStatus): Promise<CoreStatus> {
    // The Extension has already stopped sing-box, destroyed TUN and published
    // this same-session acknowledgement. Only now is it safe to ask the
    // system to finish the Extension lifecycle. A platform failure is exposed
    // for retry; it can no longer leave a live VPN because cleanup is proven.
    try {
      await vpnExtension.stopVpnExtensionAbility(vpnWant())
    } catch (error) {
      // Cleanup is already proven, but a failed lifecycle stop still needs to
      // remain visible so a later disconnect can retry the system operation.
      throw error
    }
    const finalizedStatus: VpnRuntimeStatus = {
      protocolGeneration: status.protocolGeneration,
      revision: status.revision,
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
    // Persist the lifecycle acknowledgement so a UI process restart can
    // distinguish a fully finalized session from Extension-only cleanup.
    await this.runtimeBridge.publishStatus(finalizedStatus)
    this.activeSessionId = ''
    return this.mapRuntimeStatus(finalizedStatus)
  }

  private async recoverStaleCurrentRuntimeAfterStop(status: VpnRuntimeStatus,
    nowMillis: number): Promise<CoreStatus | null> {
    if (!isStaleCurrentRuntimeSession(status, nowMillis)) return null

    // This path is reached only after the same-session stop command had a
    // chance to produce its normal cleanup acknowledgement. A stale heartbeat
    // alone is not proof of idle: first obtain the platform lifecycle-stop
    // acknowledgement, then verify the complete NetManager inventory.
    let lifecycleStopAcknowledged: boolean = false
    try {
      await vpnExtension.stopVpnExtensionAbility(vpnWant())
      lifecycleStopAcknowledged = true
    } catch (_) {
      throw new Error('VPN 恢复停止未获得系统扩展生命周期确认，会话仍保持锁定')
    }

    const bearerAbsent: boolean = await waitForSystemVpnBearerAbsent()
    const bearerState: SystemVpnBearerState = bearerAbsent ? 'absent' : 'unknown'
    if (decideStaleRuntimeRecovery(status, nowMillis,
      lifecycleStopAcknowledged, bearerState) !== 'recover') {
      throw new Error('系统仍未确认 VPN 网络已消失，未清除运行会话')
    }

    const closed: boolean = await this.runtimeBridge.closeStaleCurrentRuntimeAfterSystemStop(
      status.sessionId, status.revision, status.updatedAt, Date.now())
    if (!closed) {
      throw new Error('VPN 恢复停止期间会话已变化，未覆盖新状态')
    }
    this.activeSessionId = ''
    return this.emptyStatus()
  }

  private async performDisconnect(): Promise<CoreStatus> {
    await this.recoverActiveSession()
    const sessionId: string = this.activeSessionId
    if (sessionId.length === 0) {
      throw new Error('无法取得当前 VPN 会话，未执行未经确认的系统停止')
    }

    let initialStatus: VpnRuntimeStatus | null = await this.runtimeBridge.loadStatus(sessionId)
    if (initialStatus === null) {
      throw new Error('无法读取当前 VPN 会话，未执行未经确认的系统停止')
    }
    if (isConfirmedRuntimeStop(initialStatus, sessionId)) {
      return await this.finishAcknowledgedDisconnect(initialStatus)
    }

    const recovered: CoreStatus | null = await this.recoverStalePreviousRuntime(initialStatus, Date.now())
    if (recovered !== null) return recovered

    // A still-unclaimed authorization ticket owns no TUN. Close it through
    // the same cross-process CAS used by Extension claim, then dismiss the
    // pending lifecycle request. If claim won, continue with the runtime stop
    // command for that exact session.
    if (isExactAwaitAuthorizationTicket(initialStatus)) {
      const closed: boolean = await this.runtimeBridge.closeUnclaimedStartTicket(
        sessionId, 'user-cancelled-unclaimed')
      if (closed) {
        try {
          await vpnExtension.stopVpnExtensionAbility(vpnWant())
        } catch (_) {
          // The locked stopped ticket proves that no Extension can claim or
          // create TUN, so a lifecycle dismissal failure cannot forge a VPN.
        }
        this.activeSessionId = ''
        return this.emptyStatus()
      }
      initialStatus = await this.runtimeBridge.loadStatus(sessionId)
      if (initialStatus === null) {
        throw new Error('VPN 会话在授权交接时不可读，未执行未经确认的系统停止')
      }
      if (isConfirmedRuntimeStop(initialStatus, sessionId)) {
        return await this.finishAcknowledgedDisconnect(initialStatus)
      }
    }

    const requestId: string = createRuntimeRequestId(Date.now(), Math.random())
    const stopCommand: VpnRuntimeCommand = {
      sessionId: sessionId,
      requestId: requestId,
      type: 'stop',
      nodeTag: '',
      createdAt: Date.now()
    }
    await this.runtimeBridge.writeCommand(stopCommand)

    for (let attempt: number = 0; attempt < STOP_POLL_ATTEMPTS; attempt++) {
      const latest: VpnRuntimeStatus | null = await this.runtimeBridge.loadLatestStatus()
      if (isConfirmedRuntimeStop(latest, sessionId)) {
        return await this.finishAcknowledgedDisconnect(latest as VpnRuntimeStatus)
      }
      if (latest !== null && latest.sessionId !== sessionId) {
        throw new Error('VPN 停止确认属于其他会话，当前会话保持锁定')
      }
      // Ignore a cleanup-failed record that predates this retry command; the
      // live Extension still needs a polling interval to consume the new
      // request. A post-command cleanup-failed write is an authoritative
      // failure for this attempt and remains locked for another retry.
      if (latest !== null && latest.updatedAt >= stopCommand.createdAt &&
        latest.state === 'error' && latest.stage === 'cleanup-failed') {
        throw new Error(latest.error.length > 0 ? latest.error : 'VPN 清理尚未确认，请再次执行安全停止')
      }
      // Heartbeats are independent from URLTest/core locks. Two seconds of
      // normal command polling followed by a stale current-protocol status is
      // therefore enough to enter the separately verified system recovery
      // path instead of making every orphan wait the full command timeout.
      if (attempt + 1 >= MIN_STOP_ACK_POLLS_BEFORE_RECOVERY && latest !== null &&
        isStaleCurrentRuntimeSession(latest, Date.now())) {
        break
      }
      await delay(POLL_INTERVAL_MS)
    }

    // One final read closes the boundary where the acknowledgement is written
    // during the last poll delay. Without it, a proven stop could be reported
    // as a timeout for another user action cycle.
    const finalStatus: VpnRuntimeStatus | null = await this.runtimeBridge.loadLatestStatus()
    if (isConfirmedRuntimeStop(finalStatus, sessionId)) {
      return await this.finishAcknowledgedDisconnect(finalStatus as VpnRuntimeStatus)
    }
    if (finalStatus !== null && finalStatus.sessionId === sessionId) {
      const recoveredCurrent: CoreStatus | null =
        await this.recoverStaleCurrentRuntimeAfterStop(finalStatus, Date.now())
      if (recoveredCurrent !== null) return recoveredCurrent
    }
    // Fail closed: never call stopVpnExtensionAbility without a same-session
    // cleanup acknowledgement. Keep activeSessionId locked so another tap can
    // submit a fresh, deduplicated stop request to the still-live Extension.
    throw new Error('VPN 停止命令已超时，未收到核心停止与 TUN 销毁确认；会话仍保持锁定')
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Tailscale operations — use a separate IPC channel (TailscaleBridgeStore)
  // so they never block or are blocked by main VPN commands.
  // ───────────────────────────────────────────────────────────────────────────

  private async sendTailscaleCommand(type: TailscaleCommandType, payloadJson: string,
    timeoutMs: number = TAILSCALE_COMMAND_TIMEOUT_MS): Promise<string> {
    const sessionId: string = this.activeSessionId
    if (sessionId.length === 0) throw new Error('VPN 未运行，Tailscale 不可用')

    const requestId: string = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const task: Promise<string> = this.tailscaleCommandQueue.then(async () => {
      if (this.activeSessionId !== sessionId || this.disconnectTask !== null) {
        throw new Error('VPN 会话已改变，Tailscale 请求已取消')
      }
      const command: TailscaleRuntimeCommand = {
        sessionId, requestId, type, payloadJson, createdAt: Date.now()
      }
      await this.tailscaleBridge.writeCommand(command)
      const deadline: number = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await delay(200)
        const response: TailscaleRuntimeResponse | null =
          await this.tailscaleBridge.loadResponse(sessionId, requestId)
        if (response !== null) {
          if (!response.success) throw new Error(response.error)
          return response.payloadJson
        }
      }
      throw new Error('Tailscale 命令超时')
    })
    this.tailscaleCommandQueue = task.then(() => {}, () => {})
    return task
  }

  /**
   * Cheap status read: the VPN extension republishes the snapshot on every
   * heartbeat (~1s), so a fresh file needs no round-trip. Only fall back to the
   * command channel when the heartbeat is stale (for example right after the
   * user completes browser-based login), and to the file once more if the
   * command channel is unavailable.
   */
  async tailscaleStatus(): Promise<TailscaleStatusUpdate> {
    const sessionId: string = this.activeSessionId
    if (sessionId.length === 0) return { endpoints: [] }

    const cached: TailscaleRuntimeStatus | null = await this.tailscaleBridge.loadStatus()
    const cachedUpdate: TailscaleStatusUpdate | null = this.parseTailscaleStatus(cached, sessionId)
    if (cachedUpdate !== null && cached !== null && isTailscaleStatusFresh(cached, Date.now())) {
      return cachedUpdate
    }

    try {
      const result: string = await this.sendTailscaleCommand('tailscale-status', '{}')
      if (result.length > 0) {
        return JSON.parse(result) as TailscaleStatusUpdate
      }
    } catch (err) {
      hilog.warn(0xA00000, 'TailscaleCoordinator',
        `tailscaleStatus: command channel failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    return cachedUpdate !== null ? cachedUpdate : { endpoints: [] }
  }

  private parseTailscaleStatus(status: TailscaleRuntimeStatus | null,
    sessionId: string): TailscaleStatusUpdate | null {
    if (status === null || status.sessionId !== sessionId || status.statusJson.length === 0) {
      return null
    }
    try {
      return JSON.parse(status.statusJson) as TailscaleStatusUpdate
    } catch (_) {
      return null
    }
  }

  async tailscaleSetExitNode(endpointTag: string, stableID: string): Promise<void> {
    await this.sendTailscaleCommand('tailscale-set-exit-node',
      JSON.stringify({ endpointTag, stableID }))
  }

  async tailscaleLogout(endpointTag: string): Promise<void> {
    await this.sendTailscaleCommand('tailscale-logout',
      JSON.stringify({ endpointTag }))
  }

  async tailscalePing(endpointTag: string, peerIP: string): Promise<TailscalePingResult[]> {
    const result: string = await this.sendTailscaleCommand('tailscale-ping',
      JSON.stringify({ endpointTag, peerIP }))
    try {
      return JSON.parse(result) as TailscalePingResult[]
    } catch (_) {
      return []
    }
  }

  async taildropSubscribe(endpointTag: string): Promise<void> {
    await this.sendTailscaleCommand('taildrop-subscribe',
      JSON.stringify({ endpointTag }))
  }

  async taildropInbox(endpointTag: string): Promise<TaildropInbox> {
    const result: string = await this.sendTailscaleCommand('taildrop-inbox',
      JSON.stringify({ endpointTag }))
    try {
      return JSON.parse(result) as TaildropInbox
    } catch (_) {
      return { endpointTag, files: [], receiving: [] }
    }
  }

  async taildropDownload(endpointTag: string, name: string): Promise<void> {
    // The destination is chosen by the VPN extension (its own sandbox), so the
    // remote-controlled file name never becomes a path in the UI process.
    await this.sendTailscaleCommand('taildrop-download',
      JSON.stringify({ endpointTag, name }), TAILSCALE_DOWNLOAD_TIMEOUT_MS)
  }

  async taildropDelete(endpointTag: string, name: string): Promise<void> {
    await this.sendTailscaleCommand('taildrop-delete',
      JSON.stringify({ endpointTag, name }))
  }

  async taildropMarkRead(endpointTag: string): Promise<void> {
    await this.sendTailscaleCommand('taildrop-mark-read',
      JSON.stringify({ endpointTag }))
  }

  async taildropCancelReceive(endpointTag: string, senderID: string, name: string): Promise<void> {
    await this.sendTailscaleCommand('taildrop-cancel-receive',
      JSON.stringify({ endpointTag, senderID, name }))
  }

  async taildropSend(endpointTag: string, peerStableID: string,
    files: TaildropSendFile[]): Promise<void> {
    // Taildrop 文件发送需要原生桥接扩展（taildrop-send 命令），
    // 当前原生层尚未实现该命令，此处抛出错误以提示用户。
    throw new Error('文件发送功能暂不可用（需要原生桥接扩展支持）')
  }
}
