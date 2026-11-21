import { UIAbility } from '@kit.AbilityKit'
import { hilog } from '@kit.PerformanceAnalysisKit'
import { VpnTransferTask } from '../services/VpnTransferTask'

export default class TempAbility extends UIAbility {
  static active: boolean = false
  private initialSync: Promise<void> | null = null
  private transferTask: VpnTransferTask | null = null

  onCreate(): void {
    TempAbility.active = true
    this.transferTask = new VpnTransferTask(this.context)
    this.initialSync = this.transferTask.start().catch(() => {
      hilog.warn(0x0000, 'TempAbility', 'Initial VPN status sync failed')
    })
  }

  onForeground(): void {
    this.moveToBackground().catch(() => {
      hilog.warn(0x0000, 'TempAbility', 'Failed to move VPN task host to background')
    })
  }

  private async moveToBackground(): Promise<void> {
    await this.initialSync
    if (this.transferTask !== null) await this.context.moveAbilityToBackground()
  }

  onDestroy(): void {
    this.transferTask?.dispose()
    this.transferTask = null
    TempAbility.active = false
  }
}
