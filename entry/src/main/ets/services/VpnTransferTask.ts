import { common, wantAgent } from '@kit.AbilityKit'
import { backgroundTaskManager } from '@kit.BackgroundTasksKit'
import { hilog } from '@kit.PerformanceAnalysisKit'
import { VpnRuntimeBridgeStore } from './VpnRuntimeBridgeStore'
import { VpnRuntimeStatus } from './VpnRuntimeProtocol'

export function hasLiveVpnSession(status: VpnRuntimeStatus | null): boolean {
  if (status === null) return false
  return (status.state === 'running' || status.state === 'starting') && Date.now() - status.updatedAt <= 15000
}

// Owned by TempAbility. The VPN extension is the authority for session state.
export class VpnTransferTask {
  private timer: number = 0
  private taskActive: boolean = false
  private busy: boolean = false
  private disposed: boolean = false
  private failedSession: string = ''
  private readonly bridge: VpnRuntimeBridgeStore

  constructor(private readonly context: common.UIAbilityContext) {
    this.bridge = new VpnRuntimeBridgeStore(context.filesDir)
  }

  start(): Promise<void> {
    this.timer = setInterval(() => { this.sync().catch(() => {}) }, 2000)
    return this.sync()
  }

  private async cancel(): Promise<void> {
    if (!this.taskActive) return
    await backgroundTaskManager.stopBackgroundRunning(this.context)
    this.taskActive = false
  }

  private async sync(): Promise<void> {
    if (this.busy || this.disposed) return
    this.busy = true
    try {
      const status = await this.bridge.loadLatestStatus()
      if (this.disposed) return
      if (status === null || !hasLiveVpnSession(status)) {
        try {
          await this.cancel()
        } finally {
          if (!this.disposed) await this.context.terminateSelf()
        }
        return
      }
      if (status.stage === 'ssid-suspended') {
        await this.cancel()
        return
      }
      if (this.taskActive || status.state !== 'running' || this.failedSession === status.sessionId) return

      try {
        const agent = await wantAgent.getWantAgent({
          wants: [{ bundleName: this.context.abilityInfo.bundleName, abilityName: 'EntryAbility' }],
          actionType: wantAgent.OperationType.START_ABILITY,
          requestCode: 0,
          wantAgentFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
        })
        if (this.disposed) return
        await backgroundTaskManager.startBackgroundRunning(this.context, ['dataTransfer'], agent)
        this.taskActive = true
      } catch (_) {
        this.failedSession = status.sessionId
        hilog.error(0x0000, 'VpnTransferTask', 'Background transfer task request failed')
      }
    } finally {
      this.busy = false
      if (this.disposed) await this.cancel()
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== 0) clearInterval(this.timer)
    this.timer = 0
    if (!this.busy) this.cancel().catch(() => {})
  }
}
