import { hasLiveVpnSession } from '../services/VpnTransferTask'
import { VpnRuntimeBridgeStore } from '../services/VpnRuntimeBridgeStore'
import TempAbility from '../tempability/TempAbility'
import { notificationManager } from '@kit.NotificationKit'
import { AbilityConstant, Configuration, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit'
import { hilog } from '@kit.PerformanceAnalysisKit'
import { window } from '@kit.ArkUI'

const DOMAIN: number = 0x0000
const TAG: string = 'HarmonyNet'

export default class EntryAbility extends UIAbility {
  private guardianTimer: number = 0
  private guardianCheckPending: boolean = false
  private attemptedSession: string = ''
  private destroyed: boolean = false
  private arkColorMode(mode: ConfigurationConstant.ColorMode | undefined): ColorMode {
    return mode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK ? ColorMode.DARK : ColorMode.LIGHT
  }

  private publishUiEnvironment(configuration: Configuration): void {
    AppStorage.setOrCreate('colorMode', this.arkColorMode(configuration.colorMode))
    AppStorage.setOrCreate('languageCode', (configuration.language || 'zh').toLowerCase())
  }

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    AppStorage.setOrCreate('uiForeground', true)
    notificationManager.requestEnableNotification(this.context).catch(() => {})
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
    if (this.guardianTimer === 0) {
      this.guardianTimer = setInterval(() => { this.ensureVpnGuardian().catch(() => {}) }, 1000)
    }
    this.ensureVpnGuardian().catch(() => {})
  }

  private async ensureVpnGuardian(): Promise<void> {
    if (this.destroyed || TempAbility.active || this.guardianCheckPending) return
    this.guardianCheckPending = true
    try {
      const status = await new VpnRuntimeBridgeStore(this.context.filesDir).loadLatestStatus()
      if (this.destroyed || TempAbility.active || status === null || status.state !== 'running' ||
        !hasLiveVpnSession(status) || status.sessionId === this.attemptedSession) return
      this.attemptedSession = status.sessionId
      await this.context.startAbility({
        bundleName: this.context.abilityInfo.bundleName,
        abilityName: 'TempAbility'
      })
    } catch (_) {
      hilog.warn(DOMAIN, TAG, 'Failed to start VPN task host')
    } finally {
      this.guardianCheckPending = false
    }
  }
  onBackground(): void { AppStorage.setOrCreate('uiForeground', false) }

  onDestroy(): void {
    this.destroyed = true
    AppStorage.setOrCreate('uiForeground', false)
    if (this.guardianTimer !== 0) clearInterval(this.guardianTimer)
    this.guardianTimer = 0
    hilog.info(DOMAIN, TAG, 'EntryAbility destroyed')
  }
}
