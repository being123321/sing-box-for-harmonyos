import { VpnTransferTask } from '../services/VpnTransferTask'
import { ConnectionCoordinator } from '../services/ConnectionCoordinator'
import { notificationManager } from '@kit.NotificationKit'
import { AbilityConstant, Configuration, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit'
import { hilog } from '@kit.PerformanceAnalysisKit'
import { window } from '@kit.ArkUI'

const DOMAIN: number = 0x0000
const TAG: string = 'HarmonyNet'

export default class EntryAbility extends UIAbility {
  private transferTask: VpnTransferTask | null = null
  private arkColorMode(mode: ConfigurationConstant.ColorMode | undefined): ColorMode {
    return mode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK ? ColorMode.DARK : ColorMode.LIGHT
  }

  private publishUiEnvironment(configuration: Configuration): void {
    AppStorage.setOrCreate('colorMode', this.arkColorMode(configuration.colorMode))
    AppStorage.setOrCreate('languageCode', (configuration.language || 'zh').toLowerCase())
  }

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    AppStorage.setOrCreate('uiForeground', true)
    // Remove the traffic notification left by earlier builds.
    notificationManager.cancel(31030).catch(() => {})
    const task = new VpnTransferTask(this.context)
    this.transferTask = task
    ConnectionCoordinator.prepareKeepAlive = (sessionId: string): Promise<void> => task.claimSession(sessionId)
    task.start()
    hilog.info(DOMAIN, TAG, 'EntryAbility created')
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    const mainWindow: window.Window = windowStage.getMainWindowSync()
    const updateInsets = (): void => {
      const system: window.AvoidArea = mainWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM)
      const navigation: window.AvoidArea = mainWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR)
      AppStorage.setOrCreate('topInsetPx', system.topRect.height)
      AppStorage.setOrCreate('bottomInsetPx', Math.max(system.bottomRect.height, navigation.bottomRect.height))
    }
    updateInsets()
    mainWindow.on('avoidAreaChange', () => updateInsets())
    mainWindow.setWindowLayoutFullScreen(true).catch(() => {})
    Environment.envProp('colorMode', this.arkColorMode(this.context.config.colorMode))
    Environment.envProp('languageCode', (this.context.config.language || 'zh').toLowerCase())
    this.publishUiEnvironment(this.context.config)
    windowStage.loadContent('pages/SfaIndex', (error) => {
      if (error.code) {
        hilog.error(DOMAIN, TAG, 'Failed to load page: %{public}s', error.message)
        return
      }
      hilog.info(DOMAIN, TAG, 'Main page loaded')
    })
  }

  onConfigurationUpdate(newConfig: Configuration): void {
    this.publishUiEnvironment(newConfig)
  }

  onForeground(): void {
    AppStorage.setOrCreate('uiForeground', true)
    this.transferTask?.requestNotificationPermission()
    this.transferTask?.refresh()
  }

  onBackground(): void { AppStorage.setOrCreate('uiForeground', false) }

  onDestroy(): void {
    AppStorage.setOrCreate('uiForeground', false)
    ConnectionCoordinator.prepareKeepAlive = null
    const task = this.transferTask
    task?.dispose()
    if (task?.ownsSession()) new ConnectionCoordinator(this.context).disconnect().catch(() => {})
    this.transferTask = null
    hilog.info(DOMAIN, TAG, 'EntryAbility destroyed')
  }
}
