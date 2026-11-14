import { common, wantAgent } from '@kit.AbilityKit'
import { backgroundTaskManager } from '@kit.BackgroundTasksKit'
import { notificationManager } from '@kit.NotificationKit'
import { hilog } from '@kit.PerformanceAnalysisKit'
import { VpnRuntimeBridgeStore } from './VpnRuntimeBridgeStore'

// UIAbility owns this task. It does not grant the VPN extension a lifecycle lease.
export class VpnTransferTask {
  private timer: number = 0
  private notificationId: number = -1
  private busy: boolean = false
  private disposed: boolean = false
  private lastBytes: number = -1
  private session: string = ''
  private lastPublished: number = 0
  private failedSession: string = ''
  private context: common.UIAbilityContext
  constructor(context: common.UIAbilityContext) { this.context = context }

  start(): void {
    if (this.timer !== 0) return
    this.timer = setInterval(() => { this.sync().catch(() => {}) }, 2000)
    this.sync().catch(() => {})
  }

  private async cancel(): Promise<void> {
    if (this.notificationId < 0) return
    await backgroundTaskManager.stopBackgroundRunning(this.context)
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
      const bytes: number = status.uploadBytes + status.downloadBytes
      // Never manufacture progress or traffic during idle periods.
      if (bytes === this.lastBytes || Date.now() - this.lastPublished < 60000) return
      await notificationManager.publish({
        id: this.notificationId,
        notificationSlotType: notificationManager.SlotType.LIVE_VIEW,
        content: {
          notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_SYSTEM_LIVE_VIEW,
          systemLiveView: {
            typeCode: 1,
            title: 'VPN 数据传输',
            text: `上传 ${status.uploadBytes} B · 下载 ${status.downloadBytes} B`
          }
        }
      })
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

  dispose(): void {
    this.disposed = true
    if (this.timer !== 0) clearInterval(this.timer)
    this.timer = 0
    if (!this.busy) this.cancel().catch(() => {})
  }
}
