import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  createRuntimeRequestId,
  createRuntimeSessionId,
  decideStaleRuntimeRecovery,
  decideRuntimeCommand,
  decideVpnStartGate,
  isConfirmedRuntimeStop,
  isSystemLifecycleStopped,
  isExactAwaitAuthorizationTicket,
  isRuntimeCommandFresh,
  isRuntimeStartTicketFresh,
  isRuntimeStatusFresh,
  isStaleCurrentRuntimeSession,
  isStalePreviousRuntimeSession,
  isRuntimeUnclaimedTicketSafeToDiscard,
  matchesRuntimeSession,
  normalizeRuntimeProtocolGeneration,
  settleVpnStartRequest,
  VPN_RUNTIME_PROTOCOL_CURRENT,
  VPN_RUNTIME_PROTOCOL_V2,
  VPN_SYSTEM_LIFECYCLE_STOPPED_STAGE,
  VPN_RUNTIME_PROTOCOL_LEGACY
} from '../../entry/src/main/ets/services/VpnRuntimeProtocol.ts'
import type {
  VpnRuntimeCommand,
  VpnRuntimeStatus
} from '../../entry/src/main/ets/services/VpnRuntimeProtocol.ts'

const coordinatorSource = readFileSync(new URL(
  '../../entry/src/main/ets/services/ConnectionCoordinator.ts', import.meta.url), 'utf8')
const bridgeSource = readFileSync(new URL(
  '../../entry/src/main/ets/services/VpnRuntimeBridgeStore.ts', import.meta.url), 'utf8')
const systemVerifierSource = readFileSync(new URL(
  '../../entry/src/main/ets/services/SystemVpnStateVerifier.ts', import.meta.url), 'utf8')
const moduleSource = readFileSync(new URL(
  '../../entry/src/main/module.json5', import.meta.url), 'utf8')

const status: VpnRuntimeStatus = {
  protocolGeneration: VPN_RUNTIME_PROTOCOL_CURRENT,
  revision: 7,
  sessionId: 'session-current',
  state: 'running',
  stage: 'running',
  version: '1.13.18',
  error: '',
  uploadBytes: 1234,
  downloadBytes: 5678,
  activeConnections: 3,
  selectedOutboundTag: 'node-a',
  updatedAt: 10000
}

test('runtime status is accepted only for the expected fresh session', () => {
  assert.equal(matchesRuntimeSession(status, 'session-current'), true)
  assert.equal(matchesRuntimeSession(status, 'session-old'), false)
  assert.equal(isRuntimeStatusFresh(status, 17999), true)
  assert.equal(isRuntimeStatusFresh(status, 18001), false)
})

test('startup ticket survives a slow authorization but expires after 45 seconds', () => {
  const ticket: VpnRuntimeStatus = {
    protocolGeneration: VPN_RUNTIME_PROTOCOL_CURRENT,
    revision: 1,
    sessionId: 'session-authorizing',
    state: 'starting',
    stage: 'await-authorization',
    version: '1.13.18',
    error: '',
    uploadBytes: 0,
    downloadBytes: 0,
    activeConnections: 0,
    selectedOutboundTag: '',
    updatedAt: 10000
  }
  assert.equal(isRuntimeStartTicketFresh(ticket, 25000), true)
  assert.equal(isRuntimeStartTicketFresh(ticket, 55000), true)
  assert.equal(isRuntimeStartTicketFresh(ticket, 55001), false)
  assert.equal(isRuntimeUnclaimedTicketSafeToDiscard(ticket, 70000), false)
  assert.equal(isRuntimeUnclaimedTicketSafeToDiscard(ticket, 70001), true)
  assert.equal(isRuntimeStartTicketFresh({ ...ticket, state: 'running' }, 25000), false)
  assert.equal(isRuntimeUnclaimedTicketSafeToDiscard({ ...ticket, stage: 'claim-session' }, 80000), false)
})

test('runtime command expires and request identifiers remain distinct', () => {
  const command: VpnRuntimeCommand = {
    sessionId: 'session-current',
    requestId: 'request-current',
    type: 'url-test',
    nodeTag: 'node-a',
    createdAt: 20000
  }
  assert.equal(isRuntimeCommandFresh(command, 50000), true)
  assert.equal(isRuntimeCommandFresh(command, 50001), false)
  assert.notEqual(createRuntimeRequestId(20000, 0.1), createRuntimeRequestId(20000, 0.2))
})

test('live selector commands are session-bound and require a concrete node tag', () => {
  const command: VpnRuntimeCommand = {
    sessionId: 'session-current',
    requestId: 'request-select',
    type: 'select-outbound',
    nodeTag: 'node-b',
    createdAt: 20000
  }
  assert.equal(decideRuntimeCommand(command, 'session-current', '', 20000), 'process')
  assert.equal(decideRuntimeCommand(command, 'session-other', '', 20000), 'session-mismatch')
  assert.equal(decideRuntimeCommand(command, 'session-current', 'request-select', 20000), 'duplicate')
  assert.equal(decideRuntimeCommand(command, 'session-current', '', 50001), 'expired')
})

