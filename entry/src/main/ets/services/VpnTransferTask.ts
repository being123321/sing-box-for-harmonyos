import { BusinessError } from '@kit.BasicServicesKit'
import { commonEventManager } from '@kit.BasicServicesKit'
import { common, wantAgent } from '@kit.AbilityKit'
import { backgroundTaskManager } from '@kit.BackgroundTasksKit'
import { notificationManager } from '@kit.NotificationKit'
import { hilog } from '@kit.PerformanceAnalysisKit'
import { VpnRuntimeBridgeStore } from './VpnRuntimeBridgeStore'
import { VpnRuntimeConfigStore } from './VpnRuntimeConfigStore'
import { ConnectionCoordinator } from './ConnectionCoordinator'
import { VpnRuntimeStatus, isSystemLifecycleStopped } from './VpnRuntimeProtocol'

export class VpnTransferTask {
  private timer: number = 0
  private retryTimer: number = 0
  private taskId: number = -1
  private notificationId: number = -1
  private notificationSession: string = ''
  private permissionCheckPending: boolean = false
  private permissionRequested: boolean = false
  private permissionWasDisabled: boolean = false
  private sessionId: string = ''
  private nextTaskAttempt: number = 0
  private nextRecoveryAttempt: number = 0
  private busy: boolean = false
  private disposed: boolean = false
  private queue: Promise<void> = Promise.resolve()
  private readonly bridge: VpnRuntimeBridgeStore
  private readonly runtime: VpnRuntimeConfigStore
  private readonly onTaskCanceled = (info: backgroundTaskManager.ContinuousTaskCancelInfo): void => {
    if (this.disposed || info.id !== this.taskId || this.taskId < 0) return
    this.taskId = -1
    this.notificationId = -1
    this.notificationSession = ''
    this.serialize((): Promise<void> => this.clearNotification()).catch((): void => {})
    this.nextTaskAttempt = Date.now() + 800
    this.retryTimer = setTimeout((): void => {
      this.retryTimer = 0
      this.refresh()
    }, 800)
  }

  constructor(private readonly context: common.UIAbilityContext) {
    this.bridge = new VpnRuntimeBridgeStore(context.filesDir)
    this.runtime = new VpnRuntimeConfigStore(context.filesDir)
  }

  start(): void {
    try {
      backgroundTaskManager.on('continuousTaskCancel', this.onTaskCanceled)
    } catch (_) {
      hilog.warn(0x0000, 'VpnTransferTask', 'Unable to observe continuous task cancellation')
    }
    this.timer = setInterval((): void => this.refresh(), 2000)
  }

  refresh(): void {
    if (this.busy || this.disposed) return
    this.busy = true
    this.sync().catch((): void => {}).finally((): void => { this.busy = false })
  }

  private serialize(action: () => Promise<void>): Promise<void> {
    const operation: Promise<void> = this.queue.then(action)
    this.queue = operation.catch((): void => {})
    return operation
  }

  requestNotificationPermission(): void {
    if (this.disposed || this.permissionCheckPending) return
    this.permissionCheckPending = true
    this.enableNotification().finally((): void => { this.permissionCheckPending = false })
  }

  private async enableNotification(): Promise<void> {
    try {
      let enabled: boolean = await notificationManager.isNotificationEnabled()
      if (this.disposed) return
      if (!enabled) {
        this.permissionWasDisabled = true
        if (this.permissionRequested) return
        this.permissionRequested = true
        await notificationManager.requestEnableNotification(this.context)
        enabled = await notificationManager.isNotificationEnabled()
      }
      if (!enabled || this.disposed || !this.permissionWasDisabled) return
      this.permissionWasDisabled = false
      hilog.info(0x0000, 'VpnTransferTask', 'Notification permission granted; refreshing the task card')
      await this.serialize(async (): Promise<void> => {
        if (this.taskId >= 0) await this.cancel()
        this.nextTaskAttempt = 0
      })
      this.refresh()
    } catch (error) {
      const failure = error as BusinessError
      hilog.warn(0x0000, 'VpnTransferTask', 'Notification permission error %{public}d: %{public}s',
        failure.code, failure.message)
    }
  }

