import { process } from '@kit.ArkTS'
import { VpnRuntimeBridgeStore } from './VpnRuntimeBridgeStore'
import { readSystemVpnBearerState } from './SystemVpnStateVerifier'
import { VpnRuntimeStatus } from './VpnRuntimeProtocol'
import { VpnMonitorStore } from './VpnMonitorStore'
import { VpnMonitorEvent } from '../domain/VpnMonitor'

// Pure observation before UI recovery can replace the old heartbeat. Never
// connects/stops a VPN, invokes the core, or rewrites the user's intent.
export async function captureVpnMonitor(filesDir: string): Promise<void> {
  try {
    const status: VpnRuntimeStatus | null = await new VpnRuntimeBridgeStore(filesDir).loadLatestStatus()
    const bearer: string = await readSystemVpnBearerState()
    const sample: VpnMonitorEvent = {at: Date.now(), eventAt: status ? status.updatedAt : 0,
      event: 'ui-observation', state: status ? status.state : '', stage: status ? status.stage : '',
      pid: process.pid, session: status ? status.sessionId : '', code: bearer === 'present' ? 1 : bearer === 'absent' ? 0 : -1,
      reason: '', runId: ''}
    await VpnMonitorStore.get(filesDir, 'ui').record(sample)
  } catch (_) { }
}