test('stop commands are session-bound, deduplicated and expire fail-closed', () => {
  const stopCommand: VpnRuntimeCommand = {
    sessionId: 'session-current',
    requestId: 'request-stop',
    type: 'stop',
    nodeTag: '',
    createdAt: 20000
  }
  assert.equal(decideRuntimeCommand(stopCommand, 'session-current', '', 20000), 'process')
  assert.equal(decideRuntimeCommand(stopCommand, 'session-current', 'request-stop', 20000), 'duplicate')
  assert.equal(decideRuntimeCommand(stopCommand, 'session-other', '', 20000), 'session-mismatch')
  assert.equal(decideRuntimeCommand(stopCommand, 'session-current', '', 50001), 'expired')
})

test('disconnect immediately invalidates an in-flight URLTest wait and queued runtime commands', () => {
  const urlTestAt = coordinatorSource.indexOf('private async performUrlTest')
  const urlTestEnd = coordinatorSource.indexOf('\n  private ', urlTestAt + 10)
  const urlTestBody = coordinatorSource.slice(urlTestAt, urlTestEnd)
  const writeAt = urlTestBody.indexOf('await this.runtimeBridge.writeCommand(command)')
  const pollAt = urlTestBody.indexOf('for (let attempt: number = 0;', writeAt)
  const stopGateAt = urlTestBody.indexOf('if (this.disconnectTask !== null)', pollAt)
  const responseAt = urlTestBody.indexOf('await this.runtimeBridge.loadResponse', pollAt)
  assert.ok(urlTestAt >= 0 && writeAt > 0 && pollAt > writeAt && stopGateAt > pollAt && responseAt > stopGateAt)
  assert.match(coordinatorSource, /disconnect\(foregroundRecovery: boolean = false\): Promise<CoreStatus> \{[\s\S]*?this\.disconnectTask = task/)
  assert.match(coordinatorSource, /private runtimeCommandQueue: Promise<void> = Promise\.resolve\(\)/)
})

test('only a stopped acknowledgement from the requested session confirms cleanup', () => {
  const stopped: VpnRuntimeStatus = {
    ...status,
    state: 'stopped',
    stage: 'stopped'
  }
  assert.equal(isConfirmedRuntimeStop(stopped, 'session-current'), true)
  assert.equal(isConfirmedRuntimeStop({ ...stopped, sessionId: 'session-old' }, 'session-current'), false)
  assert.equal(isConfirmedRuntimeStop({ ...stopped, state: 'error' }, 'session-current'), false)
  assert.equal(isConfirmedRuntimeStop(null, 'session-current'), false)
  assert.equal(isSystemLifecycleStopped(stopped), false)
  assert.equal(isSystemLifecycleStopped({
    ...stopped,
    stage: VPN_SYSTEM_LIFECYCLE_STOPPED_STAGE
  }), true)
})

test('session identifier contains time and entropy components', () => {
  const first: string = createRuntimeSessionId(12345, 0.25)
  const second: string = createRuntimeSessionId(12345, 0.75)
  assert.ok(first.includes('-'))
  assert.notEqual(first, second)
})

test('runtime status carries the live session tracker snapshot', () => {
  assert.equal(status.uploadBytes, 1234)
  assert.equal(status.downloadBytes, 5678)
  assert.equal(status.activeConnections, 3)
  assert.equal(status.selectedOutboundTag, 'node-a')
})

test('missing runtime protocol generation normalizes only to legacy', () => {
  assert.equal(normalizeRuntimeProtocolGeneration(undefined), VPN_RUNTIME_PROTOCOL_LEGACY)
  assert.equal(normalizeRuntimeProtocolGeneration(VPN_RUNTIME_PROTOCOL_V2), VPN_RUNTIME_PROTOCOL_V2)
  assert.equal(normalizeRuntimeProtocolGeneration(VPN_RUNTIME_PROTOCOL_CURRENT), VPN_RUNTIME_PROTOCOL_CURRENT)
  assert.equal(normalizeRuntimeProtocolGeneration('future'), null)
})

test('only stale previous-protocol active sessions qualify for package-upgrade recovery', () => {
  const stalePrevious: VpnRuntimeStatus = {
    ...status,
    protocolGeneration: VPN_RUNTIME_PROTOCOL_V2,
    state: 'running',
    updatedAt: 10000
  }
  assert.equal(isStalePreviousRuntimeSession(stalePrevious, 18001), true)
  assert.equal(isStalePreviousRuntimeSession({ ...stalePrevious, state: 'starting', stage: 'claim-session' },
    18001), true)
  assert.equal(isStalePreviousRuntimeSession({ ...stalePrevious, state: 'error' }, 18001), true)
  assert.equal(isStalePreviousRuntimeSession({ ...stalePrevious, state: 'stopped' }, 18001), false)
  assert.equal(isStalePreviousRuntimeSession({ ...stalePrevious, updatedAt: 18000 }, 18001), false)
  assert.equal(isStalePreviousRuntimeSession({
    ...stalePrevious,
    state: 'starting',
    stage: 'await-authorization'
  }, 80000), false)
  assert.equal(isStalePreviousRuntimeSession({
    ...stalePrevious,
    protocolGeneration: VPN_RUNTIME_PROTOCOL_CURRENT
  }, 18001), false)
})

test('same-protocol orphan recovery requires stale status plus both system proofs', () => {
  const staleCurrent: VpnRuntimeStatus = {
    ...status,
    protocolGeneration: VPN_RUNTIME_PROTOCOL_CURRENT,
    state: 'running',
    updatedAt: 10000
  }
  assert.equal(isStaleCurrentRuntimeSession(staleCurrent, 18001), true)
  assert.equal(isStaleCurrentRuntimeSession({ ...staleCurrent, updatedAt: 18000 }, 18001), false)
  assert.equal(isStaleCurrentRuntimeSession({
    ...staleCurrent,
    protocolGeneration: VPN_RUNTIME_PROTOCOL_V2
  }, 18001), false)
  assert.equal(isStaleCurrentRuntimeSession({
    ...staleCurrent,
    state: 'starting',
    stage: 'await-authorization'
  }, 80000), false)
  assert.equal(decideStaleRuntimeRecovery(staleCurrent, 18001, true, 'absent'), 'recover')
  assert.equal(decideStaleRuntimeRecovery(staleCurrent, 18001, false, 'absent'), 'keep-locked')
  assert.equal(decideStaleRuntimeRecovery(staleCurrent, 18001, true, 'present'), 'keep-locked')
  assert.equal(decideStaleRuntimeRecovery(staleCurrent, 18001, true, 'unknown'), 'keep-locked')
  assert.equal(decideStaleRuntimeRecovery({ ...staleCurrent, updatedAt: 18000 },
    18001, true, 'absent'), 'keep-locked')
})

test('package-upgrade recovery stops the old lifecycle before an exact locked status transition', () => {
  const recoverAt = coordinatorSource.indexOf('private async recoverStalePreviousRuntime')
  const recoverEnd = coordinatorSource.indexOf('\n  async getStatus()', recoverAt)
  const recoverBody = coordinatorSource.slice(recoverAt, recoverEnd)
  const stopAt = recoverBody.indexOf('await vpnExtension.stopVpnExtensionAbility(vpnWant())')
  const bearerAt = recoverBody.indexOf('await waitForSystemVpnBearerAbsent()')
  const closeAt = recoverBody.indexOf('closeStalePreviousRuntimeAfterSystemStop(')
  const unlockAt = recoverBody.indexOf("this.activeSessionId = ''")
  assert.ok(recoverAt >= 0 && stopAt > 0 && bearerAt > stopAt &&
    closeAt > bearerAt && unlockAt > closeAt)
  assert.match(recoverBody, /系统仍未确认旧 VPN 网络已消失，升级会话仍保持锁定/)
  assert.match(recoverBody, /if \(!closed\) throw new Error/)

  const closeMethodAt = bridgeSource.indexOf('async closeStalePreviousRuntimeAfterSystemStop')
  const closeMethodEnd = bridgeSource.indexOf('\n  writeCommand(', closeMethodAt)
  const closeBody = bridgeSource.slice(closeMethodAt, closeMethodEnd)
  assert.match(closeBody, /this\.withStartupLock<boolean>/)
  assert.match(closeBody, /status\.revision !== expectedRevision/)
  assert.match(closeBody, /status\.updatedAt !== expectedUpdatedAt/)
  assert.match(closeBody, /isStalePreviousRuntimeSession\(status, nowMillis\)/)
  assert.match(closeBody, /protocolGeneration: VPN_RUNTIME_PROTOCOL_CURRENT/)
  assert.match(closeBody, /stage: VPN_SYSTEM_LIFECYCLE_STOPPED_STAGE/)
})

test('same-build recovery is command-first and closes only an exact locked revision after system proof', () => {
  const disconnectAt = coordinatorSource.indexOf('private async performDisconnect')
  const disconnectBody = coordinatorSource.slice(disconnectAt)
  const commandAt = disconnectBody.indexOf('await this.runtimeBridge.writeCommand(stopCommand)')
  const recoveryAt = disconnectBody.indexOf('recoverStaleCurrentRuntimeAfterStop(')
  assert.ok(commandAt > 0 && recoveryAt > commandAt)

  const recoveryMethodAt = coordinatorSource.indexOf('private async recoverStaleCurrentRuntimeAfterStop')
  const recoveryMethodEnd = coordinatorSource.indexOf('\n  private async performDisconnect', recoveryMethodAt)
  const recoveryBody = coordinatorSource.slice(recoveryMethodAt, recoveryMethodEnd)
  const eligibilityAt = recoveryBody.indexOf('isStaleCurrentRuntimeSession(')
  const stopAt = recoveryBody.indexOf('await vpnExtension.stopVpnExtensionAbility(vpnWant())')
  const bearerAt = recoveryBody.indexOf('await waitForSystemVpnBearerAbsent()')
  const decisionAt = recoveryBody.indexOf('decideStaleRuntimeRecovery(')
  const closeAt = recoveryBody.indexOf('closeStaleCurrentRuntimeAfterSystemStop(')
  assert.ok(eligibilityAt > 0 && stopAt > eligibilityAt && bearerAt > stopAt &&
    decisionAt > bearerAt && closeAt > decisionAt)

  const closeMethodAt = bridgeSource.indexOf('async closeStaleCurrentRuntimeAfterSystemStop')
  const closeMethodEnd = bridgeSource.indexOf('\n  writeCommand(', closeMethodAt)
  const closeBody = bridgeSource.slice(closeMethodAt, closeMethodEnd)
  assert.match(closeBody, /this\.withStartupLock<boolean>/)
  assert.match(closeBody, /status\.revision === expectedRevision/)
  assert.match(closeBody, /status\.updatedAt === expectedUpdatedAt/)
  assert.match(closeBody, /isStaleCurrentRuntimeSession\(status, nowMillis\)/)
  assert.match(closeBody, /isConfirmedRuntimeStop\(status, sessionId\)/)
})

test('all runtime status writes share the startup lock and advance a monotonic revision', () => {
  const publishAt = bridgeSource.indexOf('async publishStatus')
  const publishEnd = bridgeSource.indexOf('\n  async publishStartTicket', publishAt)
  const publishBody = bridgeSource.slice(publishAt, publishEnd)
  assert.match(publishBody, /this\.withStartupLock<void>/)
  assert.match(publishBody, /current\.sessionId !== status\.sessionId/)
  assert.match(publishBody, /isSystemLifecycleStopped\(current\)/)
  assert.match(publishBody, /status\.revision = current\.revision \+ 1/)
})

test('system VPN absence is proved from the full NetworkKit bearer inventory', () => {
  assert.match(moduleSource, /ohos\.permission\.GET_NETWORK_INFO/)
  assert.match(systemVerifierSource, /await connection\.getAllNets\(\)/)
  assert.match(systemVerifierSource, /await connection\.getNetCapabilities\(networks\[index\]\)/)
  assert.match(systemVerifierSource, /connection\.NetBearType\.BEARER_VPN/)
  assert.match(systemVerifierSource, /catch \(_\) \{\s*return 'unknown'/)
  assert.match(systemVerifierSource, /REQUIRED_ABSENT_SNAPSHOTS: number = 2/)
})

test('an already-authorized start continues when the platform promise resolves without an observer callback', async () => {
  assert.equal(await settleVpnStartRequest(Promise.resolve()), 'resolved')
})

test('a rejected platform start request never advances to the VPN runtime wait', async () => {
  assert.equal(await settleVpnStartRequest(Promise.reject(new Error('denied'))), 'rejected')
})

test('a pending platform promise continues as soon as the Extension claims the ticket', () => {
  const claimed: VpnRuntimeStatus = {
    ...status,
    state: 'starting',
    stage: 'claim-session'
  }
  assert.equal(decideVpnStartGate('pending', claimed, false), 'continue-runtime')
})

test('a resolved start with an unclaimed runtime ticket is recoverable after runtime timeout', () => {
  const unclaimed: VpnRuntimeStatus = {
    ...status,
    state: 'starting',
    stage: 'await-authorization'
  }
  assert.equal(decideVpnStartGate('resolved', unclaimed, false), 'continue-runtime')
  assert.equal(isExactAwaitAuthorizationTicket(unclaimed), true)
})

test('a deadline never cancels a ticket when a concurrent Extension claim won', () => {
  const unclaimed: VpnRuntimeStatus = {
    ...status,
    state: 'starting',
    stage: 'await-authorization'
  }
  const claimed: VpnRuntimeStatus = {
    ...unclaimed,
    stage: 'claim-session'
  }
  assert.equal(decideVpnStartGate('pending', unclaimed, true), 'cancel-unclaimed')
  assert.equal(decideVpnStartGate('pending', claimed, true), 'continue-runtime')
})
