export type VpnRuntimeState = 'starting' | 'running' | 'stopped' | 'error'
export type VpnRuntimeProtocolGeneration = 'legacy' | 'v2' | 'v3'
export type SystemVpnBearerState = 'present' | 'absent' | 'unknown'
export type StaleRuntimeRecoveryDecision = 'recover' | 'keep-locked'

// Every status written by this build carries an explicit protocol generation.
// A status without this field was written by the pre-v2 implementation and is
// normalized to `legacy` only while it is read from the private runtime bridge.
export const VPN_RUNTIME_PROTOCOL_LEGACY: VpnRuntimeProtocolGeneration = 'legacy'
export const VPN_RUNTIME_PROTOCOL_V2: VpnRuntimeProtocolGeneration = 'v2'
// v3 adds an explicit package-upgrade recovery boundary. A v3 coordinator
// never unlocks a stale heartbeat by age alone: an older protocol needs a
// platform lifecycle stop, while a same-v3 orphan additionally needs a
// complete system network inventory with no VPN bearer.
export const VPN_RUNTIME_PROTOCOL_CURRENT: VpnRuntimeProtocolGeneration = 'v3'
export const VPN_SYSTEM_LIFECYCLE_STOPPED_STAGE: string = 'system-lifecycle-stopped'

export interface VpnRuntimeStatus {
  snapshotJson?: string
  protocolGeneration: VpnRuntimeProtocolGeneration
  // Monotonic per-session revision assigned by VpnRuntimeBridgeStore while
  // holding startup.lock. updatedAt is a freshness signal, not a CAS token:
  // two cross-process writes may share the same millisecond timestamp.
  revision: number
  sessionId: string
  state: VpnRuntimeState
  stage: string
  version: string
  error: string
  uploadBytes: number
  downloadBytes: number
  activeConnections: number
  selectedOutboundTag: string
  updatedAt: number
}

