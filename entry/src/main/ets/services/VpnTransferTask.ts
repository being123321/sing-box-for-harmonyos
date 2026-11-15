import { common, wantAgent } from '@kit.AbilityKit'
import { backgroundTaskManager } from '@kit.BackgroundTasksKit'
import { notificationManager } from '@kit.NotificationKit'
import { vpnExtension } from '@kit.NetworkKit'
import { hilog } from '@kit.PerformanceAnalysisKit'
import { VpnRuntimeBridgeStore } from './VpnRuntimeBridgeStore'

// UIAbility owns this task. It does not grant the VPN extension a lifecycle lease.
function formatTrafficBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return bytes + ' B'
  const units: string[] = ['KiB', 'MiB', 'GiB', 'TiB']
  let value: number = bytes / 1024
  let unit: number = 0
  while (value >= 1024 && unit < units.length - 1) { value = value / 1024; unit += 1 }
  return value.toFixed(value >= 100 ? 0 : 1) + ' ' + units[unit]
}

export class VpnTransferTask {
  private timer: number = 0
  private notificationId: number = -1
  private busy: boolean = false
  private disposed: boolean = false
  private lastBytes: number = -1
  private session: string = ''
  private lastPublished: number = 0
  private lastSampleBytes: number = -1
  private lastSampleAt: number = 0
  private lastUploadBytes: number = -1
  private lastDownloadBytes: number = -1
  private lastRunningAt: number = 0
  private restartAttempts: number = 0
  private lastRestartAt: number = 0
  private failedSession: string = ''
  private context: common.UIAbilityContext
  constructor(context: common.UIAbilityContext) { this.context = context }

  start(): void {
    if (this.timer !== 0) return
    // Publishing (and especially the live-view slot) requires the user to allow
    // notifications; without it every publish is dropped silently.
    notificationManager.requestEnableNotification(this.context).catch(() => {})
    this.timer = setInterval(() => { this.sync().catch(() => {}) }, 2000)
    this.sync().catch(() => {})
  }

  private async cancel(): Promise<void> {
    if (this.notificationId < 0) return
    await backgroundTaskManager.stopBackgroundRunning(this.context)
    try { await notificationManager.cancel(this.notificationId) } catch (_) { }
    this.notificationId = -1
    this.lastBytes = -1
  }

  private async sync(): Promise<void> {
    if (this.busy || this.disposed) return
    this.busy = true
    try {
      const status = await new VpnRuntimeBridgeStore(this.context.filesDir).loadLatestStatus()
      if (!status || status.state !== 'running' || Date.now() - status.updatedAt > 15000 ||
        status.stage === 'ssid-suspended') {
        await this.cancel()
        return
      }
      if (this.session !== status.sessionId) {
        await this.cancel()
        this.session = status.sessionId
        this.failedSession = ''
        this.lastPublished = 0
      }
      if (this.failedSession === this.session) return
      if (this.notificationId < 0) {
        const agent = await wantAgent.getWantAgent({
          wants: [{ bundleName: this.context.abilityInfo.bundleName, abilityName: 'EntryAbility' }],
          actionType: wantAgent.OperationType.START_ABILITY,
          requestCode: 0,
          wantAgentFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
        })
        const task = await backgroundTaskManager.startBackgroundRunning(this.context, ['dataTransfer'], agent)
        this.notificationId = task.notificationId
      }
      if (this.disposed) { await this.cancel(); return }
      this.lastRunningAt = Date.now()
      const now: number = Date.now()
      const bytes: number = status.uploadBytes + status.downloadBytes
      let rateText: string = ''
      if (this.lastSampleAt > 0 && now > this.lastSampleAt && this.lastSampleBytes >= 0) {
        const seconds: number = (now - this.lastSampleAt) / 1000
        if (seconds >= 1) {
          const downRate: number = Math.max(0, (status.downloadBytes - this.lastDownloadBytes) / seconds)
          const upRate: number = Math.max(0, (status.uploadBytes - this.lastUploadBytes) / seconds)
          rateText = '↓ ' + formatTrafficBytes(downRate) + '/s · ↑ ' + formatTrafficBytes(upRate) + '/s · '
        }
      }
      this.lastSampleAt = now
      this.lastSampleBytes = bytes
      this.lastUploadBytes = status.uploadBytes
      this.lastDownloadBytes = status.downloadBytes
      // Never manufacture progress or traffic during idle periods.
      if (bytes === this.lastBytes && rateText.length === 0) return
      if (now - this.lastPublished < 5000) return
      // HarmonyOS explicitly refuses to combine notifications for a dataTransfer
      // continuous task, and the system notification has fixed text. Publishing a
      // second traffic notification would therefore always show two entries, so
      // the app keeps the single system notification and shows speed in-app only.
      this.lastBytes = bytes
      this.lastPublished = Date.now()
    } catch (_) {
      this.failedSession = this.session
      AppStorage.setOrCreate('vpnBackgroundTaskError', '后台传输任务申请或通知更新失败，请返回前台检查')
      hilog.error(0x0000, 'VpnTransferTask', 'Background transfer task failed; automatic reapplication disabled')
      try { await this.cancel() } catch (_) {}
    } finally {
      this.busy = false
    }
  }

  // The UIAbility process is the only component guaranteed to keep running while
  // the user is away. If the extension stops publishing a running status, try a
  // bounded restart: at most three per session, five minutes apart.
  private async maybeRestartVpn(): Promise<void> {
    const now: number = Date.now()
    if (this.restartAttempts >= 3) return
    if (this.lastRestartAt !== 0 && now - this.lastRestartAt < 300000) return
    this.lastRestartAt = now
    this.restartAttempts += 1
    hilog.warn(0x0000, 'VpnTransferTask', 'VPN status missing; bounded restart %{public}d/3', this.restartAttempts)
    try {
      await vpnExtension.startVpnExtensionAbility({
        bundleName: this.context.abilityInfo.bundleName,
        abilityName: 'NetworkVpnExtAbility'
      })
    } catch (_) { }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== 0) clearInterval(this.timer)
    this.timer = 0
    if (!this.busy) this.cancel().catch(() => {})
  }
}