  prepare(sessionId: string): Promise<void> {
    return this.serialize(async (): Promise<void> => {
      if (this.disposed || this.retryTimer !== 0) return
      if (this.sessionId !== sessionId) this.nextTaskAttempt = 0
      if (this.taskId >= 0 && this.notificationSession === sessionId) return
      if (Date.now() < this.nextTaskAttempt) return
      this.sessionId = sessionId
      try {
        if (this.taskId < 0) {
          const request = new backgroundTaskManager.ContinuousTaskRequest()
          request.backgroundTaskModes = [backgroundTaskManager.BackgroundTaskMode.MODE_DATA_TRANSFER]
          request.backgroundTaskSubmodes = [backgroundTaskManager.BackgroundTaskSubmode.SUBMODE_LIVE_VIEW_NOTIFICATION]
          request.wantAgent = await wantAgent.getWantAgent({
            wants: [{ bundleName: this.context.abilityInfo.bundleName, abilityName: 'EntryAbility' }],
            actionType: wantAgent.OperationType.START_ABILITY,
            requestCode: 0,
            wantAgentFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
          })
          if (this.disposed) return
          const result = await backgroundTaskManager.startBackgroundRunning(this.context, request)
          this.taskId = result.continuousTaskId ?? -1
          this.notificationId = result.notificationId
          hilog.info(0x0000, 'VpnTransferTask', 'Continuous task %{public}d, notification %{public}d',
            this.taskId, this.notificationId)
        }
        if (this.disposed) return
        if (this.notificationId >= 0) {
          await this.bridge.writeTaskNotification({ sessionId: sessionId, notificationId: this.notificationId })
          this.notificationSession = sessionId
          this.publishTaskId()
        } else {
          this.notificationSession = sessionId
          hilog.warn(0x0000, 'VpnTransferTask', 'The continuous task returned no usable notification ID')
        }
      } catch (error) {
        this.nextTaskAttempt = Date.now() + 30000
        const failure = error as BusinessError
        hilog.warn(0x0000, 'VpnTransferTask', 'DATA_TRANSFER live view setup failed (%{public}d): %{public}s',
          failure.code, failure.message)
      }
    })
  }

  private publishTaskId(): void {
    const bundleName: string = this.context.abilityInfo.bundleName
    try {
      commonEventManager.publish(bundleName + '.TASK_ID', {
        bundleName: bundleName,
        parameters: { 'taskNotificationId': this.notificationId }
      }, () => {})
    } catch (_) { /* The VPN extension can also read the private session record. */ }
  }

  private clearNotification(): Promise<void> {
    return this.bridge.writeTaskNotification({ sessionId: this.sessionId, notificationId: -1 })
  }

  private async cancel(): Promise<void> {
    const taskId: number = this.taskId
    const notificationId: number = this.notificationId
    this.taskId = -1
    this.notificationId = -1
    this.notificationSession = ''
    if (this.retryTimer !== 0) clearTimeout(this.retryTimer)
    this.retryTimer = 0
    if (taskId < 0 && notificationId < 0) return
    await this.clearNotification().catch((): void => {})
    if (taskId >= 0) await backgroundTaskManager.stopBackgroundRunning(this.context, taskId).catch((): void => {})
    if (notificationId >= 0) await notificationManager.cancel(notificationId).catch((): void => {})
  }

  private async recover(status: VpnRuntimeStatus): Promise<void> {
    if (Date.now() < this.nextRecoveryAttempt) return
    this.nextRecoveryAttempt = Date.now() + 20000
    const command = await this.bridge.loadCommand(status.sessionId)
    if (command?.type === 'stop' && command.nodeTag !== 'foreground-recovery') return
    const profileId: string = await this.runtime.loadProfileId()
    if (!profileId || this.disposed) return
    const config: string = await this.runtime.load()
    const scope = await this.runtime.loadApplicationScope()
    const coordinator = new ConnectionCoordinator(this.context)
    if (await coordinator.recoverOrphanedSession(profileId) && !this.disposed) {
      await coordinator.connect(config, scope, profileId)
    }
  }

  private async sync(): Promise<void> {
    const status = await this.bridge.loadLatestStatus()
    if (this.disposed) return
    if (status?.state === 'running' && status.stage !== 'ssid-suspended') {
      if (Date.now() - status.updatedAt > 8000) {
        await this.recover(status)
      } else {
        await this.prepare(status.sessionId)
      }
      return
    }
    if (status !== null && isSystemLifecycleStopped(status) && this.taskId >= 0 &&
      this.sessionId === status.sessionId) {
      const command = await this.bridge.loadCommand(status.sessionId)
      if (command?.type !== 'stop' || command.nodeTag === 'foreground-recovery') {
        await this.recover(status)
        return
      }
    }
    if (status === null || status.state === 'starting') return
    const command = await this.bridge.loadCommand(status.sessionId)
    const explicitStop: boolean = command?.type === 'stop' && command.nodeTag !== 'foreground-recovery'
    const startupEnded: boolean = status.state === 'stopped' &&
      (status.stage === 'authorization-ticket-expired' || status.stage === 'startup-aborted-unclaimed' ||
        status.stage === 'start-request-timeout' || status.stage === 'user-cancelled-unclaimed')
    // Keep the task through a missing record or a transient recovery state.
    if (!explicitStop && !startupEnded && status.stage !== 'ssid-suspended') return
    await this.serialize(async (): Promise<void> => {
      const current = await this.bridge.loadLatestStatus()
      if (current?.sessionId === status.sessionId && current?.revision === status.revision) await this.cancel()
    })
  }

  dispose(): void {
    this.disposed = true
    try { backgroundTaskManager.off('continuousTaskCancel', this.onTaskCanceled) } catch (_) {}
    if (this.timer !== 0) clearInterval(this.timer)
    if (this.retryTimer !== 0) clearTimeout(this.retryTimer)
    this.timer = 0
    this.retryTimer = 0
    this.serialize((): Promise<void> => this.cancel()).catch((): void => {})
  }
}