export interface VpnRuntimeCommand {
  sessionId: string
  requestId: string
  type: 'url-test' | 'select-outbound' | 'control' | 'stop'
  nodeTag: string
  createdAt: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Tailscale IPC protocol — separate channel for Tailscale operations.
// Uses dedicated files (tailscale-command.json, tailscale-response.json,
// tailscale-status.json) so Tailscale commands never block or are blocked by
// URLTest / select-outbound / stop commands in the main command channel.
// ─────────────────────────────────────────────────────────────────────────────

export type TailscaleCommandType =
  | 'tailscale-status'
  | 'tailscale-set-exit-node'
  | 'tailscale-logout'
  | 'tailscale-ping'
  | 'taildrop-subscribe'
  | 'taildrop-inbox'
  | 'taildrop-download'
  | 'taildrop-delete'
  | 'taildrop-mark-read'
  | 'taildrop-cancel-receive'

export interface TailscaleRuntimeCommand {
  sessionId: string
  requestId: string
  type: TailscaleCommandType
  payloadJson: string
  createdAt: number
}

export interface TailscaleRuntimeResponse {
  sessionId: string
  requestId: string
  success: boolean
  payloadJson: string
  error: string
  completedAt: number
}

export interface TailscaleRuntimeStatus {
  sessionId: string
  statusJson: string
  updatedAt: number
}

export type VpnRuntimeCommandDecision = 'process' | 'duplicate' | 'session-mismatch' | 'expired'

export interface VpnRuntimeResponse {
  sessionId: string
  requestId: string
  success: boolean
  latencyMs: number
  selectedOutboundTag: string
  error: string
  completedAt: number
}

export type VpnStartRequestOutcome = 'resolved' | 'rejected'
export type VpnStartRequestState = 'pending' | VpnStartRequestOutcome
export type VpnStartGateDecision = 'wait' | 'continue-runtime' | 'cancel-unclaimed'

/**
 * Converts the platform start Promise into a dependency-free outcome that can
 * be regression-tested outside HarmonyOS. A fulfilled start Promise is the
 * only signal that the system accepted the VPN start request. API 26 may not
 * show another authorization dialog for an application that is already
 * trusted, so no observer callback is required or consulted here.
 */
export async function settleVpnStartRequest(request: Promise<void>): Promise<VpnStartRequestOutcome> {
  try {
    await request
    return 'resolved'
  } catch (_) {
    return 'rejected'
  }
}

/**
 * The Extension must atomically replace the UI-owned authorization ticket
 * before it can create a TUN. Once the record leaves this exact state, runtime
 * status is more authoritative than a delayed or rejected UI-process Promise.
 */
export function isExactAwaitAuthorizationTicket(status: VpnRuntimeStatus | null): boolean {
  return status !== null && status.state === 'starting' && status.stage === 'await-authorization'
}

/**
 * Pure start-gate reducer shared by the coordinator and host-side regression
 * tests. Runtime ownership wins over a late platform rejection or deadline so
 * the UI never stops a session that the Extension has already claimed.
 */
export function decideVpnStartGate(platformState: VpnStartRequestState,
  status: VpnRuntimeStatus | null, deadlineReached: boolean): VpnStartGateDecision {
  if (status !== null && !isExactAwaitAuthorizationTicket(status)) return 'continue-runtime'
  if (platformState === 'resolved') return 'continue-runtime'
  if (platformState === 'rejected' || deadlineReached) return 'cancel-unclaimed'
  return 'wait'
}

export const VPN_STATUS_STALE_AFTER_MS: number = 8000
export const VPN_START_TICKET_EXPIRES_AFTER_MS: number = 45000
// The Extension refuses to claim a ticket after 45 seconds. The UI waits an
// additional 15-second exclusion window before treating an unchanged
// await-authorization ticket as safely abandoned, so a late claim cannot race
// with an idle transition.
export const VPN_UNCLAIMED_TICKET_SAFE_AFTER_MS: number = 60000
export const VPN_COMMAND_EXPIRES_AFTER_MS: number = 30000
export const TAILSCALE_COMMAND_EXPIRES_AFTER_MS: number = 30000
export const TAILSCALE_STATUS_STALE_AFTER_MS: number = 8000
// Upper bound for a normal tailscale/taildrop round-trip through file IPC.
export const TAILSCALE_COMMAND_TIMEOUT_MS: number = 15000
// HnaCoreTaildropDownload blocks for up to 60s inside the native layer, so the
// UI deadline must outlast that; otherwise the UI reports a timeout while the
// transfer is still running and the next command overwrites the request file.
export const TAILSCALE_DOWNLOAD_TIMEOUT_MS: number = 70000

export function matchesRuntimeSession(status: VpnRuntimeStatus, sessionId: string): boolean {
  return sessionId.length > 0 && status.sessionId === sessionId
}

export function isRuntimeStatusFresh(status: VpnRuntimeStatus, nowMillis: number): boolean {
  const age: number = nowMillis - status.updatedAt
  return age >= -5000 && age <= VPN_STATUS_STALE_AFTER_MS
}

export function normalizeRuntimeProtocolGeneration(value: string | undefined):
  VpnRuntimeProtocolGeneration | null {
  if (value === undefined) return VPN_RUNTIME_PROTOCOL_LEGACY
  if (value === VPN_RUNTIME_PROTOCOL_LEGACY || value === VPN_RUNTIME_PROTOCOL_V2 ||
    value === VPN_RUNTIME_PROTOCOL_CURRENT) return value
  return null
}

/**
 * Package replacement stops the previously installed Extension/TUN but does
 * not delete its private heartbeat. Protocol mismatch proves that this record
 * cannot be owned by the current Extension binary. The caller must still
 * successfully stop the system Extension and complete a locked CAS before it
 * may expose idle. Current-protocol recovery has a separate, stronger system
 * VPN absence gate and is never selected by this predicate.
 */
export function isStalePreviousRuntimeSession(status: VpnRuntimeStatus,
  nowMillis: number): boolean {
  if (status.protocolGeneration === VPN_RUNTIME_PROTOCOL_CURRENT ||
    isRuntimeStatusFresh(status, nowMillis)) {
    return false
  }
  // The existing 60-second authorization-ticket close path arbitrates a late
  // claim under the startup lock. Do not bypass that stronger transition.
  if (status.state === 'starting' && status.stage === 'await-authorization') return false
  return status.state === 'starting' || status.state === 'running' || status.state === 'error'
}

/**
 * A same-build orphan may be retired only from an explicit disconnect
 * recovery path. Fresh current-protocol sessions are deliberately excluded:
 * the normal same-session stop command and Extension acknowledgement remain
 * authoritative while the Extension is still heartbeating.
 */
export function isStaleCurrentRuntimeSession(status: VpnRuntimeStatus,
  nowMillis: number): boolean {
  if (status.protocolGeneration !== VPN_RUNTIME_PROTOCOL_CURRENT ||
    isRuntimeStatusFresh(status, nowMillis)) {
    return false
  }
  if (status.state === 'starting' && status.stage === 'await-authorization') return false
  return status.state === 'starting' || status.state === 'running' || status.state === 'error'
}

/**
 * The fallback never infers idle from a stale heartbeat alone. It is enabled
 * only after the platform accepted stopVpnExtensionAbility() and a complete
 * NetworkKit inventory proved that no BEARER_VPN remains.
 */
export function decideStaleRuntimeRecovery(status: VpnRuntimeStatus,
  nowMillis: number, lifecycleStopAcknowledged: boolean,
  systemVpnBearerState: SystemVpnBearerState): StaleRuntimeRecoveryDecision {
  if (!lifecycleStopAcknowledged || systemVpnBearerState !== 'absent' ||
    !isStaleCurrentRuntimeSession(status, nowMillis)) {
    return 'keep-locked'
  }
  return 'recover'
}

export function isRuntimeStartTicketFresh(status: VpnRuntimeStatus, nowMillis: number): boolean {
  if (status.state !== 'starting') return false
  const age: number = nowMillis - status.updatedAt
  return age >= -5000 && age <= VPN_START_TICKET_EXPIRES_AFTER_MS
}

export function isRuntimeUnclaimedTicketSafeToDiscard(status: VpnRuntimeStatus,
  nowMillis: number): boolean {
  if (status.state !== 'starting' || status.stage !== 'await-authorization') return false
  const age: number = nowMillis - status.updatedAt
  return age > VPN_UNCLAIMED_TICKET_SAFE_AFTER_MS
}

export function isRuntimeCommandFresh(command: VpnRuntimeCommand, nowMillis: number): boolean {
  const age: number = nowMillis - command.createdAt
  return age >= -5000 && age <= VPN_COMMAND_EXPIRES_AFTER_MS
}

/**
 * Pure cross-process command gate. The Extension must never execute a command
 * from another VPN session, execute the same request twice, or honor a stop
 * request that sat in the bridge past its bounded lifetime.
 */
export function decideRuntimeCommand(command: VpnRuntimeCommand, expectedSessionId: string,
  lastProcessedRequestId: string, nowMillis: number): VpnRuntimeCommandDecision {
  if (expectedSessionId.length === 0 || command.sessionId !== expectedSessionId) {
    return 'session-mismatch'
  }
  if (lastProcessedRequestId.length > 0 && command.requestId === lastProcessedRequestId) {
    return 'duplicate'
  }
  if (!isRuntimeCommandFresh(command, nowMillis)) return 'expired'
  return 'process'
}

/**
 * A cleanup acknowledgement is authoritative only for the exact session the
 * UI asked to stop. A stale `stopped` record from another session must never
 * unlock configuration or authorize a system lifecycle stop.
 */
export function isConfirmedRuntimeStop(status: VpnRuntimeStatus | null,
  expectedSessionId: string): boolean {
  return status !== null && expectedSessionId.length > 0 &&
    status.sessionId === expectedSessionId && status.state === 'stopped'
}

export function isSystemLifecycleStopped(status: VpnRuntimeStatus | null): boolean {
  return status !== null && status.state === 'stopped' &&
    status.stage === VPN_SYSTEM_LIFECYCLE_STOPPED_STAGE
}

export function createRuntimeSessionId(nowMillis: number, randomValue: number): string {
  const timePart: string = nowMillis.toString(36)
  const randomPart: string = Math.floor(Math.max(0, randomValue) * 0x100000000).toString(36)
  return `${timePart}-${randomPart}`
}

export function createRuntimeRequestId(nowMillis: number, randomValue: number): string {
  return `request-${createRuntimeSessionId(nowMillis, randomValue)}`
}
// ─────────────────────────────────────────────────────────────────────────────
// Tailscale command freshness and validation
// ─────────────────────────────────────────────────────────────────────────────

export function isTailscaleCommandFresh(command: TailscaleRuntimeCommand, nowMillis: number): boolean {
  const age: number = nowMillis - command.createdAt
  return age >= -5000 && age <= TAILSCALE_COMMAND_EXPIRES_AFTER_MS
}

export function isTailscaleStatusFresh(status: TailscaleRuntimeStatus, nowMillis: number): boolean {
  const age: number = nowMillis - status.updatedAt
  return age >= -5000 && age <= TAILSCALE_STATUS_STALE_AFTER_MS
}

export type TailscaleCommandDecision = 'process' | 'duplicate' | 'session-mismatch' | 'expired'

export function decideTailscaleCommand(command: TailscaleRuntimeCommand, expectedSessionId: string,
  lastProcessedRequestId: string, nowMillis: number): TailscaleCommandDecision {
  if (expectedSessionId.length === 0 || command.sessionId !== expectedSessionId) {
    return 'session-mismatch'
  }
  if (lastProcessedRequestId.length > 0 && command.requestId === lastProcessedRequestId) {
    return 'duplicate'
  }
  if (!isTailscaleCommandFresh(command, nowMillis)) return 'expired'
  return 'process'
}
