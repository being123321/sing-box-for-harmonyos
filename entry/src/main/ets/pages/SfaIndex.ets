import { uiMaterial } from '@kit.ArkUI'
import { deviceInfo } from '@kit.BasicServicesKit'
import { CommonModifier } from '@ohos.arkui.modifier'
import { cleanLogLine, logBody } from '../domain/LogPresentation'
import type { VpnApplicationScope } from '../domain/NetworkSettings'
import { NAVIGATION_TABS, navigationIndex, navigationGlowX } from '../domain/NavigationDrag'
import { SubscriptionUsage, parseSubscriptionUsage, usageLabel, usageProgress, usageRemaining, usageExpiry } from '../domain/SubscriptionUsage'
import { responseHeaderValue } from '../domain/SubscriptionHeaders'
import { SubscriptionInfo, subscriptionInfoFromJson, subscriptionInfoFromNames } from '../domain/SubscriptionInfo'
import { APP_VERSION, CORE_VERSION, coreIsPrerelease, RELEASES_URL } from '../domain/BuildInfo'
import { checkAppUpdate } from '../services/AppUpdateService'
import { SavedUiSettings, parseSavedUiSettings } from '../domain/SavedUiSettings'
import { dashboardModes } from '../domain/RuntimeModes'
import { pasteboard } from '@kit.BasicServicesKit'
import { notificationManager } from '@kit.NotificationKit'
import { UiActivityLease } from '../domain/RuntimeActivity'
import { webview } from '@kit.ArkWeb'
import { window } from '@kit.ArkUI'
import { scanBarcode, scanCore, generateBarcode } from '@kit.ScanKit'
import { image } from '@kit.ImageKit'
import { fileIo, fileUri, WatchEvent } from '@kit.CoreFileKit'
import { wifiManager } from '@kit.ConnectivityKit'
import { ScannedProfile, parseProfileQr } from '../domain/ProfileQr'
import { SsidPolicy, SsidAction, normalizeSsidPolicy, withSsidRule } from '../domain/SsidPolicy'
import { invertApplicationSelection, perAppScope } from '../domain/PerAppPolicy'
import { writeAtomicText } from '../services/AtomicFileWriter'
import { trafficRates, TrafficSample, TrafficRates, delayColor } from '../domain/RuntimeTelemetry'
import { systemShare } from '@kit.ShareKit'
import { common } from '@kit.AbilityKit'
import { preferences } from '@kit.ArkData'
import { http, connection } from '@kit.NetworkKit'
import { picker } from '@kit.CoreFileKit'
import { hilog } from '@kit.PerformanceAnalysisKit'
import type { CoreStatus } from '../core/CoreGateway'
import { DrawerMenu, drawerRoot, drawerParent, drawerMenus } from '../domain/DrawerRoutes'
import { BackgroundSwatch, BACKGROUND_SWATCHES, normalizeBackgroundColor, backgroundColorIsDark, validBackgroundImageName } from '../domain/BackgroundAppearance'
import { panelNodeKey, panelGroupKey, panelPresentation, samePanelMap } from '../domain/GroupPanelState'
import { OptimisticChoices } from '../domain/OptimisticChoices'
import { ConnectionCoordinator } from '../services/ConnectionCoordinator'
import { SfaProfileStore } from '../services/SfaProfileStore'
import { readLocalDocument } from '../services/LocalDocumentReader'
import { LocalConfigStore } from '../services/LocalConfigStore'
import { prepareLocalConfig } from '../domain/LocalConfig'
import { configIpv6Enabled } from '../domain/Ipv6Policy'
import { SfaCatalog, SfaProfile, ProfileSaveTarget, emptySfaCatalog, saveSfaProfile, deleteSfaProfile, validateSfaContent, resolveProfileSaveTarget, profileAutoUpdateDue, effectiveAutoUpdateInterval, removeLegacyBuiltinProfiles } from '../domain/SfaProfiles'
import { ApplicationCatalogResult, ApplicationCatalogService, SelectableApplication } from '../services/ApplicationCatalogService'
import { NetworkSettings, defaultNetworkSettings, vpnApplicationScope, normalizeVpnApplicationScope, validateApplicationBundleName } from '../domain/NetworkSettings'
import { DARK_PALETTE, LIGHT_PALETTE, AppPalette } from '../ui/DesignSystem'
import { HttpsUrlGuard } from '../services/SubscriptionService'
import { TailscaleEndpointContent } from './TailscaleEndpointPage'
import type { TailscaleStatusUpdate, TailscaleEndpointStatus } from '../domain/TailscaleTypes'

interface CodedFailure { code?: number }
interface GroupItem { tag: string; type: string; urlTestDelay?: number }
interface GroupInfo { tag: string; type: string; selectable: boolean; selected: string; items: GroupItem[] }
interface GroupList { group: GroupInfo[] }
interface RuntimeMetrics { memory?: number; goroutines?: number; connectionsIn?: number; connectionsOut?: number; uplinkTotal?: number; downlinkTotal?: number }
interface LiveConnection { id: string; network?: string; domain?: string; destination?: string; inbound?: string; outbound?: string; rule?: string; uplinkTotal?: number; downlinkTotal?: number }
interface RuntimeSnapshot { suspended?: boolean; connections?: LiveConnection[]; sampledAt?: number; status?: RuntimeMetrics; groups?: GroupList; logs?: string[]; modes?: string[]; mode?: string }
interface RuntimeControl { id?: string; action: string; group?: string; outbound?: string; mode?: string }

@Entry
@Component
struct SfaIndex {
  @StorageProp('uiForeground') @Watch('onUiForegroundChanged') uiForeground: boolean = true
  @StorageProp('colorMode') @Watch('syncWindowTheme') colorMode: ColorMode = ColorMode.LIGHT
  @StorageProp('topInsetPx') topInsetPx: number = 0
  @StorageProp('bottomInsetPx') bottomInsetPx: number = 0
  @State logReturning: boolean = false
  @State logScrolled: boolean = false
  private logScroller: Scroller = new Scroller()
  private ssidScroller: Scroller = new Scroller()
  @State orderHoverId: string = ''
  @State viewportWidth: number = 360
  private orderHandlePressed: boolean = false
  @State reorderId: string = ''
  @State draggedConfigId: string = ''
  private draggedProfileId: string = ''
  private contentReleased: boolean = false
  @State drawerPinned: boolean = false
  @State sheetVisible: boolean = false
  @State sheetMode: string = ''
  @State shareVisible: boolean = false
  @State shareTitle: string = ''
  @State shareLink: string = ''
  @State shareQr: image.PixelMap | undefined = undefined
  @State viewportHeight: number = 800
  private drawerScroller: Scroller = new Scroller()
  private previousDrawerRoot: string = ''
  @State updateChecking: boolean = false
  @State showAddProfile: boolean = false
  @State importText: string = ''
  @State selectedProfileIds: string[] = []
  private webRtcController: webview.WebviewController = new webview.WebviewController()
  private activeConfig: string = ''
  @State excludedSsids: string[] = []
  @State selectedSsids: string[] = []
  @State showSsidEditor: boolean = false
  @State editingSsid: string = ''
  @State draftSsid: string = ''
  @State suspended: boolean = false
  @State recovering: boolean = false
  private lastOrphanRecoveryAt: number = 0
  @State ssidEnabled: boolean = false
  @State draftSsidAction: string = 'suspend'
  @State ssidActions: SsidAction[] = []
  @State directSsids: string = ''
  @State proxySsids: string = ''
  @State ssidFallback: string = 'keep'
  @State ssidMessage: string = ''
  @State currentSsid: string = ''
  @State liveConnections: LiveConnection[] = []
  @State connectionQuery: string = ''
  @State perAppEnabled: boolean = false
  @State perAppBypass: boolean = false
  @State applicationLoading: boolean = false
  @State applicationDirty: boolean = false
  @State applicationSearchVisible: boolean = false
  @State showSystemApplications: boolean = true
  @State applicationCatalogState: string = ''
  @State applicationMode: string = 'all'
  @State selectedApplications: string[] = []
  @State applicationCatalog: SelectableApplication[] = []
  @State applicationQuery: string = ''
  @State applicationMessage: string = ''
  @State showGroups: boolean = false
  @State expandedGroups: string[] = []
  @State testingGroup: string = ''
  @State memoryBytes: number = 0
  @State goroutines: number = 0
  @State connectionsOut: number = 0
  @State uploadHistory: number[] = [0, 0]
  @State downloadHistory: number[] = [0, 0]
  @State chartWidth: number = 120
  private trafficSample: TrafficSample | null = null
  private lastGroupTestAt: number = 0
  private groupTestBusy: boolean = false
  @State showProfilePicker: boolean = false
  @State @Watch('onSnapshotPageChanged') tab: string = 'dashboard'
  @State @Watch('onPageChanged') page: string = ''
  @State catalog: SfaCatalog = emptySfaCatalog()
  @State ready: boolean = false
  @State busy: boolean = false
  @State phase: string = 'checking'
  @State message: string = '正在检查服务状态'
  @State upload: number = 0
  @State download: number = 0
  @State uploadRate: number = 0
  @State downloadRate: number = 0
  @State connectionCount: number = 0
  @State groups: GroupInfo[] = []
  @State groupSelections: Map<string,string> = new Map()
  @State groupDelays: Map<string,number> = new Map()
  @State selectingGroup: string = ''
  @State selectingNode: string = ''
  private groupInteractionRevision: number = 0
  @State logs: string[] = []
  @State modes: string[] = []
  @State mode: string = ''
  @State logQuery: string = ''
  @State logLevel: string = 'all'
  @State groupSubscriptionRemaining: string = ''
  @State groupSubscriptionExpiry: string = ''
  @State navDragging: boolean = false
  @State navPointerX: number = 0
  @State navPreviewIndex: number = -1
  @State navBarWidth: number = 0
  private navIgnoreClickUntil: number = 0
  private runtimeProfileSessions: Map<string, string> = new Map()
  private groupSubscriptionProfile: string = ''
  private groupSubscriptionRefreshedAt: number = 0
  private usageRefreshing: boolean = false
  private usageAttemptAt: number = 0
  private usageAttemptProfile: string = ''
  private subscriptionInfoCache: Map<string, SubscriptionInfo> = new Map()
  private glassModifierCache: Map<string, CommonModifier> = new Map()
  private nativeGlassSupport: boolean | null = null
  @State theme: string = 'system'
  @State backgroundMode: string = 'default'
  @State backgroundSolidColor: string = '#E4F0FC'
  @State backgroundColorDraft: string = '#E4F0FC'
  @State backgroundImageName: string = ''
  @State backgroundImageBusy: boolean = false
  @State reduceTransparency: boolean = false
  @State protectWebRtc: boolean = true
  @State strictWebRtc: boolean = false
  @State editingId: string = ''
  @State draftName: string = ''
  @State draftKind: string = 'local'
  @State initializationError: string = ''
  @State editorError: string = ''
  @State draftUrl: string = ''
  @State draftContent: string = ''
  private editorReturnPage: string = 'profiles'
  @State draftAutoUpdate: boolean = true
  @State draftAutoUpdateInterval: string = '60'
  @State groupTag: string = ''
  @State host: string = 'example.com'
  @State toolResult: string = ''
  @State startedAt: number = 0
  @State clockMillis: number = Date.now()
  @State visibleCards: string[] = ['traffic', 'connections', 'mode', 'profiles', 'groups']
  @State tailscaleEndpoints: TailscaleEndpointStatus[] = []
  @State private coordinator: ConnectionCoordinator | null = null
  private store: SfaProfileStore | null = null
  private prefs: preferences.Preferences | null = null
  private networkSettings: NetworkSettings = defaultNetworkSettings()
  private leasePath: string = ''
  private leaseWrittenAt: number = 0
  private leaseQueue: Promise<void> = Promise.resolve()
  private pageAlive: boolean = true
  private timer: number = 0
  private runtimeWatcher: fileIo.Watcher | null = null
  private lastGroupEvent: string = ''
  private polling: boolean = false
  private previousAt: number = 0
  private previousUpload: number = 0
  private previousDownload: number = 0
  private commandEpoch: number = 0
  private choiceSession: string = ''
  private choices: OptimisticChoices = new OptimisticChoices(
    async (key: string, value: string): Promise<void> => {
      if (!this.coordinator || this.phase !== 'running') throw new Error('VPN 已停止，未执行切换')
      const command: RuntimeControl = key === 'mode' ? { action: 'mode', mode: value } :
        { action: 'select', group: key.substring(6), outbound: value }
      await this.coordinator.control(JSON.stringify(command))
    },
    (key: string, value: string): void => {
      if (key === 'mode') this.mode = value
      else { const selections: Map<string,string> = new Map(this.groupSelections); selections.set(key.substring(6),value); this.groupSelections = selections }
    },
    (message: string): void => { this.toast(message) })

  aboutToAppear(): void {
    hilog.info(0, 'SfaUI', 'Constructed page without loading the native core')
    this.pageAlive = true
    this.initialize()
  }

  aboutToDisappear(): void {
    this.stopRuntimeSubscription()
    this.navSwitchGeneration++; this.navTarget = ''
    this.pageAlive = false
    this.publishUiActivity(false)
    if (this.timer !== 0) clearInterval(this.timer)
    this.timer = 0
    // The VPN extension retains ownership. Closing this page never disconnects.
  }

  private stopRuntimeSubscription(): void {
    if (this.runtimeWatcher !== null) {
      try { this.runtimeWatcher.stop() } catch (_) {}
      this.runtimeWatcher = null
    }
  }

  private readGroupEvent(): void {
    if (!this.uiForeground || !this.pageAlive || this.phase !== 'running') return
    try {
      const text: string = fileIo.readTextSync(this.context().filesDir + '/runtime/groups-event.json')
      if (text === this.lastGroupEvent) return
      const snapshot: RuntimeSnapshot = JSON.parse(text) as RuntimeSnapshot
      if (!snapshot.groups) return
      this.lastGroupEvent = text
      this.groups = snapshot.groups.group || []
      const presentation = panelPresentation(this.groups)
      for (const tag of presentation.selections.keys()) {
        presentation.selections.set(tag, this.choices.reconcile('group:' + tag,
          presentation.selections.get(tag) || '', snapshot.sampledAt || 0))
      }
      if (!samePanelMap(this.groupSelections, presentation.selections)) this.groupSelections = presentation.selections
      if (!samePanelMap(this.groupDelays, presentation.delays)) this.groupDelays = presentation.delays
      this.refreshGroupSubscriptionInfo(this.groups, Date.now(), this.choiceSession)
    } catch (_) { /* The next subscription event supplies a complete replacement. */ }
  }

  private startRuntimeSubscription(): void {
    this.stopRuntimeSubscription()
    try {
      // Watch the directory: native events replace the target with an atomic rename.
      this.runtimeWatcher = fileIo.createWatcher(this.context().filesDir + '/runtime', 0x8 | 0x80 | 0x100,
        (event: WatchEvent): void => {
          const name: string = event.fileName.split('/').pop() || ''
          if (name === 'groups-event.json') this.readGroupEvent()
          if (name === 'status.json') this.poll().then(() => this.readGroupEvent()).catch(() => {})
        })
      this.runtimeWatcher.start()
      this.poll().then(() => this.readGroupEvent()).catch(() => {})
    } catch (_) {
      this.message = '运行状态订阅失败，请重新打开页面'
    }
  }

  private publishUiActivity(foreground: boolean): void {
    if (!this.leasePath) return
    // Bit 0 requests logs and bit 1 requests connection details.
    const details: number = foreground ? (this.page === 'connections' ? 2 :
      (this.page === '' && this.tab === 'log' ? 1 : 0)) : 0
    const lease: UiActivityLease = { foreground: foreground, updatedAt: Date.now(), snapshotDetails: details }
    this.leaseWrittenAt = lease.updatedAt
    const path: string = this.leasePath
    this.leaseQueue = this.leaseQueue.then(() => writeAtomicText(path, JSON.stringify(lease))).catch(() => {})
  }

  // Background memory release: drop subscription JSON and group caches while
  // the app is not visible. The running tunnel lives in the extension process
  // and never reads these copies, so the UI can rebuild them on return.
  private releaseBackgroundContent(): void {
    if (this.contentReleased || this.phase !== 'running' || this.page !== '') return
    const selected: string = this.catalog.selectedId
    const profiles: SfaProfile[] = this.catalog.profiles.map((profile: SfaProfile): SfaProfile => {
      return { id: profile.id, name: profile.name, kind: profile.kind, url: profile.url,
        content: profile.id === selected ? profile.content : '', updatedAt: profile.updatedAt,
        usage: profile.usage, retainedNodeTags: profile.retainedNodeTags,
        localNodeEdits: profile.localNodeEdits, autoUpdate: profile.autoUpdate,
        autoUpdateInterval: profile.autoUpdateInterval }
    })
    this.catalog = { version: 1, selectedId: selected, profiles: profiles }
    this.groups = []
    this.groupSelections = new Map<string, string>()
    this.groupDelays = new Map<string, number>()
    this.contentReleased = true
  }

  private async restoreBackgroundContent(): Promise<void> {
    if (!this.contentReleased) return
    const store: SfaProfileStore | null = this.store
    if (store === null) return
    try {
      const catalog: SfaCatalog = await store.load()
      if (this.uiForeground && this.pageAlive && this.contentReleased) {
        this.catalog = catalog
        this.contentReleased = false
      }
    } catch (_) { }
  }

  private onUiForegroundChanged(): void {
    this.stopRuntimeSubscription()
    if (!this.uiForeground) { this.navSwitchGeneration++; this.navTarget = '' }
    if (this.timer !== 0) clearInterval(this.timer)
    this.timer = 0
    const active: boolean = this.uiForeground && this.pageAlive
    this.publishUiActivity(active)
    if (active && this.ready) {
      this.restoreBackgroundContent().then(() => this.poll()).then(() => this.runAutoUpdate()).catch(() => {})
      this.startRuntimeSubscription()
    } else {
      // Keep the last bounded page snapshot for instant foreground restoration.
      // Only the sampling baseline expires; no background UI work continues.
      this.trafficSample = null
      this.releaseBackgroundContent()
    }
  }

  onBackPress(): boolean {
    this.navSwitchGeneration++; this.navTarget = ''
    if (this.showSsidEditor) { this.showSsidEditor = false; return true }
    if (this.page === 'applications') { this.finishApplications(); return true }
      if (this.page.length > 0) { this.backFromPage(); return true }
    if (this.tab !== 'dashboard') { this.tab = 'dashboard'; return true }
    return false
  }

  private context(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext
  }

  private palette(): AppPalette {
    return this.theme === 'dark' || (this.theme === 'system' && this.colorMode === ColorMode.DARK) ? DARK_PALETTE : LIGHT_PALETTE
  }

  private backgroundStop(defaultColor: string): string {
    return this.backgroundMode === 'solid' ? this.backgroundSolidColor : defaultColor
  }

  private toast(text: string): void {
    this.getUIContext().getPromptAction().showToast({ message: text, duration: 2500 })
  }

  private failureText(failure: Object | null | undefined, stage: string): string {
    if (failure !== null && failure !== undefined && typeof failure === 'object') {
      const code: number | undefined = (failure as CodedFailure).code
      if (typeof code === 'number') return stage + '失败（系统错误码 ' + code.toString() + '），原有文件未清除'
    }
    return stage + '失败，原有文件未清除'
  }

  private async initialize(): Promise<void> {
    this.initializationError = ''
    let stage: string = '读取设置'
    try {
      this.coordinator = new ConnectionCoordinator(this.context())
      this.store = new SfaProfileStore(this.context().filesDir)
      this.prefs = await preferences.getPreferences(this.context(), 'sfa-ui-v1')
      this.theme = this.prefs.getSync('theme', 'system') as string
      const savedBackground: string = this.prefs.getSync('background-mode', 'default') as string
      this.backgroundMode = ['default','solid','image'].includes(savedBackground) ? savedBackground : 'default'
      try { this.backgroundSolidColor = normalizeBackgroundColor(this.prefs.getSync('background-color', '#E4F0FC') as string) } catch (_) { this.backgroundSolidColor = '#E4F0FC' }
      this.backgroundColorDraft = this.backgroundSolidColor
      const savedImage: string = this.prefs.getSync('background-image', '') as string
      this.backgroundImageName = validBackgroundImageName(savedImage) ? savedImage : ''
      if (this.backgroundMode === 'image' && (!this.backgroundImageName || !fileIo.accessSync(this.context().filesDir + '/' + this.backgroundImageName))) this.backgroundMode = 'default'
      this.reduceTransparency = this.prefs.getSync('reduce-transparency', false) as boolean
      const ui: SavedUiSettings = parseSavedUiSettings(this.prefs.getSync('ui-settings-v1', '') as string)
      this.visibleCards = ui.visibleCards; this.expandedGroups = ui.expandedGroups
      this.showSystemApplications = ui.showSystemApplications; this.logLevel = ui.logLevel
      this.protectWebRtc = ui.protectWebRtc !== false
      this.strictWebRtc = ui.strictWebRtc === true
      const savedScope: string = this.prefs.getSync('application-scope', '') as string
      if (savedScope.length > 0) {
        const scope = normalizeVpnApplicationScope(JSON.parse(savedScope))
        this.networkSettings.applicationMode = scope.mode
        this.networkSettings.trustedApplications = scope.trustedApplications
        this.applicationMode = scope.mode
        this.selectedApplications = scope.trustedApplications.slice()
      }
      this.perAppEnabled = this.prefs.getSync('per-app-enabled', this.applicationMode !== 'all') as boolean
      this.perAppBypass = this.prefs.getSync('per-app-bypass', this.applicationMode === 'blocklist') as boolean
      this.syncWindowTheme()
      this.loadSsidPolicy()
      stage = '读取加密配置'
      this.catalog = await this.store.load()
      if (this.catalog.profiles.length === 0) {
        const previous: string | null = await new LocalConfigStore(this.context().filesDir).load()
        if (previous) {
          this.catalog = saveSfaProfile(this.catalog, { id: 'migrated-local', name: '本地配置', kind: 'local',
            url: '', content: previous, updatedAt: Date.now() })
          await this.store.save(this.catalog)
        }
      }
      const runtimePath: string = this.context().filesDir + '/runtime'
      const cleaned: SfaCatalog = removeLegacyBuiltinProfiles(this.catalog)
      if (cleaned !== this.catalog) {
        stage = '清理旧版基础配置'
        await this.persist(cleaned)
      }
      if (!await fileIo.access(runtimePath)) await fileIo.mkdir(runtimePath, true)
      this.leasePath = runtimePath + '/ui-activity.json'
    } catch (failure) {
      this.phase = 'error'
      this.message = this.failureText(failure, stage)
      this.initializationError = this.message
      hilog.error(0, 'SfaUI', 'Initialization failed: %{public}s', this.message)
    } finally {
      this.ready = true
      this.checkUpdates(false)
      this.onUiForegroundChanged()
    }
  }

  private async poll(): Promise<void> {
    if (!this.uiForeground || !this.pageAlive || this.polling || !this.coordinator || this.busy || this.navTarget.length > 0) return
    if (Date.now() - this.leaseWrittenAt >= 10000) this.publishUiActivity(true)
    this.polling = true
    try {
      const status: CoreStatus = await this.coordinator.getStatus()
      this.applyStatus(status)
      if (!status.running) this.lastGroupEvent = ''
      this.refreshSubscriptionUsage().catch(() => {})
      // 刷新 Tailscale 端点列表（用于工具页面的端点入口显示）
      try {
        const tsStatus = await this.coordinator.cachedTailscaleStatus()
        this.tailscaleEndpoints = tsStatus.endpoints ?? []
      } catch (_) { /* Tailscale 状态获取失败不影响主流程 */ }
    } catch (failure) {
      this.message = failure instanceof Error ? failure.message : '服务状态暂不可读，正在确认'
      // Do not label an unverified cached snapshot as a healthy connection.
      this.recovering = true
    } finally { this.polling = false }
  }


  private applyStatus(status: CoreStatus): void {
    if (status.sessionId && status.sessionId !== this.choiceSession) {
      this.choiceSession = status.sessionId; this.choices.reset()
    }
    const now: number = Date.now()
    this.clockMillis = now
    this.upload = status.uploadBytes
    this.download = status.downloadBytes
    this.connectionCount = status.activeConnections
    this.phase = status.lastError.length > 0 ? 'error' : (status.running ? 'running' : 'stopped')
    this.recovering = (status.stage || '').startsWith('recover')
    this.message = status.lastError || (this.recovering ? '正在自动恢复 VPN 连接' : (status.running ? '已启动' : '已停止'))
    if (status.running && this.startedAt === 0) this.startedAt = now
    if (!status.running) this.startedAt = 0
    if (status.snapshotJson) {
      try {
        const snapshot: RuntimeSnapshot = JSON.parse(status.snapshotJson) as RuntimeSnapshot
        this.suspended = snapshot.suspended === true
        if (this.suspended) { this.uploadRate = 0; this.downloadRate = 0 }
        if (this.page === 'connections') {
          this.liveConnections = (snapshot.connections || []).sort((a: LiveConnection, b: LiveConnection): number => a.id.localeCompare(b.id))
        }
        this.memoryBytes = snapshot.status?.memory || 0
        this.goroutines = snapshot.status?.goroutines || 0
        this.connectionsOut = snapshot.status?.connectionsOut || 0
        if (status.running && snapshot.sampledAt && !this.suspended) {
          const sample: TrafficSample = { session: status.sessionId || 'running', at: snapshot.sampledAt,
            upload: snapshot.status?.uplinkTotal || 0, download: snapshot.status?.downlinkTotal || 0 }
          const rates: TrafficRates | null = trafficRates(this.trafficSample, sample)
          if (rates) {
            this.uploadRate = rates.upload; this.downloadRate = rates.download
            this.uploadHistory = [...this.uploadHistory.slice(-29), rates.upload]
            this.downloadHistory = [...this.downloadHistory.slice(-29), rates.download]
            this.trafficSample = sample
          }
          this.upload = sample.upload; this.download = sample.download
        }
        if (snapshot.logs) this.logs = snapshot.logs.slice(-200)
        if (snapshot.mode) this.mode = this.choices.reconcile('mode',snapshot.mode,snapshot.sampledAt || 0)
        if (snapshot.modes) this.modes = dashboardModes(snapshot.modes, this.mode)
      } catch (_) { this.message = '运行数据格式错误' }
    }
    if (!status.running) {
      this.choices.reset(); this.choiceSession = ''
      this.groupSubscriptionRemaining = ''; this.groupSubscriptionExpiry = ''
      this.groupSubscriptionProfile = ''; this.groupSubscriptionRefreshedAt = 0
      this.liveConnections = []; this.groups = []; this.modes = []; this.mode = ''; this.trafficSample = null
      this.groupSelections = new Map(); this.groupDelays = new Map()
      this.uploadRate = 0; this.downloadRate = 0; this.uploadHistory = [0, 0]; this.downloadHistory = [0, 0]
      this.showGroups = false; this.lastGroupTestAt = 0
    } else if (this.showGroups && now - this.lastGroupTestAt > 30000) { this.refreshGroupDelays() }
  }

  private openGroups(): void {
    this.showGroups = true
    this.refreshGroupDelays()
  }

  private toggleGroup(tag: string): void {
    this.expandedGroups = this.expandedGroups.includes(tag) ? this.expandedGroups.filter((value: string) => value !== tag) : [...this.expandedGroups, tag]
    this.saveUiSettings()
  }

  private async refreshGroupDelays(tag: string = ''): Promise<void> {
    if (!this.uiForeground || !this.pageAlive || this.suspended || !this.coordinator || this.groupTestBusy || this.busy || this.phase !== 'running') return
    this.groupTestBusy = true; this.testingGroup = tag || '*'; this.lastGroupTestAt = Date.now()
    const revision: number = this.groupInteractionRevision
    try {
      for (const group of this.groups) {
        if (!this.uiForeground || !this.pageAlive || this.suspended || this.busy || revision !== this.groupInteractionRevision) break
        if (tag.length === 0 || group.tag === tag) {
          await this.coordinator.control(JSON.stringify({ action: 'urltest', group: group.tag } as RuntimeControl))
        }
      }
    } catch (failure) { this.toast(failure instanceof Error ? failure.message : '测速请求失败') }
    finally { this.groupTestBusy = false; this.testingGroup = ''; await this.poll() }
  }

  private nodeType(type: string): string {
    if (type === 'selector') return 'Selector'
    if (type === 'urltest') return 'URLTest'
    if (type === 'vless') return 'VLESS'
    if (type === 'hysteria2') return 'Hysteria2'
    if (type === 'direct') return 'Direct'
    if (type === 'block') return 'Block'
    return type
  }

  private chartPoints(values: number[]): number[][] {
    const max: number = Math.max(1, ...values)
    return values.map((value: number, index: number) => [index * this.chartWidth / Math.max(1, values.length - 1), 72 - value / max * 68])
  }

  private elapsed(): string {
    const seconds: number = Math.max(0, Math.floor((this.clockMillis - this.startedAt) / 1000))
    return Math.floor(seconds / 60).toString() + ':' + (seconds % 60).toString().padStart(2, '0')
  }

  private selectedProfile(): SfaProfile | undefined {
    return this.catalog.profiles.find((profile: SfaProfile) => profile.id === this.catalog.selectedId)
  }

  private async persist(catalog: SfaCatalog, animateOrder: boolean = false): Promise<void> {
    if (!this.store) throw new Error('配置存储尚未就绪')
    await this.store.save(catalog)
    this.subscriptionInfoCache.clear()
    this.groupSubscriptionRemaining = ''; this.groupSubscriptionExpiry = ''
    this.groupSubscriptionProfile = ''; this.groupSubscriptionRefreshedAt = 0
    if(animateOrder)animateTo({duration:240,curve:Curve.EaseInOut},()=>{this.catalog=catalog})
    else if (!this.contentReleased) this.catalog = catalog
  }

  private async toggleService(): Promise<void> {
    if (!this.coordinator || (this.busy && this.phase !== 'running') || !this.ready) return
    const epoch: number = ++this.commandEpoch
    this.busy = true
    try {
      if (this.phase === 'running' || this.phase === 'error') {
        this.phase = 'stopping'; this.message = '正在停止'
        this.applyStatus(await this.coordinator.disconnect())
      } else {
        const profile: SfaProfile | undefined = this.selectedProfile()
        if (!profile) { this.toast('请先添加配置'); this.page = 'profiles'; return }
        this.phase = 'starting'; this.message = '正在启动'
        const config: string = this.runtimeConfig(profile)
        const status: CoreStatus = await this.connectProfile(config, vpnApplicationScope(this.networkSettings), profile.id)
        if (epoch === this.commandEpoch) this.applyStatus(status)
        this.activeConfig = config
      }
    } catch (failure) {
      this.phase = 'error'; this.message = failure instanceof Error ? failure.message : '启动失败'
      this.toast(this.message)
    } finally { this.busy = false }
  }

  private async notificationsAllowed(): Promise<boolean> {
    try {
      if (await notificationManager.isNotificationEnabled()) return true
      try { await notificationManager.requestEnableNotification(this.context()) } catch (_) { }
      return await notificationManager.isNotificationEnabled()
    } catch (_) { return true }
  }

  private async connectProfile(config: string, scope: VpnApplicationScope, profileId: string): Promise<CoreStatus> {
    if (!this.coordinator) throw new Error('连接服务尚未就绪')
    if (!await this.notificationsAllowed()) {
      throw new Error('通知被关闭：鸿蒙要求 VPN 运行期间显示常驻通知，请允许通知后再启动')
    }
    const status: CoreStatus = await this.coordinator.connect(config, scope, profileId)
    if (status.sessionId && status.running) { this.runtimeProfileSessions.clear(); this.runtimeProfileSessions.set(status.sessionId, profileId) }
    return status
  }

  private async selectProfile(id: string): Promise<void> {
    if (this.busy || id === this.catalog.selectedId) return
    this.busy = true
    try { await this.switchSelection(id) } finally { this.busy = false }
  }

  // Selection switch without the busy guard: persists the catalog selection
  // and, when the VPN is running, hot-switches via reloadProfile.
  private async switchSelection(id: string): Promise<void> {
    const wasRunning: boolean = this.phase === 'running'
    const epoch: number = ++this.commandEpoch
    const previous: SfaCatalog = this.catalog
    this.catalog = {version:1,profiles:previous.profiles,selectedId:id}
    try {
      await this.persist({ version: 1, profiles: this.catalog.profiles, selectedId: id })
      const profile: SfaProfile | undefined = this.selectedProfile()
      if (wasRunning && this.coordinator && profile && epoch === this.commandEpoch) {
        const config: string = this.runtimeConfig(profile)
        const status: CoreStatus = await this.coordinator.reloadProfile(config, vpnApplicationScope(this.networkSettings), profile.id)
        if (status.sessionId && status.running) { this.runtimeProfileSessions.clear(); this.runtimeProfileSessions.set(status.sessionId, profile.id) }
        this.choices.reset()
        this.applyStatus(status)
        this.activeConfig = config
      }
    } catch (failure) {
      this.message = failure instanceof Error ? failure.message : '配置切换失败'
      await this.persist(previous)
      this.toast(this.message)
    }
  }

  private editProfile(profile?: SfaProfile): void {
    this.editorReturnPage = this.page === '' && this.tab === 'dashboard' ? '' : 'profiles'
    this.editorError = ''
    this.editingId = profile?.id || ''
    this.draftName = profile?.name || ''
    this.draftKind = profile?.kind || 'local'
    this.draftUrl = profile?.url || ''
    this.draftContent = profile?.content || ''
    this.draftAutoUpdate = profile === undefined ? true : profile.autoUpdate === true
    this.draftAutoUpdateInterval = String(profile?.autoUpdateInterval || 60)
    this.page = 'editor'
  }

  private async downloadRaw(url: string, validateJson: boolean = true, onUsage?: (usage: SubscriptionUsage | undefined) => void, headersOnly: boolean = false): Promise<string> {
    if (!/^https:\/\//i.test(url.trim())) throw new Error('远程配置需要 HTTPS 地址')
    const request: http.HttpRequest = http.createHttp()
    try {
      const redirect: HttpsUrlGuard = new HttpsUrlGuard(http.InterceptorType.REDIRECTION, 3)
      const final: HttpsUrlGuard = new HttpsUrlGuard(http.InterceptorType.FINAL_RESPONSE)
      const chain: http.HttpInterceptorChain = new http.HttpInterceptorChain()
      if (!chain.addChain([redirect, final]) || !chain.apply(request)) throw new Error('无法设置下载安全检查')
      const response: http.HttpResponse = await request.request(url.trim(), {
        method: headersOnly ? http.RequestMethod.HEAD : http.RequestMethod.GET, expectDataType: http.HttpDataType.STRING,
        maxLimit: 4194304, connectTimeout: 15000, readTimeout: 20000, usingCache: false,
        header: { 'User-Agent': 'sing-box/1.14.4 (HarmonyOS)' }
      })
      if (redirect.rejectedInsecureUrl() || final.rejectedInsecureUrl() || redirect.exceededInvocationLimit() || !final.observedUrl()) {
        throw new Error('远程配置重定向不符合 HTTPS 要求')
      }
      if (response.responseCode < 200 || response.responseCode >= 300 || (!headersOnly && typeof response.result !== 'string')) {
        throw new Error(`配置下载失败：HTTP ${response.responseCode}`)
      }
      if (!headersOnly && validateJson) validateSfaContent(response.result as string)
      if (onUsage) onUsage(parseSubscriptionUsage(responseHeaderValue(JSON.stringify(response.header), 'subscription-userinfo'), Date.now()))
      return headersOnly ? '' : response.result as string
    } finally { request.destroy() }
  }

  private async saveUpdatedProfile(profile: SfaProfile): Promise<boolean> {
    const previous: SfaCatalog = this.catalog
    const original = previous.profiles.find((item: SfaProfile): boolean => item.id === profile.id)
    const coordinator: ConnectionCoordinator | null = this.phase === 'running' &&
      previous.selectedId === profile.id && original !== undefined && original.content !== profile.content ?
      this.coordinator : null
    const config: string = coordinator === null ? '' : this.runtimeConfig(profile)
    await this.persist(saveSfaProfile(previous, profile))
    if (coordinator === null) return false
    try {
      const status = await coordinator.reloadProfile(config, vpnApplicationScope(this.networkSettings), profile.id, true)
      if (status.sessionId && status.running) this.runtimeProfileSessions.set(status.sessionId, profile.id)
      this.choices.reset()
      this.applyStatus(status)
      this.activeConfig = config
      return true
    } catch (failure) {
      await this.persist(previous)
      throw new Error(failure instanceof Error ? failure.message : '配置应用失败')
    }
  }

  private async saveEditor(): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.editorError = ''
    let stage: string = this.draftKind === 'remote' ? '下载配置' : '读取配置'
    try {
      // A repeat scan/save of the same remote URL overwrites the catalog
      // entry that already holds it instead of creating a duplicate.
      const target: ProfileSaveTarget = resolveProfileSaveTarget(this.catalog, this.editingId, this.draftKind, this.draftUrl)
      if (target.mode === 'update' && this.editingId !== target.targetId) this.editingId = target.targetId
      const original: SfaProfile | undefined = this.catalog.profiles.find((item: SfaProfile) => item.id === this.editingId)
      // A remote save with empty draft content is a scan/import-link save:
      // the content is (re)downloaded from the source, so it is not a local
      // edit and never needs the overwrite/copy dialog.
      const scanSave: boolean = this.draftKind === 'remote' && this.draftContent.trim().length === 0
      const modified: boolean = original !== undefined && !scanSave && this.draftContent !== original.content
      const edited: boolean = original !== undefined && !scanSave && (modified || this.draftName.trim() !== original.name || this.draftKind !== original.kind || this.draftUrl.trim() !== original.url)
      let saveCopy: boolean = false
      if (edited) {
        validateSfaContent(this.draftContent)
        const result = await this.getUIContext().getPromptAction().showDialog({
          title: '如何保存配置？', message: '覆盖原配置后，远程订阅更新会覆盖本次修改。另存为本地配置可独立保留。',
          buttons: [{ text: '继续编辑', color: this.palette().textSecondary }, { text: '覆盖原配置', color: this.palette().danger }, { text: '另存配置', color: this.palette().accent }]
        })
        if (result.index === 0) return
        saveCopy = result.index === 2
      }
      let downloadedUsage: SubscriptionUsage | undefined = undefined
      const needsDownload: boolean = this.draftKind === 'remote' && !saveCopy && (scanSave || !original || this.draftUrl.trim() !== original.url)
      const content: string = needsDownload ? await this.downloadRaw(this.draftUrl, true, (usage: SubscriptionUsage | undefined) => { downloadedUsage = usage }) : this.draftContent
      stage = '校验配置 JSON'
      validateSfaContent(content)
      const baseName: string = (this.draftName.trim() || '未命名配置') + (saveCopy ? '（本地修改）' : '')
      let profileName: string = baseName; let suffix: number = 2
      while(this.catalog.profiles.some((item:SfaProfile)=>item.name===profileName&&(saveCopy||item.id!==this.editingId)))profileName=baseName+' '+suffix++
      const profile: SfaProfile = { id: saveCopy ? `profile-${Date.now()}` : this.editingId || `profile-${Date.now()}`, name: profileName,
        kind: saveCopy ? 'local' : this.draftKind, url: !saveCopy && this.draftKind === 'remote' ? this.draftUrl.trim() : '', content: content, updatedAt: saveCopy || needsDownload || !original || content !== original.content ? Date.now() : original.updatedAt,
        usage: !saveCopy && this.draftKind === 'remote' ? (downloadedUsage || (original?.url === this.draftUrl.trim() ? original?.usage : undefined)) : undefined,
        retainedNodeTags: !saveCopy ? original?.retainedNodeTags : undefined,
        autoUpdate: !saveCopy && this.draftKind === 'remote' ? this.draftAutoUpdate : undefined,
        autoUpdateInterval: !saveCopy && this.draftKind === 'remote' ? Math.max(15, Math.trunc(Number(this.draftAutoUpdateInterval) || 60)) : undefined,
        localNodeEdits: !saveCopy && this.draftKind === 'remote' && (modified || original?.localNodeEdits === true) }
      stage = '保存加密配置'
      const applied: boolean = await this.saveUpdatedProfile(profile)
      // Auto-select the saved profile (aligned with SFA andSelect=true).
      // saveCopy keeps the current selection; an in-place update of the
      // already-selected profile needs no switch.
      if (!saveCopy && profile.id !== this.catalog.selectedId) {
        let switchNow: boolean = this.phase !== 'running'
        if (this.phase === 'running') {
          const decision = await this.getUIContext().getPromptAction().showDialog({
            title: '切换到新配置？', message: '新配置已保存，VPN 正在运行其它配置，是否切换？',
            buttons: [{ text: '暂不切换', color: this.palette().textSecondary }, { text: '切换', color: this.palette().accent }]
          })
          switchNow = decision.index === 1
        }
        if (switchNow) await this.switchSelection(profile.id)
      }
      this.page = this.editorReturnPage; this.toast(saveCopy ? '已另存本地配置，原配置及当前连接保持不变' : (applied ? '配置已保存并应用' : '配置已保存'))
    } catch (failure) { this.editorError = this.failureText(failure, stage); this.toast(this.editorError) }
    finally { this.busy = false }
  }

  private async importFile(): Promise<void> {
    if (this.busy) return
    try {
      const documentPicker: picker.DocumentViewPicker = new picker.DocumentViewPicker(this.context())
      const files: string[] = await documentPicker.select({ maxSelectNumber: 1 })
      if (files.length === 0) return
      this.draftContent = await readLocalDocument(files[0])
      validateSfaContent(this.draftContent)
      this.draftKind = 'local'
      this.page = 'editor'
      if (!this.draftName) this.draftName = decodeURIComponent(files[0].split('/').pop() || '本地配置').replace(/\.json$/i, '')
      this.toast('文件已读取，确认名称后保存')
    } catch (failure) { this.toast(failure instanceof Error ? failure.message : '文件读取失败') }
  }

  private subscriptionRefreshInProgress: boolean = false
  private subscriptionRefreshAttempts: Map<string, number> = new Map<string, number>()

  private canCommitSubscriptionRefresh(): boolean {
    return this.pageAlive && !this.busy && this.phase !== 'starting' && this.phase !== 'stopping'
  }

  private async runAutoUpdate(): Promise<void> {
    if (!this.uiForeground || this.contentReleased || this.subscriptionRefreshInProgress ||
      !this.canCommitSubscriptionRefresh()) return
    const store = this.store
    if (store === null) return
    const now: number = Date.now()
    const due: SfaProfile[] = this.catalog.profiles.filter((profile: SfaProfile): boolean => {
      const lastAttempt: number = this.subscriptionRefreshAttempts.get(profile.id) ?? 0
      return profileAutoUpdateDue(profile, now) && now - lastAttempt >= effectiveAutoUpdateInterval(profile) * 60000
    }).slice(0, 3)
    this.subscriptionRefreshInProgress = true
    try {
      for (const profile of due) {
        if (!this.uiForeground || !this.canCommitSubscriptionRefresh()) break
        this.subscriptionRefreshAttempts.set(profile.id, Date.now())
        try {
          let usage: SubscriptionUsage | undefined = undefined
          const candidate: string = await this.downloadRaw(profile.url, true,
            (value: SubscriptionUsage | undefined): void => { usage = value })
          // The background UI can hold a catalog with some JSON bodies removed.
          const catalog: SfaCatalog = this.contentReleased ? await store.load() : this.catalog
          if (!this.canCommitSubscriptionRefresh()) break
          const current = catalog.profiles.find((item: SfaProfile): boolean => item.id === profile.id)
          if (!current || current.url !== profile.url || current.content !== profile.content ||
            current.updatedAt !== profile.updatedAt || !profileAutoUpdateDue(current, Date.now())) continue
          const next: SfaProfile = { id: current.id, name: current.name, kind: current.kind,
            url: current.url, content: candidate, updatedAt: Date.now(), usage: usage || current.usage,
            retainedNodeTags: current.retainedNodeTags, localNodeEdits: current.localNodeEdits,
            autoUpdate: current.autoUpdate, autoUpdateInterval: current.autoUpdateInterval }
          this.runtimeConfig(next)
          // The encrypted store stages and verifies the write before promotion.
          // Automatic refresh must not reload the active tunnel.
          this.busy = true
          try { await this.persist(saveSfaProfile(catalog, next)) }
          finally { this.busy = false }
        } catch (_) { /* Keep the last successfully saved profile. */ }
      }
    } finally { this.subscriptionRefreshInProgress = false }
  }

  private async updateProfile(profile: SfaProfile): Promise<void> {
    if (this.busy || profile.kind !== 'remote') return
    this.busy = true
    try {
      let downloadedUsage: SubscriptionUsage | undefined = undefined
      const content: string = await this.downloadRaw(profile.url, true, (usage: SubscriptionUsage | undefined) => { downloadedUsage = usage })
      const current: SfaProfile | undefined = this.catalog.profiles.find((item: SfaProfile) => item.id === profile.id)
      if (current === undefined || current.url !== profile.url || current.content !== profile.content) {
        throw new Error('配置已变化，请重试')
      }
      const applied: boolean = await this.saveUpdatedProfile({
        id: current.id, name: current.name, kind: current.kind, url: current.url, content: content,
        updatedAt: Date.now(), usage: downloadedUsage || current.usage,
        autoUpdate: current.autoUpdate, autoUpdateInterval: current.autoUpdateInterval
      })
      this.toast(applied ? '配置已更新并应用' : '配置已更新')
    } catch (failure) { this.toast(failure instanceof Error ? failure.message : '更新失败') }
    finally { this.busy = false }
  }

  private removeProfile(profile: SfaProfile): void {
    if (this.busy) return
    if (this.phase === 'running' && profile.id === this.catalog.selectedId) { this.toast('请先停止当前配置'); return }
    this.getUIContext().getPromptAction().showDialog({ title: '删除配置', message: profile.name,
      buttons: [{ text: '取消', color: '#666666' }, { text: '删除', color: '#BA1A1A' }] }).then(async (result) => {
      if (result.index === 1) {
        try { await this.persist(deleteSfaProfile(this.catalog, profile.id)) }
        catch (_) { this.toast('删除失败，原配置已保留') }
      }
    })
  }

  private async control(command: RuntimeControl): Promise<void> {
    if (!this.coordinator || this.busy || this.phase !== 'running') return
    this.busy = true
    try { await this.coordinator.control(JSON.stringify(command)) }
    catch (failure) { this.toast(failure instanceof Error ? failure.message : '操作失败') }
    finally { this.busy = false; await this.poll() }
  }

  private selectMode(mode: string): void {
    if (!this.coordinator || this.busy || this.phase !== 'running' || this.mode === mode) return
    this.groupInteractionRevision++
    this.choices.choose('mode',mode,this.mode)
  }

  private async testGroupItem(item: GroupItem): Promise<void> {
    if (!this.coordinator || this.busy) return
    this.busy = true
    try { const delay: number = await this.coordinator.urlTest(item.tag); this.toast(`${item.tag} · ${delay} ms`) }
    catch (failure) { this.toast(failure instanceof Error ? failure.message : '测速失败') }
    finally { this.busy = false }
  }

  private async saveUiSettings(): Promise<void> {
    if (!this.prefs) return
    const settings: SavedUiSettings = { version: 2, protectWebRtc: this.protectWebRtc, strictWebRtc: this.strictWebRtc, visibleCards: this.visibleCards.slice(), expandedGroups: this.expandedGroups.slice(),
      showSystemApplications: this.showSystemApplications, logLevel: this.logLevel }
    try { this.prefs.putSync('ui-settings-v1', JSON.stringify(settings)); await this.prefs.flush() }
    catch (_) { this.toast('界面设置未能保存，请重试') }
  }

  private async saveTrafficPrivacy(): Promise<void> {
    if (!this.prefs || this.busy) return
    this.busy = true
    try {
      const settings: SavedUiSettings = { version: 2, protectWebRtc: this.protectWebRtc, strictWebRtc: this.strictWebRtc,
        visibleCards: this.visibleCards.slice(), expandedGroups: this.expandedGroups.slice(), showSystemApplications: this.showSystemApplications, logLevel: this.logLevel }
      this.prefs.putSync('ui-settings-v1', JSON.stringify(settings))
      await this.prefs.flush()
      const profile: SfaProfile | undefined = this.selectedProfile()
      if (this.phase === 'running' && profile && this.coordinator) {
        const config: string = this.runtimeConfig(profile)
        this.applyStatus(await this.coordinator.disconnect())
        this.applyStatus(await this.connectProfile(config, vpnApplicationScope(this.networkSettings), profile.id))
      }
    } catch (failure) { this.toast(failure instanceof Error ? failure.message : '隐私设置保存失败') }
    finally { this.busy = false }
  }

  private async saveAppearance(): Promise<boolean> {
    this.syncWindowTheme()
    if (!this.prefs) return false
    try {
      this.prefs.putSync('theme', this.theme)
      this.prefs.putSync('reduce-transparency', this.reduceTransparency)
      this.prefs.putSync('background-mode', this.backgroundMode)
      this.prefs.putSync('background-color', this.backgroundSolidColor)
      this.prefs.putSync('background-image', this.backgroundImageName)
      await this.prefs.flush()
      return true
    } catch (_) { this.toast('外观设置未能保存'); return false }
  }

  private formatBytes(value: number): string {
    if (value < 1024) return `${Math.round(value)} B`
    if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`
    if (value < 1073741824) return `${(value / 1048576).toFixed(1)} MB`
    return `${(value / 1073741824).toFixed(2)} GB`
  }

  private title(): string {
    if (this.page === 'configuration') return '配置'
    if (this.page === 'add-profile') return '添加配置'
    if (this.page === 'tailscale') return 'Tailscale'
    if (this.page === 'dns-query') return 'DNS 查询'
    if (this.page === 'sources') return '开源项目与源码地址'
    if (this.page === 'ssid') return '按需连接'
    if (this.page === 'connections') return '连接'
    if (this.page === 'applications') return '分应用代理'
    if (this.page === 'profiles') return '配置'
    if (this.page === 'json-editor') return '配置 JSON'
    if (this.page === 'editor') return this.editingId ? '编辑配置' : '新建配置'
    if (this.page === 'import') return '导入配置'
    if (this.page === 'groups') return this.groupTag || '代理组'
    if (this.page === 'webrtc') return 'WebRTC 网络检测'
    if (this.page === 'appearance') return '应用设置'
    if (this.page === 'privacy') return 'WebRTC 防护'
    if (this.page === 'about') return '关于'
    if (this.page === 'cards') return '仪表盘项目'
    if (this.tab === 'log') return '日志'
    if (this.tab === 'tools') return '工具'
    if (this.tab === 'settings') return '设置'
    return '仪表'
  }

  @Builder
  icon(name: string, size: number = 24) {
    Image($rawfile(`sfa-${name}.svg`)).width(size).height(size).fillColor(this.palette().textPrimary)
  }

  @Builder
  appToolbar(inDrawer: boolean = false) {
    // Real title/actions live inside the supported native TabBar region.
    // A material-only background builder does not move the controls there.
    Tabs({barPosition:BarPosition.End}) {
      TabContent() { Column() }.tabBar(this.toolbarFace(inDrawer))
    }.width('100%').height(64).barHeight(64).barBackgroundColor(Color.Transparent)
      .barMode(BarMode.Fixed).scrollable(false).clip(false)
  }

  @Builder
  toolbarFace(inDrawer: boolean = false) {
    Row({ space: 12 }) {
      if (this.page.length > 0) {
        Button('‹').fontSize(30).width(44).height(44).backgroundColor(Color.Transparent)
          .fontColor(this.palette().textPrimary).borderRadius(22).attributeModifier(this.toolbarLensModifier()).onClick(() => this.backFromPage())
      }
      Row() {
        Stack() {
          Text(this.title()).fontSize(22).fontWeight(FontWeight.Normal).fontColor(this.palette().textPrimary)
            .height(44).padding({left:12,right:12}).constraintSize({maxWidth:'100%'})
            .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
        }.height(44).borderRadius(14).attributeModifier(this.toolbarLensModifier())
      }.layoutWeight(1)
      if (this.page === 'applications') {
        Button('⌕').width(40).height(44).fontSize(26).backgroundColor(Color.Transparent).fontColor(this.palette().textPrimary)
          .borderRadius(22).attributeModifier(this.toolbarLensModifier())
          .onClick(() => { this.applicationSearchVisible = !this.applicationSearchVisible })
        Button('⋮').width(40).height(44).fontSize(25).backgroundColor(Color.Transparent).fontColor(this.palette().textPrimary)
          .borderRadius(22).attributeModifier(this.toolbarLensModifier())
          .bindMenu([
            { value: '全选', action: () => this.selectVisibleApplications(false) },
            { value: '反选', action: () => this.selectVisibleApplications(true) },
            { value: '显示 / 隐藏系统应用', action: () => { this.showSystemApplications = !this.showSystemApplications; this.saveUiSettings() } },
            { value: '刷新应用列表', action: () => this.loadApplications() },
            { value: '导入包名名单', action: () => this.importApplications() }
          ])
      } else if (this.page === 'profiles') {
        Button('+').width(48).height(48).fontSize(28).backgroundColor(Color.Transparent)
          .fontColor(this.palette().textPrimary).borderRadius(22).attributeModifier(this.toolbarLensModifier()).onClick(() => { this.page = 'add-profile' })
      } else if (this.page === 'json-editor') {
        Button('完成').fontSize(14).backgroundColor(Color.Transparent).fontColor(this.palette().accent)
          .height(44).borderRadius(22).attributeModifier(this.toolbarLensModifier())
          .onClick(() => { this.page = 'editor' })
      } else if (this.page === 'editor') {
        Button('保存').fontSize(14).backgroundColor(Color.Transparent).fontColor(this.palette().accent)
          .height(44).borderRadius(22).attributeModifier(this.toolbarLensModifier())
          .enabled(!this.busy && this.editorHasChanges()).onClick(() => this.saveEditor())
      } else if (this.tab === 'dashboard' && this.page === '') {
        Button('⋮').width(44).height(44).fontSize(26).backgroundColor(Color.Transparent)
          .fontColor(this.palette().textPrimary).borderRadius(22).attributeModifier(this.toolbarLensModifier()).onClick(() => { this.page = 'cards' })
      } else if (this.tab === 'log' && this.page === '') {
        Button('清空').fontSize(14).backgroundColor(Color.Transparent).fontColor(this.palette().accent)
          .height(44).borderRadius(22).attributeModifier(this.toolbarLensModifier())
          .enabled(this.phase === 'running' && !this.busy).onClick(() => this.control({ action: 'clear-logs' }))
      }
      if (inDrawer) {
        Button('收起').height(36).fontSize(13).backgroundColor(Color.Transparent).fontColor(this.palette().accent)
          .borderRadius(18).attributeModifier(this.toolbarLensModifier()).onClick(()=>this.backFromDrawer())
      }
    }.width('100%').height(64).padding({ left: this.page.length > 0 ? 8 : 16, right: 12 })
  }

  @Builder
  statistic(title: string) {
    Column({ space: 4 }) {
      Row({ space: 8 }) {
        this.icon(title === '上传' ? 'upload' : 'download', 20)
        Text(title).fontSize(16).fontWeight(FontWeight.Bold).fontColor(this.palette().textPrimary)
      }.width('100%').margin({ bottom: 4 })
      Text(`${this.formatBytes(title === '上传' ? this.uploadRate : this.downloadRate)}/s`).fontSize(25).fontColor(this.palette().textPrimary).width('100%').maxLines(1)
      Text(this.formatBytes(title === '上传' ? this.upload : this.download)).fontSize(14).fontColor(this.palette().textSecondary).width('100%')
      Blank().height(16)
      Polyline().points(this.chartPoints(title === '上传' ? this.uploadHistory : this.downloadHistory))
        .width('100%').height(76).stroke(this.palette().accent).strokeWidth(2).fill(Color.Transparent)
        .onAreaChange((_old: Area, area: Area) => { this.chartWidth = Number(area.width) })
    }.layoutWeight(1).alignItems(HorizontalAlign.Start).padding(16)
      .backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass).borderRadius(12)
        .backgroundEffect({ radius: this.reduceTransparency ? 0 : 18, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
        .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#33FFFFFF' : '#99FFFFFF' })
  }

  @Builder
  metricRow(label: string, value: string) {
    Row() {
      Text(label).fontSize(14).fontColor(this.palette().textSecondary).layoutWeight(1)
      Text(value).fontSize(16).fontColor(this.palette().textPrimary)
    }.width('100%')
  }

  @Builder
  diagnosticsCard(debug: boolean) {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        this.icon(debug ? 'debug' : 'connections', 20)
        Text(debug ? '调试' : '连接').fontSize(16).fontWeight(FontWeight.Bold).fontColor(this.palette().textPrimary)
      }.width('100%').margin({ bottom: 4 })
      Row() {
        Text(debug ? '内存' : '入站').layoutWeight(1).fontColor(this.palette().textSecondary)
        Text(debug ? this.formatBytes(this.memoryBytes) : this.connectionCount.toString()).fontColor(this.palette().textPrimary)
      }.width('100%')
      Row() {
        Text(debug ? '协程' : '出站').layoutWeight(1).fontColor(this.palette().textSecondary)
        Text(debug ? this.goroutines.toString() : this.connectionsOut.toString()).fontColor(this.palette().textPrimary)
      }.width('100%')
    }.layoutWeight(1).padding(16).backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass).borderRadius(12)
        .backgroundEffect({ radius: this.reduceTransparency ? 0 : 18, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
        .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#33FFFFFF' : '#99FFFFFF' })
      .onClick(() => { if (!debug) this.page = 'connections' })
  }

  private profileAge(profile: SfaProfile | undefined): string {
    if (!profile) return ''
    const minutes: number = Math.max(0, Math.floor((Date.now() - profile.updatedAt) / 60000))
    return minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时前` : `${Math.floor(minutes / 1440)} 天前`
  }

  private openSheet(mode: string): void { this.sheetMode = mode; this.sheetVisible = true }

  private async presentShare(title: string, link: string): Promise<void> {
    this.shareTitle = title; this.shareLink = link; this.shareQr = undefined; this.openSheet('share')
    if (!link) return
    try {
      this.shareQr = await generateBarcode.createBarcode(link, { scanType: scanCore.ScanType.QR_CODE,
        height: 360, width: 360, backgroundColor: 0xFFFFFF, pixelMapColor: 0x000000 } as generateBarcode.CreateOptions)
    } catch (_) { this.shareQr = undefined }
  }

  private shareProfileEntry(profile: SfaProfile): void {
    // Remote profiles are reproducible from the link; a local profile is only
    // the JSON itself, so hand the file to the system share sheet.
    if (profile.kind === 'remote') { this.presentShare(profile.name, profile.url); return }
    this.shareLocalProfileFile(profile)
  }

  private async shareLocalProfileFile(profile: SfaProfile): Promise<void> {
    try {
      const safe: string = profile.name.replace(/[\\/:*?"<>|\s]+/g, '_')
      const path: string = this.context().cacheDir + '/' + safe + '.json'
      const handle: fileIo.File = fileIo.openSync(path, fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC)
      fileIo.writeSync(handle.fd, profile.content)
      fileIo.closeSync(handle)
      const data: systemShare.SharedData = new systemShare.SharedData({ utd: 'general.file',
        uri: fileUri.getUriFromPath(path), title: safe + '.json' })
      await new systemShare.ShareController(data).show(this.context(), {})
    } catch (_) { this.toast('无法分享配置文件') }
  }

  private async copyShareLink(): Promise<void> {
    if (!this.shareLink) return
    try { await pasteboard.getSystemPasteboard().setData(pasteboard.createPlainTextData(this.shareLink)); this.toast('链接已复制') }
    catch (_) { this.toast('复制失败') }
  }

  @Builder
  mainSheet() {
    if (this.sheetMode === 'add') this.addProfileSheet()
    else if (this.sheetMode === 'picker') this.profilePicker()
    else this.shareLinkSheet()
  }

  @Builder
  shareLinkSheet() {
    Column({ space: 16 }) {
      Text(this.shareTitle).fontSize(18).fontColor(this.palette().textPrimary).width('100%').maxLines(2)
      if (this.shareQr) {
        Image(this.shareQr).width(220).height(220).borderRadius(12).backgroundColor(Color.White).objectFit(ImageFit.Contain)
      }
      Text(this.shareLink).fontSize(12).fontColor(this.palette().textSecondary).width('100%').maxLines(4).copyOption(CopyOptions.InApp)
      Button('复制链接').width('100%').height(44).onClick(() => this.copyShareLink())
      Button('关闭').width('100%').height(42).backgroundColor(Color.Transparent).fontColor(this.palette().textSecondary)
        .onClick(() => { this.sheetVisible = false })
    }.width('100%').padding({ left: 20, right: 20, top: 20, bottom: 24 })
  }

  @Builder
  profileStartActions(profile: SfaProfile) {
    Row() {
      Column() { Text('编辑').fontSize(13).fontColor(Color.White) }
        .width(72).height('100%').justifyContent(FlexAlign.Center).backgroundColor('#1E6FFF').borderRadius(12)
        .onClick(() => { this.editProfile(profile) })
      Column() { Text('分享').fontSize(13).fontColor(Color.White) }
        .width(72).height('100%').justifyContent(FlexAlign.Center).backgroundColor('#6B7A8F').borderRadius(12)
        .margin({ left: 6 }).onClick(() => { this.shareProfileEntry(profile) })
    }
  }

  @Builder
  orderDragPreview(title: string, detail: string, trailing: string) {
    Row({space:12}) {
      Text('⠿').fontSize(22).fontColor(this.palette().accent).width(28)
      Column({space:4}) {
        Text(title).fontSize(16).fontColor(this.palette().textPrimary).maxLines(2)
        Text(detail).fontSize(12).fontColor(this.palette().textSecondary).maxLines(1)
      }.layoutWeight(1).alignItems(HorizontalAlign.Start)
      if(trailing.length>0)Text(trailing).fontSize(12).fontColor(this.palette().accent)
    }.width(Math.max(240,this.viewportWidth-32)).constraintSize({minHeight:76})
      .padding(16).backgroundColor(this.palette().surfaceElevated).borderRadius(12)
      .border({width:1.5,color:this.palette().accent})
      .shadow({radius:16,color:'#44000000',offsetY:6})
  }


  @Builder
  pickerEditAction(profile: SfaProfile) {
    Column() { Text('编辑').fontSize(14).fontColor(Color.White) }
      .width(72).height('100%').justifyContent(FlexAlign.Center).backgroundColor('#1E6FFF').borderRadius(12)
      .onClick(() => {
        this.sheetVisible = false
        this.editProfile(profile)
      })
  }

  @Builder
  pickerDeleteAction(profile: SfaProfile) {
    Column() { Text('删除').fontSize(14).fontColor(Color.White) }
      .width(72).height('100%').justifyContent(FlexAlign.Center).backgroundColor('#D93025').borderRadius(12)
      .onClick(() => { this.sheetVisible = false; this.removeProfile(profile) })
  }

  @Builder
  profilePicker() {
    Column({ space: 8 }) {
      Text('配置').fontSize(22).fontWeight(FontWeight.Bold).fontColor(this.palette().textPrimary)
        .width('100%').padding({ left: 8, top: 16, bottom: 16 })
      if (this.selectedProfileIds.length > 0) {
        Row({ space: 8 }) {
          Text(`已选 ${this.selectedProfileIds.length}`).fontSize(14).fontColor(this.palette().textPrimary).layoutWeight(1)
          Button('全选').fontSize(13).height(36).backgroundColor(Color.Transparent).fontColor(this.palette().accent)
            .onClick(() => this.selectAllProfiles())
          Button('删除').fontSize(13).height(36).fontColor(this.palette().danger)
            .onClick(() => { this.sheetVisible = false; this.removeProfiles(this.selectedProfileIds) })
          Button('取消').fontSize(13).height(36).backgroundColor(Color.Transparent)
            .onClick(() => { this.selectedProfileIds = [] })
        }.width('100%').padding(10).backgroundColor(this.palette().accentSoft).borderRadius(12)
      }
      List({ space: 8 }) {
        ForEach(this.catalog.profiles, (profile: SfaProfile) => {
          ListItem() {
            Row({ space: 12 }) {
              if (this.selectedProfileIds.length > 0) {
                Text(this.selectedProfileIds.includes(profile.id) ? '✓' : '').fontSize(18).fontColor(this.palette().accent)
              }
              this.icon('file', 24)
              Column({ space: 2 }) {
                Text(profile.name).fontSize(16).fontColor(this.palette().textPrimary).maxLines(1)
                Text(this.profileSubtitle(profile)).fontSize(12).fontColor(this.palette().textSecondary)
              }.layoutWeight(1).constraintSize({ maxWidth: '100%' }).alignItems(HorizontalAlign.Start)
              if (this.selectedProfileIds.length === 0 && this.catalog.selectedId === profile.id) {
                Text('✓').fontSize(20).fontColor(this.palette().accent)
              }
            }.width('100%').constraintSize({ minHeight: 64 }).padding(16).borderRadius(12)
              .backgroundColor(this.catalog.selectedId === profile.id ? this.palette().surfaceMuted : this.palette().surfaceElevated)
              .onClick(() => {
                if (this.selectedProfileIds.length > 0) { this.toggleProfileSelection(profile.id); return }
                this.sheetVisible = false; this.selectProfile(profile.id)
              })
              .gesture(LongPressGesture().onAction(() => {if(!this.orderHandlePressed&&!this.draggedConfigId)this.toggleProfileSelection(profile.id)}))
              .onDragEnter(()=>{if(this.draggedConfigId&&this.draggedConfigId!==profile.id)this.orderHoverId=profile.id})
              .onDragLeave(()=>{if(this.orderHoverId===profile.id)this.orderHoverId=''})
              .draggable(true)
              .onDragStart(() => { this.draggedConfigId = profile.id; return { builder:()=>{this.orderDragPreview(profile.name,this.profileSubtitle(profile),'')},extraInfo: '调整配置顺序' } })
              .onDragEnd(() => { this.draggedConfigId='';this.orderHoverId='';this.orderHandlePressed=false })
              .onDragEnter(() => { if (this.draggedConfigId && this.draggedConfigId !== profile.id) this.orderHoverId = profile.id })
              .onDrop(() => { if (this.draggedConfigId) this.dropProfileOrder(profile.id) })
              .geometryTransition('order-picker-'+profile.id)
              .opacity(this.draggedConfigId===profile.id?0.35:1)
              .border({width:this.orderHoverId===profile.id?2:0,color:this.palette().accent})
              .animation({duration:180,curve:Curve.EaseOut})
          }.swipeAction({ start: this.pickerEditAction(profile), end: this.pickerDeleteAction(profile) }).onDrop(()=>this.dropProfileOrder(profile.id))
        }, (profile: SfaProfile) => profile.id)
      }.nestedScroll({scrollForward:NestedScrollMode.PARENT_FIRST,scrollBackward:NestedScrollMode.SELF_FIRST}).width('100%')
        .height(Math.max(80, Math.min(360, this.viewportHeight - this.topInset() - this.bottomInset() - 180)))
    }.width('100%').padding({ left: 16, right: 16, bottom: 24 })
  }

  @Builder
  profilesCard() {
    Column({ space: 10 }) {
      Row({ space: 8 }) {
        this.icon('profiles', 18)
        Text('配置').fontSize(16).fontWeight(FontWeight.Medium).fontColor(this.palette().textPrimary).layoutWeight(1)
        Button('添加').height(36).fontSize(14).fontColor(this.palette().accent)
          .backgroundColor(this.palette().accentSoft).onClick(() => { this.openSheet('add') })
      }.width('100%')
      if (this.catalog.profiles.length === 0) {
        Text('添加本地或远程配置').fontSize(14).fontColor(this.palette().textSecondary).width('100%').padding({ top: 8, bottom: 8 })
      } else {
        Row({ space: 12 }) {
          this.icon(this.selectedProfile()?.kind === 'remote' ? 'cloud' : 'file', 20)
          Column({ space: 4 }) {
            Text(this.selectedProfile()?.name || '选择配置').fontSize(16).fontColor(this.palette().textPrimary)
              .width('100%').maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
            if (this.selectedProfile()) {
              Text(this.selectedProfile()?.kind === 'remote' ? '远程 · ' + this.profileAge(this.selectedProfile()) : '本地配置')
                .fontSize(12).fontColor(this.palette().textSecondary).width('100%').maxLines(1)
            }
          }.layoutWeight(1).alignItems(HorizontalAlign.Start)
          this.icon('unfold', 18)
        }.width('100%').constraintSize({ minHeight: 62 }).padding({ left: 14, right: 14 })
          .borderRadius(12).backgroundColor(this.palette().surfaceMuted)
          .accessibilityText('选择当前配置').onClick(() => { this.openSheet('picker') })
        ForEach(this.catalog.profiles.filter((item: SfaProfile) => item.id === this.catalog.selectedId), (item: SfaProfile) => {
          this.subscriptionDetails(item)
          Row({ space: 8 }) {
            Button('编辑配置').height(40).layoutWeight(1).fontSize(14).fontColor(this.palette().accent)
              .backgroundColor(this.palette().accentSoft).onClick(() => this.editProfile(item))
            Button() { this.icon('share', 19) }.width(44).height(40).borderRadius(12)
              .backgroundColor(this.palette().surfaceMuted).accessibilityText('分享配置')
              .onClick(() => this.shareProfileEntry(item))
            if (item.kind === 'remote') {
              Button() { this.icon('refresh', 19) }.width(44).height(40).borderRadius(12)
                .backgroundColor(this.palette().surfaceMuted).enabled(!this.busy).accessibilityText('更新配置')
                .onClick(() => this.updateProfile(item))
            }
          }.width('100%')
          if (item.kind === 'remote' && this.hasSubscriptionTraffic(item)) {
            Button('刷新流量').height(36).fontSize(12).backgroundColor(Color.Transparent).fontColor(this.palette().accent)
              .enabled(!this.busy).onClick(() => this.refreshSubscriptionUsage(true))
          }
        }, (item: SfaProfile) => item.id + '-' + item.updatedAt + '-' + (item.usage?.updatedAt || 0))
      }
    }.width('100%').padding(16).backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass)
      .borderRadius(16).border({ width: 1, color: this.palette().border })
  }

  @Builder
  dashboard() {
    Scroll() {
      Column({ space: 16 }) {
        Blank().height(this.contentTopGap())
        if (this.phase === 'running') {
          if (this.visibleCards.includes('traffic')) {
            Row({ space: 16 }) {
              this.statistic('上传')
              this.statistic('下载')
            }.width('100%')
          }
          if (this.visibleCards.includes('connections')) {
            Row({ space: 16 }) {
              this.diagnosticsCard(true)
              this.diagnosticsCard(false)
            }.width('100%')
          }
          if (this.modes.length > 0 && this.visibleCards.includes('mode')) {
            Column({ space: 12 }) {
              Text('模式').fontSize(16).fontWeight(FontWeight.Bold).fontColor(this.palette().textPrimary).width('100%')
              Row() {
                ForEach(this.modes, (mode: string) => {
                  Button(mode.toLowerCase() === 'rule' ? '规则' : mode.toLowerCase() === 'global' ? '全局' : mode.toLowerCase() === 'direct' ? '直连' : mode).fontSize(14).layoutWeight(1).height(44)
                    .backgroundColor(this.mode.toLowerCase() === mode.toLowerCase() ? this.palette().accentSoft : Color.Transparent)
                    .fontColor(this.palette().textPrimary).enabled(!this.busy)
                    .onClick(() => this.selectMode(mode))
                }, (mode: string) => mode)
              }.width('100%').borderRadius(22).border({ width: 1, color: this.palette().borderStrong })
            }.width('100%').padding(16).backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass).borderRadius(12)
        .backgroundEffect({ radius: this.reduceTransparency ? 0 : 18, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
        .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#33FFFFFF' : '#99FFFFFF' })
          }
        }
        if (this.visibleCards.includes('profiles') || this.phase !== 'running') this.profilesCard()
        if (this.phase === 'error') {
          Text(this.message).fontSize(14).fontColor(this.palette().danger).lineHeight(21).width('100%').padding(16)
        }
      }.width('100%').padding({ left: 16, right: 16, top: 8, bottom: this.mainContentBottomPadding() })
    }.nestedScroll({scrollForward:NestedScrollMode.PARENT_FIRST,scrollBackward:NestedScrollMode.SELF_FIRST}).layoutWeight(1).align(Alignment.Top).scrollBar(BarState.Off)
  }

  private refreshGroupSubscriptionInfo(groups: GroupInfo[], now: number, sessionId: string = ''): void {
    const owner: string | undefined = this.runtimeProfileSessions.get(sessionId)
    if (!owner || owner !== this.catalog.selectedId) return
    if (this.phase !== 'running' || this.suspended || this.recovering) return
    if (this.groupSubscriptionProfile === this.catalog.selectedId && this.groupSubscriptionRefreshedAt > 0 &&
      now - this.groupSubscriptionRefreshedAt < 300000) return
    const names: string[] = []
    for (const group of groups) {
      names.push(group.tag)
      for (const item of group.items || []) names.push(item.tag)
    }
    const info: SubscriptionInfo = subscriptionInfoFromNames(names)
    this.groupSubscriptionRemaining = info.remaining
    this.groupSubscriptionExpiry = info.expiry
    this.groupSubscriptionProfile = owner
    this.groupSubscriptionRefreshedAt = now
  }

  private async downloadUsage(url: string): Promise<SubscriptionUsage | undefined> {
    let usage: SubscriptionUsage | undefined = undefined
    try { await this.downloadRaw(url, false, (value: SubscriptionUsage | undefined) => { usage = value }, true) }
    catch (_) { /* Some providers do not implement HEAD. */ }
    if (usage === undefined || ((usage as SubscriptionUsage | undefined)?.totalBytes !== 0 && usageProgress(usage) < 0)) {
      // Fetch metadata from the normal response; discard the body completely.
      // Never save/reload the JSON or restart the tunnel to refresh an account.
      await this.downloadRaw(url, false, (value: SubscriptionUsage | undefined) => { if (value) usage = value })
    }
    return usage
  }

  private async refreshSubscriptionUsage(force: boolean = false): Promise<void> {
    const profile: SfaProfile | undefined = this.selectedProfile()
    if (!this.uiForeground || !this.pageAlive || this.busy || this.usageRefreshing || !profile) return
    if (profile.kind !== 'remote') return
    if (!force && this.usageAttemptProfile === profile.id && Date.now() - this.usageAttemptAt < 300000) return
    this.usageAttemptAt = Date.now(); this.usageAttemptProfile = profile.id; this.usageRefreshing = true
    try {
      const usage: SubscriptionUsage | undefined = await this.downloadUsage(profile.url)
      if (usage === undefined) { if (force) this.toast('该订阅未返回流量信息，可稍后重试或更新订阅'); return }
      const current: SfaProfile | undefined = this.catalog.profiles.find((item: SfaProfile) => item.id === profile.id)
      if (this.busy || !this.uiForeground || !this.pageAlive || !current || current.url !== profile.url || current.kind !== 'remote') return
      this.busy = true
      try {
        const next: SfaProfile = { id: current.id, name: current.name, kind: current.kind, url: current.url,
          content: current.content, updatedAt: current.updatedAt, usage: usage }
        await this.persist(saveSfaProfile(this.catalog, next))
        if (force) this.toast('订阅流量已刷新，配置和 VPN 保持不变')
      } finally { this.busy = false }
    } catch (_) { if (force) this.toast('流量刷新失败，已保留上次数据；可尝试更新订阅') }
    finally { this.usageRefreshing = false }
  }

  private subscriptionInformation(profile?: SfaProfile): SubscriptionInfo {
    if (!profile) return { remaining: '', expiry: '' }
    let info: SubscriptionInfo | undefined = this.subscriptionInfoCache.get(profile.id)
    if (info === undefined) {
      info = subscriptionInfoFromJson(profile.content)
      this.subscriptionInfoCache.set(profile.id, info)
    }
    if (this.phase === 'running' && this.groupSubscriptionProfile === profile.id && profile.id === this.catalog.selectedId) {
      return { remaining: usageRemaining(profile.usage) || this.groupSubscriptionRemaining || info.remaining, expiry: usageExpiry(profile.usage) || this.groupSubscriptionExpiry || info.expiry }
    }
    return { remaining: usageRemaining(profile.usage) || info.remaining, expiry: usageExpiry(profile.usage) || info.expiry }
  }

  private hasSubscriptionTraffic(profile?: SfaProfile): boolean {
    return usageLabel(profile?.usage).length > 0 || this.subscriptionInformation(profile).remaining.length > 0
  }

  @Builder
  quotaMeter(usage?: SubscriptionUsage) {
    if (usageProgress(usage) >= 0) {
      Progress({ value: usageProgress(usage), total: 100, type: ProgressType.Linear })
        .width('100%').height(6).style({ strokeWidth: 4 }).color(this.palette().accent).backgroundColor(this.palette().borderStrong)
    }
  }

  @Builder
  subscriptionDetails(profile?: SfaProfile) {
    if (this.hasSubscriptionTraffic(profile)) {
      Column({ space: 4 }) {
        if (usageLabel(profile?.usage)) {
          Text(usageLabel(profile?.usage)).fontSize(11).fontColor(this.palette().textPrimary).width('100%')
        }
        this.quotaMeter(profile?.usage)
        if (this.subscriptionInformation(profile).remaining || this.subscriptionInformation(profile).expiry) {
          Text((this.subscriptionInformation(profile).remaining +
            (this.subscriptionInformation(profile).expiry ? ' · ' + this.subscriptionInformation(profile).expiry : '')).trim())
            .fontSize(10).fontColor(this.palette().textSecondary).width('100%').maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
      }.width('100%').alignItems(HorizontalAlign.Start).margin({ top: 4, bottom: 4 })
    }
  }

  private profileSubtitle(profile: SfaProfile): string {
    if (profile.kind === 'remote') return '远程 · ' + this.profileAge(profile)
    return '本地'
  }

  private toggleProfileSelection(id: string): void {
    this.selectedProfileIds = this.selectedProfileIds.includes(id)
      ? this.selectedProfileIds.filter((item: string) => item !== id)
      : [...this.selectedProfileIds, id]
  }

  private moveProfile(id: string, delta: number): void {
    const list: SfaProfile[] = this.catalog.profiles.slice()
    const from: number = list.findIndex((item: SfaProfile) => item.id === id)
    const to: number = from + delta
    if (from < 0 || to < 0 || to >= list.length) return
    const moved: SfaProfile = list.splice(from, 1)[0]
    list.splice(to, 0, moved)
    this.persist({ version: this.catalog.version, selectedId: this.catalog.selectedId, profiles: list })
      .catch(() => this.toast('顺序保存失败'))
  }

  private async dropProfileOrder(targetId: string): Promise<void> {
    const sourceId: string = this.draggedConfigId
    this.draggedConfigId = '';this.orderHoverId=''
    const profiles: SfaProfile[] = this.catalog.profiles.slice()
    const from: number = profiles.findIndex((item: SfaProfile) => item.id === sourceId)
    const to: number = profiles.findIndex((item: SfaProfile) => item.id === targetId)
    if (from < 0 || to < 0) return
    profiles.splice(to, 0, profiles.splice(from, 1)[0])
    try { await this.persist({version:this.catalog.version,selectedId:this.catalog.selectedId,profiles:profiles},true) }
    catch (_) { this.toast('顺序保存失败') }
  }

  private selectAllProfiles(): void {
    const selectable: string[] = this.catalog.profiles
      .map((profile: SfaProfile) => profile.id)
    this.selectedProfileIds = this.selectedProfileIds.length === selectable.length ? [] : selectable
  }

  private removeProfiles(ids: string[]): void {
    const targets: string[] = ids
    if (targets.length === 0) return
    if (this.busy) return
    if (this.phase === 'running' && targets.includes(this.catalog.selectedId)) { this.toast('请先停止当前配置'); return }
    this.getUIContext().getPromptAction().showDialog({ title: '删除配置', message: `删除 ${targets.length} 个配置？`,
      buttons: [{ text: '取消', color: this.palette().textSecondary }, { text: '删除', color: this.palette().danger }] }).then(async (result) => {
      if (result.index !== 1) return
      try {
        let next: SfaCatalog = this.catalog
        for (const id of targets) next = deleteSfaProfile(next, id)
        await this.persist(next)
        this.selectedProfileIds = []
      } catch (_) { this.toast('删除失败，原配置已保留') }
    })
  }

  @Builder
  profileEditAction(profile: SfaProfile) {
    Column() { Text('编辑').fontSize(14).fontColor(Color.White) }
      .width(72).height('100%').justifyContent(FlexAlign.Center).backgroundColor('#1E6FFF').borderRadius(12)
      .onClick(() => { this.editProfile(profile) })
  }

  @Builder
  profileDeleteAction(profile: SfaProfile) {
    Column() { Text('删除').fontSize(14).fontColor(Color.White) }
      .width(72).height('100%').justifyContent(FlexAlign.Center).backgroundColor('#D93025').borderRadius(12)
      .onClick(() => this.removeProfile(profile))
  }

  @Builder
  profilesPage() {
    Column() {
      if (this.initializationError.length > 0) {
        Text(this.initializationError).fontSize(14).fontColor(this.palette().danger).padding({ top: this.contentTopGap() + 4, left: 16, right: 16 })
        Button('重试读取配置').enabled(!this.busy).onClick(() => { this.initialize() })
      }
      List({ space: 12 }) {
        ListItem() {
          Column() { Blank().height(this.contentTopGap()) }.width('100%')
        }
        if (this.selectedProfileIds.length > 0) {
          ListItem() {
            Row({ space: 8 }) {
              Text(`已选 ${this.selectedProfileIds.length}`).fontSize(14).fontColor(this.palette().textPrimary).layoutWeight(1)
              Button('全选').fontSize(13).height(38).backgroundColor(Color.Transparent).fontColor(this.palette().accent)
                .onClick(() => this.selectAllProfiles())
              Button('删除').fontSize(13).height(38).fontColor(this.palette().danger)
                .onClick(() => this.removeProfiles(this.selectedProfileIds))
              Button('取消').fontSize(13).height(38).backgroundColor(Color.Transparent)
                .onClick(() => { this.selectedProfileIds = [] })
            }.width('100%').padding(12).backgroundColor(this.palette().accentSoft).borderRadius(12)
          }
        }
        ForEach(this.catalog.profiles, (profile: SfaProfile) => {
          ListItem() {
            Column() {
            Row({ space: 12 }) {
              if (this.selectedProfileIds.length > 0 && this.selectedProfileIds.includes(profile.id)) {
                Text('✓').fontSize(20).fontColor(this.palette().accent)
              }
              Column({ space: 4 }) {
                Text(profile.name).fontSize(16).fontColor(this.palette().textPrimary).maxLines(1)
                Text(this.profileSubtitle(profile)).fontSize(12).fontColor(this.palette().textSecondary).maxLines(1)
                this.subscriptionDetails(profile)
              }.layoutWeight(1).constraintSize({ maxWidth: '100%' }).alignItems(HorizontalAlign.Start)
              if (this.reorderId === profile.id) {
                Button('↑').width(34).height(34).fontSize(14).backgroundColor(this.palette().surfaceMuted)
                  .fontColor(this.palette().textPrimary).onClick(() => this.moveProfile(profile.id, -1))
                Button('↓').width(34).height(34).fontSize(14).backgroundColor(this.palette().surfaceMuted)
                  .fontColor(this.palette().textPrimary).onClick(() => this.moveProfile(profile.id, 1))
                Button('完成').height(34).fontSize(12).backgroundColor(Color.Transparent).fontColor(this.palette().accent)
                  .onClick(() => { this.reorderId = '' })
              }
            }.width('100%').constraintSize({ minHeight: 64 }).padding(16).backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass).borderRadius(12).clip(true)
        .backgroundEffect({ radius: this.reduceTransparency ? 0 : 18, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
        .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#33FFFFFF' : '#99FFFFFF' })
              .onClick(() => {
                if (this.selectedProfileIds.length > 0) { this.toggleProfileSelection(profile.id); return }
                // Settings list must not change the running configuration.
                // Running configuration is fixed here: ignore the tap silently.
                if (this.phase === 'running') return
                this.selectProfile(profile.id)
              })
              .gesture(LongPressGesture().onAction(() => {if(!this.orderHandlePressed&&!this.draggedConfigId)this.toggleProfileSelection(profile.id)}))
              .draggable(true)
              .onDragStart(() => { this.draggedConfigId = profile.id; return { builder:()=>{this.orderDragPreview(profile.name,this.profileSubtitle(profile),'')},extraInfo: '调整配置顺序' } })
              .onDragEnd(() => { this.draggedConfigId='';this.orderHoverId='';this.orderHandlePressed=false })
              .onDragEnter(() => { if (this.draggedConfigId && this.draggedConfigId !== profile.id) this.orderHoverId = profile.id })
              .onDrop(() => { if (this.draggedConfigId) this.dropProfileOrder(profile.id) })
              .geometryTransition('order-profile-'+profile.id)
              .opacity(this.draggedConfigId===profile.id?0.35:1)
              .animation({duration:180,curve:Curve.EaseOut})
              .border({width:this.orderHoverId===profile.id?2:0.8,color:this.orderHoverId===profile.id?this.palette().accent:'#66FFFFFF'})
            }.width('100%')
          }.swipeAction({ start: this.profileStartActions(profile), end: this.profileDeleteAction(profile) })
        }, (profile: SfaProfile) => profile.id)
        if (this.catalog.profiles.length === 0) {
          ListItem() {
            Column({ space: 12 }) {
              Text('没有配置').fontColor(this.palette().textSecondary)
              Button('新建配置').onClick(() => { this.page = 'add-profile' })
            }.width('100%').padding(24).alignItems(HorizontalAlign.Center)
          }
        }
        ListItem() { Column().height(this.mainContentBottomPadding()) }
      }.nestedScroll({scrollForward:NestedScrollMode.PARENT_FIRST,scrollBackward:NestedScrollMode.SELF_FIRST}).layoutWeight(1).padding({ left: 16, right: 16 })
    }
  }


  private editorProfile(): SfaProfile | undefined {
    return this.catalog.profiles.find((item: SfaProfile) => item.id === this.editingId)
  }

  private editorHasChanges(): boolean {
    const original: SfaProfile | undefined = this.editorProfile()
    if (this.draftName.trim() !== (original?.name || '') || this.draftKind !== (original?.kind || 'local') ||
      this.draftContent !== (original?.content || '')) return true
    return this.draftKind === 'remote' && (this.draftUrl.trim() !== (original?.url || '') ||
      this.draftAutoUpdate !== (original ? original.autoUpdate === true : true) ||
      this.draftAutoUpdateInterval !== String(original ? effectiveAutoUpdateInterval(original) : 60))
  }

  private async refreshEditorProfile(): Promise<void> {
    const original: SfaProfile | undefined = this.editorProfile()
    if (!original || this.editorHasChanges()) return
    await this.updateProfile(original)
    const updated: SfaProfile | undefined = this.editorProfile()
    if (this.page === 'editor' && updated?.id === original.id && this.draftContent === original.content) {
      this.draftContent = updated.content
    }
  }

  @Builder
  editorSectionTitle(title: string) {
    Text(title).fontSize(13).fontWeight(FontWeight.Medium).fontColor(this.palette().textSecondary)
      .width('100%').padding({ left: 4, bottom: 6 })
  }

  @Builder
  editorRow(label: string, action: () => void) {
    Row({ space: 10 }) {
      Text(label).fontSize(15).fontColor(this.palette().accent).layoutWeight(1)
      Text('›').fontSize(20).fontColor(this.palette().textSecondary)
    }.width('100%').constraintSize({ minHeight: 54 }).padding({ left: 14, right: 14 }).onClick(action)
  }

  @Builder
  editor() {
    Scroll() {
      Column({ space: 18 }) {
        Blank().height(this.contentTopGap())
        if (this.editorError.length > 0) Text(this.editorError).fontSize(14).fontColor(this.palette().danger).width('100%')
        Column() {
          this.editorSectionTitle('基本信息')
          Column() {
            Row({ space: 10 }) {
              Text('名称').fontSize(15).fontColor(this.palette().textPrimary)
              TextInput({ placeholder: '配置名称', text: this.draftName }).layoutWeight(1).height(52)
                .backgroundColor(Color.Transparent).textAlign(TextAlign.End)
                .onChange((value: string) => { this.draftName = value })
            }.width('100%').padding({ left: 14, right: 6 })
            Divider().color(this.palette().border).margin({ left: 14 })
            Row({ space: 10 }) {
              Text('类型').fontSize(15).fontColor(this.palette().textPrimary).layoutWeight(1)
              Button(this.draftKind === 'remote' ? '远程 ﹀' : '本地 ﹀').height(40).fontSize(14)
                .fontColor(this.palette().accent).backgroundColor(Color.Transparent)
                .bindMenu([
                  { value: '本地', action: () => { this.draftKind = 'local' } },
                  { value: '远程', action: () => { this.draftKind = 'remote' } }
                ])
            }.width('100%').height(52).padding({ left: 14, right: 8 })
            if (this.draftKind === 'remote') {
              Divider().color(this.palette().border).margin({ left: 14 })
              Row({ space: 10 }) {
                Text('URL').fontSize(15).fontColor(this.palette().textPrimary)
                TextInput({ placeholder: 'https://', text: this.draftUrl }).layoutWeight(1).height(52)
                  .backgroundColor(Color.Transparent).textAlign(TextAlign.End)
                  .onChange((value: string) => { this.draftUrl = value })
              }.width('100%').padding({ left: 14, right: 6 })
            }
          }.width('100%').backgroundColor(this.palette().surface).borderRadius(14)
            .border({ width: 1, color: this.palette().border })
        }.width('100%')
        if (this.draftKind === 'remote') {
          Column() {
            this.editorSectionTitle('订阅更新')
            Column() {
              Row({ space: 10 }) {
                Text('自动更新').fontSize(15).fontColor(this.palette().textPrimary).layoutWeight(1)
                Toggle({ type: ToggleType.Switch, isOn: this.draftAutoUpdate })
                  .onChange((value: boolean) => { this.draftAutoUpdate = value })
              }.width('100%').height(54).padding({ left: 14, right: 14 })
              if (this.draftAutoUpdate) {
                Divider().color(this.palette().border).margin({ left: 14 })
                Row({ space: 8 }) {
                  Text('更新间隔').fontSize(15).fontColor(this.palette().textPrimary)
                  TextInput({ placeholder: '60', text: this.draftAutoUpdateInterval }).layoutWeight(1).height(52)
                    .backgroundColor(Color.Transparent).textAlign(TextAlign.End).type(InputType.Number)
                    .onChange((value: string) => { this.draftAutoUpdateInterval = value })
                  Text('分钟').fontSize(13).fontColor(this.palette().textSecondary)
                }.width('100%').padding({ left: 14, right: 14 })
              }
              if (this.editorProfile()?.kind === 'remote') {
                Divider().color(this.palette().border).margin({ left: 14 })
                Row() {
                  Text('上次更新').fontSize(15).fontColor(this.palette().textPrimary).layoutWeight(1)
                  Text(this.profileAge(this.editorProfile())).fontSize(13).fontColor(this.palette().textSecondary)
                }.width('100%').height(50).padding({ left: 14, right: 14 })
                Divider().color(this.palette().border).margin({ left: 14 })
                if (!this.editorHasChanges()) this.editorRow('立即更新', () => { this.refreshEditorProfile() })
              }
            }.width('100%').backgroundColor(this.palette().surface).borderRadius(14)
              .border({ width: 1, color: this.palette().border })
          }.width('100%')
        }
        Column() {
          this.editorSectionTitle('配置文件')
          Column() {
            this.editorRow('编辑 JSON', () => { this.page = 'json-editor' })
            if (this.draftKind === 'local') {
              Divider().color(this.palette().border).margin({ left: 14 })
              this.editorRow('导入文件', () => { this.importFile() })
            }
            if (this.editingId) {
              Divider().color(this.palette().border).margin({ left: 14 })
              this.editorRow('分享已保存的配置', () => {
                const profile: SfaProfile | undefined = this.editorProfile()
                if (profile) this.shareProfileEntry(profile)
              })
            }
          }.width('100%').backgroundColor(this.palette().surface).borderRadius(14)
            .border({ width: 1, color: this.palette().border })
        }.width('100%')
        if (this.busy) LoadingProgress().width(28).height(28)
      }.width('100%').padding({ left: 18, right: 18, bottom: this.mainContentBottomPadding() })
        .enabled(!this.busy)
    }.nestedScroll({ scrollForward: NestedScrollMode.PARENT_FIRST, scrollBackward: NestedScrollMode.SELF_FIRST })
      .layoutWeight(1).align(Alignment.Top)
  }

  private jsonSummary(): string {
    if (!this.draftContent.trim()) return '暂无内容：保存远程地址后可查看下载的 JSON'
    try { validateSfaContent(this.draftContent); return '有效 JSON 对象 · ' + this.draftContent.length + ' 字符' }
    catch (_) { return 'JSON 格式无效，请检查后再保存' }
  }

  @Builder
  jsonEditor() {
    Column({ space: 12 }) {
      Blank().height(this.contentTopGap())
      Row({ space: 12 }) {
        Text(this.jsonSummary()).fontSize(12).fontColor(this.palette().textSecondary).layoutWeight(1)
        Button('格式化').fontSize(12).onClick(() => {
          try { validateSfaContent(this.draftContent); this.draftContent = JSON.stringify(JSON.parse(this.draftContent.replace(/^\uFEFF/, '')), null, 2) }
          catch (_) { this.toast('JSON 格式无效') }
        })
      }.width('100%')
      TextArea({ text: this.draftContent, placeholder: '完整 sing-box JSON 配置' })
        .layoutWeight(1).width('100%').fontSize(13).fontFamily('monospace')
        .fontColor(this.palette().textPrimary).backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass)
        .maxLength(4194304).onChange((value: string) => { this.draftContent = value })
      Text('可在文本区域内滚动查看全部内容；点击完成返回，保存时确认修改。').fontSize(12).fontColor(this.palette().textSecondary)
    }.width('100%').layoutWeight(1).padding({ left: 16, right: 16, bottom: this.mainContentBottomPadding() })
  }

  @Builder
  groupNode(group: GroupInfo, item: GroupItem) {
    Column({ space: 4 }) {
      Text(item.tag).fontSize(16).fontWeight(FontWeight.Medium).fontColor(this.palette().textPrimary)
        .width('100%').maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
      Row() {
        Text(this.nodeType(item.type)).fontSize(12).fontColor(this.palette().textSecondary).layoutWeight(1)
        if (this.groupDelays.get(panelNodeKey(group.tag,item.tag))) {
          Text((this.groupDelays.get(panelNodeKey(group.tag,item.tag)) || 0).toString() + 'ms').fontSize(12).fontWeight(FontWeight.Bold)
            .fontColor(delayColor(this.groupDelays.get(panelNodeKey(group.tag,item.tag)) || 0))
        }
      }.width('100%')
    }.width('100%').height(64).padding(12).borderRadius(12)
      .backgroundColor(this.groupSelections.get(group.tag) === item.tag ? this.palette().accentSoft : this.palette().background)
      .onClick(() => this.selectGroupNode(group,item))
  }

  private async selectGroupNode(group: GroupInfo, item: GroupItem): Promise<void> {
    if (!group.selectable || !this.coordinator || this.busy || this.phase !== 'running' ||
      this.groupSelections.get(group.tag) === item.tag) return
    this.groupInteractionRevision++
    this.choices.choose('group:' + group.tag,item.tag,this.groupSelections.get(group.tag) || '')
  }

  @Builder
  groupsPage() {
    Column() {
      Row() {
        Text('组').fontSize(22).fontWeight(FontWeight.Bold).fontColor(this.palette().textPrimary).layoutWeight(1)
        Button() { this.icon('unfold', 24) }.width(44).height(44).backgroundColor(Color.Transparent)
          .accessibilityText('全部展开或折叠').onClick(() => {
            this.expandedGroups = this.expandedGroups.length === this.groups.length ? [] : this.groups.map((group: GroupInfo) => group.tag)
          })
      }.width('100%').padding({ left: 24, right: 16, top: 16, bottom: 12 })
      Scroll() {
        Column({ space: 12 }) {
          ForEach(this.groups, (group: GroupInfo) => {
            Column({ space: 12 }) {
              Row({ space: 8 }) {
                Text(group.tag).fontSize(16).fontWeight(FontWeight.Bold).fontColor(this.palette().textPrimary)
                Text(this.nodeType(group.type)).fontSize(14).fontColor(this.palette().textSecondary).layoutWeight(1)
                Text(group.items.length.toString()).fontSize(12).padding({ left: 8, right: 8, top: 2, bottom: 2 })
                  .backgroundColor(this.palette().surfaceMuted).borderRadius(12).fontColor(this.palette().textPrimary)
                Button() { this.icon('speed', 22) }.width(36).height(36).backgroundColor(Color.Transparent)
                  .accessibilityText('测速 ' + group.tag).enabled(this.testingGroup.length === 0)
                  .onClick(() => this.refreshGroupDelays(group.tag))
                Button() { this.icon(this.expandedGroups.includes(group.tag) ? 'up' : 'down', 22) }
                  .width(28).height(36).backgroundColor(Color.Transparent).accessibilityText('展开或折叠 ' + group.tag)
                  .onClick(() => this.toggleGroup(group.tag))
              }.width('100%')
              if (this.expandedGroups.includes(group.tag)) {
                Grid() {
                  ForEach(group.items, (item: GroupItem) => { GridItem() { this.groupNode(group, item) } }, (item: GroupItem) => item.tag)
                }.columnsTemplate('1fr 1fr').rowsGap(10).columnsGap(10).height(Math.max(0,Math.ceil(group.items.length / 2) * 74 - 10))
              } else {
                Row({ space: 4 }) {
                  ForEach(group.items, (item: GroupItem) => {
                    Stack() {
                      if (this.groupSelections.get(group.tag) === item.tag) Circle().width(4).height(4).fill(Color.White)
                    }.width(11).height(11).borderRadius(4).backgroundColor(delayColor(this.groupDelays.get(panelNodeKey(group.tag,item.tag)) || 0))
                  }, (item: GroupItem) => item.tag)
                }.width('100%').height(22).onClick(() => this.toggleGroup(group.tag))
              }
            }.width('100%').padding(16).borderRadius(16)
              .backgroundColor(this.palette() === DARK_PALETTE ? '#8025262B' : '#80EEEDF5')
          }, (group: GroupInfo) => panelGroupKey(group))
          Text('延迟每 30 秒刷新').fontSize(12).fontColor(this.palette().textSecondary).padding(8)
        }.width('100%').padding({ left: 16, right: 16, bottom: this.bottomInset() + 24 })
      }.layoutWeight(1).align(Alignment.Top).clip(true).scrollBar(BarState.Auto)
    }.width('100%').height('100%')
  }

  private logBadge(line: string): string {
    const level: string = line.trim().split(/\s+/)[0].toLowerCase()
    if (level === 'error' || level === 'fatal') return '错误'
    if (level === 'warn' || level === 'warning') return '警告'
    if (level === 'debug' || level === 'trace') return '调试'
    return '信息'
  }

  private logColor(line: string): string {
    const label: string = this.logBadge(line)
    return label === '错误' ? this.palette().danger : label === '警告' ? this.palette().warning : this.palette().accent
  }

  private visibleLogs(): string[] {
    return this.logs.filter((line: string) => cleanLogLine(line).toLowerCase().includes(this.logQuery.toLowerCase()) &&
      (this.logLevel === 'all' || line.startsWith(this.logLevel + ' ')))
  }

  @Builder
  logFilterFace() {
      Row({ space: 8 }) {
        ForEach(['all', 'info', 'warn', 'error', 'debug'], (level: string) => {
          Text(level === 'all' ? '全部' : this.logBadge(level + ' ')).fontSize(12).fontColor(this.palette().textPrimary)
            .height(36).layoutWeight(1).textAlign(TextAlign.Center).borderRadius(18)
            .backgroundColor(this.logLevel === level ? this.palette().accentSoft : Color.Transparent)
            .onClick(() => { this.logLevel = level; this.saveUiSettings() })
        }, (level: string) => level)
      }.width('100%').height(64).padding({left:16,right:16}).borderRadius(26)
        .backgroundColor(this.reduceTransparency ? this.palette().surface : Color.Transparent)
        .attributeModifier(this.toolbarLensModifier())
  }

  @Builder
  logFilterBar() {
    Tabs({barPosition:BarPosition.End}) {
      TabContent() { Column() }.tabBar(this.logFilterFace())
    }.width('100%').height(64).barHeight(64).barBackgroundColor(Color.Transparent)
      .barMode(BarMode.Fixed).scrollable(false).clip(false)
  }

  private updateLogScroll(offset:number):void {
    const y:number=this.logScroller.currentOffset().yOffset
    if(y<=8){this.logScrolled=false;this.logReturning=false;return}
    if(y>=124)this.logScrolled=true
    if(offset < -1)this.logReturning=true
    else if(offset > 1)this.logReturning=false
  }

  @Builder
  logFilterHeader() {
    Column(){this.logFilterBar()}.height(64).opacity(this.logScrolled && this.logReturning ? 0 : 1).hitTestBehavior(this.logScrolled && this.logReturning ? HitTestMode.None : HitTestMode.Default)
  }

  @Builder
  logsPage() {
    // One scroll surface moves the title, search and entries together.
    // Only the level menu sticks; no per-frame state or nested list hand-off.
    List({ scroller:this.logScroller, space: 8 }) {
      ListItem() { this.appToolbar() }
      ListItem() {
        TextInput({ placeholder: '搜索日志', text: this.logQuery }).height(44)
          .onChange((value: string) => { this.logQuery = value })
      }.padding({left:16,right:16})
      ListItemGroup({header:this.logFilterHeader(),space:8}) {
          ForEach(this.visibleLogs(), (line: string) => {
            ListItem() {
            Column({ space: 8 }) {
              Row() {
                Text(this.logBadge(line)).fontSize(11).fontWeight(FontWeight.Bold).fontColor(this.logColor(line))
                  .padding({ left: 6, right: 6, top: 3, bottom: 3 }).borderRadius(6).backgroundColor(this.palette().accentSoft)
                Blank()
              }.width('100%')
              Text(logBody(line)).fontSize(13).fontWeight(FontWeight.Normal).lineHeight(21).fontColor(this.palette().textPrimary).width('100%')
                .copyOption(CopyOptions.InApp)
            }.width('100%').padding(12).borderRadius(12)
              .backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass)
              .border({ width: 0.5, color: this.palette().border })
            }.padding({left:16,right:16})
          }, (line: string, index: number) => index.toString() + ':' + line)
          if (this.visibleLogs().length === 0) {
            ListItem() {
              Text(this.logs.length === 0 ? '暂无日志' : '没有匹配的日志')
                .width('100%').fontSize(14).fontColor(this.palette().textSecondary).textAlign(TextAlign.Center)
            }.width('100%').padding({ left: 24, right: 24, top: 36, bottom: 36 })
          }
          ListItem() { Column().height(this.mainContentBottomPadding()) }
      }
    }.layoutWeight(1).width('100%').padding({top:this.topInset()})
      .sticky(StickyStyle.Header).scrollBar(BarState.Auto)
      .onDidScroll((offset:number)=>this.updateLogScroll(offset))
  }

  @Builder
  settingRow(title: string, detail: string, target: string) {
    Row() {
      Column({ space: 4 }) {
        Text(title).fontSize(16).fontColor(this.palette().textPrimary)
        if (detail.length > 0) Text(detail).fontSize(13).fontColor(this.palette().textSecondary)
      }.layoutWeight(1).alignItems(HorizontalAlign.Start)
      Text('›').fontSize(24).fontColor(this.palette().textSecondary)
    }.width('100%').constraintSize({ minHeight: 72 }).padding(16)
      .onClick(() => { this.page = target; if (target === 'applications') this.loadApplications(); if (target === 'ssid') this.readCurrentSsid() })
  }

  @Builder
  settingsPage() {
    Scroll() {
      Column({ space: 16 }) {
        Blank().height(this.contentTopGap())
        Column() {
          this.editorSectionTitle('通用')
          Column() {
            this.settingRow('外观', '主题与透明效果', 'appearance')
            Divider().color(this.palette().border).margin({ left: 16 })
            this.settingRow('仪表盘', '管理显示的卡片', 'cards')
          }.width('100%').backgroundColor(this.palette().surface).borderRadius(14)
        }.width('100%')
        Column() {
          this.editorSectionTitle('网络与 VPN')
          Column() {
            this.settingRow('按需连接', 'Wi-Fi 规则', 'ssid')
            Divider().color(this.palette().border).margin({ left: 16 })
            this.settingRow('分应用代理', '', 'applications')
            Divider().color(this.palette().border).margin({ left: 16 })
            this.settingRow('WebRTC 防护', 'STUN 处理', 'privacy')
          }.width('100%').backgroundColor(this.palette().surface).borderRadius(14)
        }.width('100%')
        Column() {
          this.editorSectionTitle('关于')
          Column() {
            this.settingRow('版本信息', APP_VERSION + ' · sing-box ' + CORE_VERSION, 'about')
            Divider().color(this.palette().border).margin({ left: 16 })
            this.settingRow('开源许可', '', 'sources')
            Divider().color(this.palette().border).margin({ left: 16 })
            this.editorRow(this.updateChecking ? '正在检查更新…' : '检查更新', () => { this.checkUpdates(true) })
          }.width('100%').backgroundColor(this.palette().surface).borderRadius(14)
        }.width('100%')
      }.width('100%').padding({ left: 16, right: 16, bottom: this.mainContentBottomPadding() })
    }.layoutWeight(1).align(Alignment.Top)
  }

  @Builder
  toolsPage() {
    Scroll() {
      Column({ space: 16 }) {
        Blank().height(this.contentTopGap())
        Column() {
          this.editorSectionTitle('网络诊断')
          Column() {
            this.settingRow('DNS 查询', '', 'dns-query')
            Divider().color(this.palette().border).margin({ left: 16 })
            this.settingRow('WebRTC 检测', '', 'webrtc')
          }.width('100%').backgroundColor(this.palette().surface).borderRadius(14)
        }.width('100%')
        Column() {
          this.editorSectionTitle('设备互联')
          Column() {
            this.settingRow('Tailscale', '端点与 Taildrop', 'tailscale')
          }.width('100%').backgroundColor(this.palette().surface).borderRadius(14)
        }.width('100%')
      }.width('100%').padding({ left: 16, right: 16, bottom: this.mainContentBottomPadding() })
    }.layoutWeight(1).align(Alignment.Top)
  }

  private topInset(): number { return this.getUIContext().px2vp(this.topInsetPx) }
  private bottomInset(): number { return this.getUIContext().px2vp(this.bottomInsetPx) }

  // Chrome material (0.83 look): a thin translucent wash + light blur over the page
  // gradient. The native uiMaterial.systemMaterial experiment from 0.83.10-0.83.12 is
  // removed here: it rendered as an opaque slab on the phone and swallowed the drag
  // gesture, so the film is drawn in-app again.
  private filmColor(): string {
    return this.reduceTransparency ? this.palette().surface : (this.palette() === DARK_PALETTE ? '#301C1D21' : '#18FFFFFF')
  }

  private filmRadius(): number { return this.reduceTransparency ? 0 : 20 }

  private selectedMenuTint(): string {
    return this.reduceTransparency ? this.palette().accentSoft : '#18' + this.palette().accent.substring(1)
  }

  private toolbarLensModifier(): CommonModifier {
    if (this.nativeGlassAvailable()) return this.glassModifier(true)
    const fallback: CommonModifier = new CommonModifier()
    fallback.backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass)
      .backgroundEffect({radius:this.reduceTransparency ? 0 : 6,saturation:1.1,brightness:1.01,color:Color.Transparent})
    return fallback
  }

  private nativeGlassAvailable(): boolean {
    if (this.reduceTransparency) return false
    if (this.nativeGlassSupport !== null) return this.nativeGlassSupport
    let supported: boolean = false
    if (deviceInfo.apiAvailable('26.0.0')) {
      try { supported = uiMaterial.isImmersiveMaterialSupported() } catch (_) { }
    }
    this.nativeGlassSupport = supported
    return supported
  }

  private glassModifier(interactive: boolean): CommonModifier {
    const key: string = (this.palette() === DARK_PALETTE ? 'dark' : 'light') + '-' + this.reduceTransparency + '-' + interactive
    const cached: CommonModifier | undefined = this.glassModifierCache.get(key)
    if (cached) return cached
    const modifier: CommonModifier = new CommonModifier()
    if (this.nativeGlassAvailable()) {
      try {
          modifier.systemMaterial(new uiMaterial.ImmersiveMaterial({
            style: uiMaterial.ImmersiveStyle.ULTRA_THIN,
            materialColor: Color.Transparent, colorInvert: false,
            applyShadow: interactive, interactive: interactive,
            lightEffect: { color: this.palette() === DARK_PALETTE ? '#66FFFFFF' : '#44FFFFFF' }
          }))
      } catch (_) { /* Keep a supported baseline on older device builds. */ }
    }
    this.glassModifierCache.set(key, modifier)
    return modifier
  }

  @Builder
  nativeGlassFace(height: number, interactive: boolean, rounded: boolean) {
    Column().width('100%').height(height).borderRadius(rounded ? height / 2 : 0)
      .attributeModifier(this.glassModifier(interactive))
  }

  @Builder
  glassBase(height: number, rounded: boolean = true) {
      Column().width('100%').height(height).borderRadius(rounded ? height / 2 : 0)
        .backgroundColor(this.reduceTransparency ? this.palette().surface : (this.nativeGlassAvailable()
          ? (this.palette() === DARK_PALETTE ? '#10000000' : '#08FFFFFF')
          : (this.palette() === DARK_PALETTE ? '#261C1D21' : '#1AFFFFFF')))
        .backgroundEffect({ radius: this.reduceTransparency || this.nativeGlassAvailable() ? 0 : 6, saturation: 1.1, brightness: 1.01, color: Color.Transparent })
        .border({ width: rounded ? 0.6 : 0, color: this.palette() === DARK_PALETTE ? '#44FFFFFF' : '#66FFFFFF' })
        .shadow({ radius: rounded && !this.nativeGlassAvailable() ? 8 : 0, color: this.palette().shadow, offsetY: 3 })
  }

  @Builder
  glassBackdrop(height: number, interactive: boolean, rounded: boolean = true) {
    Stack() {
      this.glassBase(height, rounded)
      Tabs({ barPosition: BarPosition.End }) {
        TabContent() { Column() }.tabBar(this.nativeGlassFace(height, interactive, rounded))
      }.width('100%').height(height).barHeight(height).barBackgroundColor(Color.Transparent)
        .barMode(BarMode.Fixed).scrollable(false).clip(false)
    }.width('100%').height(height).hitTestBehavior(HitTestMode.None)
  }

  private dockSize(value: number): number { return value * 0.8 }

  private runningBarSize(value: number): number { return this.dockSize(value) * 0.84 }

  private dockAccent(): string {
    return this.reduceTransparency ? this.palette().accentSoft : '#40' + this.palette().accentSoft.substring(1)
  }

  private mainContentBottomPadding(): number {
    // Clearance belongs inside scrollable content, never on the full-page
    // viewport. This allows content to pass behind the translucent chrome.
    return this.floatingControlsHeight() + 16
  }

  private async syncWindowTheme(): Promise<void> {
    try {
      const win: window.Window = await window.getLastWindow(this.context())
      const dark: boolean = this.palette() === DARK_PALETTE
      await win.setWindowSystemBarProperties({ statusBarColor: '#00000000', navigationBarColor: '#00000000',
        statusBarContentColor: dark ? '#FFFFFFFF' : '#FF17171C', navigationBarContentColor: dark ? '#FFFFFFFF' : '#FF17171C' })
    } catch (_) { }
  }

  private runtimeConfig(profile: SfaProfile): string {
    return prepareLocalConfig(profile.content, { ipv6Enabled: configIpv6Enabled(profile.content), protectWebRtc: this.protectWebRtc, strictWebRtc: this.strictWebRtc })
  }

  // Runs after a successful start: refresh the GFW/mainland rule-sets quietly,
  // at most once a day, and apply them with a silent restart. Any failure keeps
  // the current rule-sets and the running session untouched.
  private formatTime(value: number): string {
    const date: Date = new Date(value)
    const pad = (part: number): string => part < 10 ? `0${part}` : `${part}`
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  private onSnapshotPageChanged(): void {
    if (this.uiForeground && this.pageAlive) this.publishUiActivity(true)
  }

  private onPageChanged(): void {
    this.onSnapshotPageChanged()
    if(this.page!=='groups')this.showGroups=false
    const root:string=drawerRoot(this.page)
    if(root!==this.previousDrawerRoot)this.drawerPinned = false
    this.previousDrawerRoot=root
    if (this.page && (this.tab === 'dashboard' || this.tab === 'log')) {
      const index: number = drawerMenus(this.tab,this.page).findIndex((item: DrawerMenu) => item.key === drawerRoot(this.page))
      setTimeout(() => { try { this.drawerScroller.scrollToIndex(index + 1,true,ScrollAlign.START) } catch (_) { } },80)
    }
  }

  // Reuse loaded outbounds when possible. Manual tests otherwise use a
  // temporary outbound-only worker without switching profiles or starting VPN.
  private async importSmart(): Promise<void> {
    if (this.busy) return
    const text: string = this.importText.trim()
    if (!text) { this.toast('请粘贴完整 sing-box JSON 或远程配置地址'); return }
    try {
      const profile: ScannedProfile = text.startsWith('https://')
        ? { name: '远程配置', kind: 'remote', url: text, content: '' }
        : parseProfileQr(text)
      this.editProfile()
      this.draftName = profile.name
      this.draftKind = profile.kind
      this.draftUrl = profile.url
      this.draftContent = profile.content
    } catch (_) { this.toast('请输入完整 sing-box JSON 或远程配置地址') }
  }

  private async pasteImport(): Promise<void> {
    try { this.importText = (await pasteboard.getSystemPasteboard().getData()).getPrimaryText() }
    catch (_) { this.toast('未能读取剪贴板，请在输入框长按粘贴') }
  }

  private async scanProfile(): Promise<void> {
    this.sheetVisible = false
    try {
      const result: scanBarcode.ScanResult = await scanBarcode.startScanForResult(this.context(), {
        scanTypes: [scanCore.ScanType.QR_CODE], enableAlbum: true
      })
      if (!result.originalValue) return
      this.importText = result.originalValue
      this.page = 'import'
      this.toast('已识别二维码，请检查后导入')
    } catch (failure) { this.toast(failure instanceof Error ? failure.message : '扫码已取消或不可用') }
    finally { this.syncWindowTheme() }
  }

  @Builder
  addProfileSheet() {
    Column({ space: 8 }) {
      Text('添加配置文件').fontSize(22).fontColor(this.palette().textPrimary).width('100%').padding({ top: 14, bottom: 12 })
      Row({ space: 18 }) {
        this.icon('upload', 24)
        Column({ space: 4 }) { Text('从文件导入').fontColor(this.palette().textPrimary); Text('从本地文件导入配置').fontSize(13).fontColor(this.palette().textSecondary) }.alignItems(HorizontalAlign.Start)
      }.width('100%').height(72).onClick(() => { this.sheetVisible = false; this.editProfile(); this.importFile() })
      Row({ space: 18 }) {
        Text('▦').fontSize(27).fontColor(this.palette().textPrimary)
        Column({ space: 4 }) { Text('扫描二维码').fontColor(this.palette().textPrimary); Text('扫描配置二维码').fontSize(13).fontColor(this.palette().textSecondary) }.alignItems(HorizontalAlign.Start)
      }.width('100%').height(72).onClick(() => this.scanProfile())
      Row({ space: 18 }) {
        this.icon('folder', 24)
        Column({ space: 4 }) { Text('手动创建').fontColor(this.palette().textPrimary); Text('从头创建新配置文件').fontSize(13).fontColor(this.palette().textSecondary) }.alignItems(HorizontalAlign.Start)
      }.width('100%').height(72).onClick(() => { this.sheetVisible = false; this.editProfile() })
    }.width('100%').padding({ left: 24, right: 24, bottom: this.bottomInset() + 16 })
  }

  private async importApplications(): Promise<void> {
    try {
      const files: string[] = await new picker.DocumentViewPicker(this.context()).select({ maxSelectNumber: 1 })
      if (files.length === 0) return
      const names: string[] = (await readLocalDocument(files[0])).split(/\r?\n/).map((line: string) => line.trim()).filter((line: string) => line.length > 0 && !line.startsWith('ID:'))
      if (names.length > 3000) throw new Error('应用清单过大')
      const apps: SelectableApplication[] = []
      for (const name of names) {
        try {
          const valid: string = validateApplicationBundleName(name)
          if (!apps.some((app: SelectableApplication) => app.bundleName === valid)) apps.push({ bundleName: valid, label: valid })
        } catch (_) { }
      }
      if (apps.length === 0) throw new Error('清单中没有有效鸿蒙包名；请使用每行一个包名的文本文件')
      this.prefs?.putSync('application-catalog', JSON.stringify(apps))
      await this.prefs?.flush()
      this.applicationCatalog = apps
      this.applicationCatalogState = 'imported'
      this.applicationMessage = `用户导入 ${apps.length} 个包名，未验证是否安装`
    } catch (failure) { this.applicationMessage = failure instanceof Error ? failure.message : '清单导入失败' }
  }

  private loadSsidPolicy(): void {
    try {
      const policy = normalizeSsidPolicy(JSON.parse(fileIo.readTextSync(this.context().filesDir + '/ssid-policy.json')))
      this.excludedSsids = policy.excluded || []; this.ssidEnabled = policy.enabled; this.directSsids = policy.direct.join('\n'); this.proxySsids = policy.proxy.join('\n'); this.ssidFallback = policy.fallback
      this.ssidActions = policy.actions || []
    } catch (_) { }
  }

  private async readCurrentSsid(): Promise<void> {
    try {
      if (!wifiManager.isWifiActive()) { this.currentSsid = ''; this.ssidMessage = '当前未连接 Wi-Fi'; return }
      const linked: wifiManager.WifiLinkedInfo = await wifiManager.getLinkedInfo()
      this.currentSsid = linked.connState === wifiManager.ConnState.CONNECTED ? linked.ssid : ''
      this.ssidMessage = this.currentSsid ? `当前 Wi-Fi：${this.currentSsid}` : '当前未连接 Wi-Fi 或系统隐藏了 SSID'
    } catch (_) { this.currentSsid = ''; this.ssidMessage = '无法读取 SSID，请检查系统 Wi-Fi 信息权限' }
  }

  private async saveSsidPolicy(): Promise<void> {
    try {
      const policy: SsidPolicy = this.currentSsidPolicy()
      await writeAtomicText(this.context().filesDir + '/ssid-policy.json', JSON.stringify(policy))
      this.ssidActions = policy.actions || []
      this.ssidMessage = '已保存，约 5 秒内生效'
    } catch (failure) {
      this.ssidMessage = failure instanceof Error ? failure.message : '保存失败'
      throw new Error(this.ssidMessage)
    }
  }

  private openSsidEditor(ssid?: string): void {
    this.editingSsid = ssid || ''
    this.draftSsid = ssid || ''
    this.draftSsidAction = this.ssidRuleAction(ssid || '')
    this.showSsidEditor = true
    setTimeout(()=>{if(this.showSsidEditor)this.ssidScroller.scrollEdge(Edge.Bottom)},80)
  }

  private toggleSsidSelection(ssid: string): void {
    this.selectedSsids = this.selectedSsids.includes(ssid)
      ? this.selectedSsids.filter((item: string) => item !== ssid)
      : [...this.selectedSsids, ssid]
  }

  private async addExcludedSsid(): Promise<void> {
    const previous: string[] = this.excludedSsids.slice()
    const previousActions: SsidAction[] = this.ssidActions.slice()
    const editing: string = this.editingSsid
    try {
      const next: SsidPolicy = withSsidRule(this.currentSsidPolicy(), editing, this.draftSsid, this.draftSsidAction)
      this.excludedSsids = next.excluded || []
      this.ssidActions = next.actions || []
      await this.saveSsidPolicy()
      this.showSsidEditor = false
      this.editingSsid = ''
    } catch (failure) { this.excludedSsids = previous; this.ssidActions = previousActions; this.toast(failure instanceof Error ? failure.message : 'SSID 无效') }
  }

  private ssidRuleAction(ssid: string): string {
    return this.ssidActions.find((item: SsidAction) => item.ssid === ssid)?.action || 'suspend'
  }

  private currentSsidPolicy(): SsidPolicy {
    return normalizeSsidPolicy({ enabled: true, direct: [], proxy: [], fallback: 'keep', excluded: this.excludedSsids,
      actions: this.excludedSsids.map((ssid: string): SsidAction => ({ssid: ssid, action: this.ssidRuleAction(ssid)})) })
  }

  private async deleteExcludedSsid(ssid: string): Promise<void> {
    const previous: string[] = this.excludedSsids.slice()
    try {
      this.excludedSsids = this.excludedSsids.filter((item: string) => item !== ssid)
      this.selectedSsids = this.selectedSsids.filter((item: string) => item !== ssid)
      await this.saveSsidPolicy()
    } catch (_) { this.excludedSsids = previous; this.toast('保存失败，请重试') }
  }

  private async deleteExcludedSsids(): Promise<void> {
    const previous: string[] = this.excludedSsids.slice()
    try {
      this.excludedSsids = this.excludedSsids.filter((ssid: string) => !this.selectedSsids.includes(ssid))
      await this.saveSsidPolicy()
      this.selectedSsids = []
    } catch (_) { this.excludedSsids = previous; this.toast('保存失败，请重试') }
  }

  @Builder
  ssidEditor() {
    Column({ space: 18 }) {
      Text(this.editingSsid.length > 0 ? '编辑 SSID' : '添加 SSID').fontSize(22).fontColor(this.palette().textPrimary).width('100%')
      TextInput({ text: this.draftSsid, placeholder: 'SSID' }).onChange((value: string) => { this.draftSsid = value }).maxLength(32)
      Row({ space: 12 }) {
        Text('连接此 Wi-Fi 时').fontColor(this.palette().textPrimary).layoutWeight(1)
        ForEach(['suspend', 'direct'], (action: string) => {
          Button(action === 'suspend' ? '挂起' : '直连')
            .backgroundColor(this.draftSsidAction === action ? this.palette().accentSoft : Color.Transparent)
            .fontColor(this.palette().textPrimary)
            .onClick(() => { this.draftSsidAction = action })
        })
      }.width('100%')
      Text(this.draftSsidAction === 'direct' ? '保留 VPN 和内核，以直连方式处理流量及已有过滤规则。' : '关闭 VPN 和节点代理，全部应用使用系统网络。')
        .fontSize(12).fontColor(this.palette().textSecondary).width('100%')
      Row() {
        Button('取消').backgroundColor(Color.Transparent).fontColor(this.palette().textSecondary)
          .onClick(() => { this.showSsidEditor = false; this.editingSsid = '' })
        Blank()
        Button('提交').backgroundColor(this.palette().accentSoft).fontColor(this.palette().textPrimary).onClick(() => this.addExcludedSsid())
      }.width('100%')
    }.padding(24).width('88%').borderRadius(28).backgroundColor(this.palette().surface)
  }

  @Builder
  ssidEditAction(ssid: string) {
    Column() { Text('编辑').fontSize(14).fontColor(Color.White) }
      .width(72).height('100%').justifyContent(FlexAlign.Center).backgroundColor('#1E6FFF').borderRadius(12)
      .onClick(() => this.openSsidEditor(ssid))
  }

  @Builder
  ssidDeleteAction(ssid: string) {
    Column() { Text('删除').fontSize(14).fontColor(Color.White) }
      .width(72).height('100%').justifyContent(FlexAlign.Center).backgroundColor('#D93025').borderRadius(12)
      .onClick(() => { this.deleteExcludedSsid(ssid).catch(() => {}) })
  }

  @Builder
  ssidPage() {
    Column() {
      List({ space: 12, scroller: this.ssidScroller }) {
        ListItem() {
          Column() { Blank().height(this.contentTopGap()) }.width('100%')
        }
        ListItem() {
          Row({ space: 12 }) {
            Column({ space: 8 }) {
              Text('SSID 规则').fontSize(22).fontWeight(FontWeight.Bold).fontColor(this.palette().textPrimary)
              Text('为每个 Wi-Fi 选择挂起或直连，离开后恢复原模式。')
                .fontSize(12).fontColor(this.palette().textSecondary)
              Text(`已添加 ${this.excludedSsids.length} 个${this.currentSsid.length > 0 ? ' · 当前 ' + this.currentSsid : ''}`)
                .fontSize(11).fontColor(this.palette().textSecondary)
            }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            Button('+').width(48).height(48).fontSize(28).backgroundColor(this.palette().accentSoft)
              .fontColor(this.palette().textPrimary).accessibilityText('添加 SSID 规则')
              .onClick(() => this.openSsidEditor())
          }.width('100%').padding(16)
            .backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass).borderRadius(12)
            .backgroundEffect({ radius: this.reduceTransparency ? 0 : 18, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
            .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#33FFFFFF' : '#99FFFFFF' })
        }
        if (this.selectedSsids.length > 0) {
          ListItem() {
            Row({ space: 8 }) {
              Text(`已选 ${this.selectedSsids.length}`).fontSize(14).fontColor(this.palette().textPrimary).layoutWeight(1)
              Button('全选').fontSize(13).height(38).backgroundColor(Color.Transparent).fontColor(this.palette().accent)
                .onClick(() => {
                  this.selectedSsids = this.selectedSsids.length === this.excludedSsids.length ? [] : this.excludedSsids.slice()
                })
              Button('删除').fontSize(13).height(38).fontColor(this.palette().danger)
                .onClick(() => this.deleteExcludedSsids())
              Button('取消').fontSize(13).height(38).backgroundColor(Color.Transparent)
                .onClick(() => { this.selectedSsids = [] })
            }.width('100%').padding(12).backgroundColor(this.palette().accentSoft).borderRadius(12)
          }
        }
        ForEach(this.excludedSsids, (ssid: string) => {
          ListItem() {
            Row({ space: 12 }) {
              if (this.selectedSsids.length > 0) {
                Text(this.selectedSsids.includes(ssid) ? '✓' : '').fontSize(18).fontColor(this.palette().accent)
              }
              Text(ssid).fontSize(16).fontColor(this.palette().textPrimary).layoutWeight(1).maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
              Text(this.ssidRuleAction(ssid) === 'direct' ? '直连' : '挂起').fontSize(13).fontColor(this.palette().accent)
              Text('右滑编辑 · 左滑删除').fontSize(10).fontColor(this.palette().textSecondary)
            }.width('100%').height(68).padding(16)
              .backgroundColor(this.selectedSsids.includes(ssid) ? this.palette().accentSoft : this.palette().surfaceGlass)
              .borderRadius(12)
              .backgroundEffect({ radius: this.reduceTransparency ? 0 : 18, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
              .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#33FFFFFF' : '#99FFFFFF' })
              .onClick(() => {
                if (this.selectedSsids.length > 0) this.toggleSsidSelection(ssid)
                else this.openSsidEditor(ssid)
              })
              .gesture(LongPressGesture().onAction(() => this.toggleSsidSelection(ssid)))
          }.swipeAction({ start: this.ssidEditAction(ssid), end: this.ssidDeleteAction(ssid) })
        }, (ssid: string) => ssid + ':' + this.ssidRuleAction(ssid))
        if (this.excludedSsids.length === 0) {
          ListItem() {
            Column({ space: 12 }) {
              Text('还没有 Wi-Fi 规则').fontSize(16).fontColor(this.palette().textPrimary)
              Text('点右上角 + 添加 SSID，并为它选择挂起或直连。')
                .fontSize(13).fontColor(this.palette().textSecondary).textAlign(TextAlign.Center)
              Button('添加 SSID').onClick(() => this.openSsidEditor())
            }.width('100%').padding(24).backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass).borderRadius(12)
              .alignItems(HorizontalAlign.Center)
              .backgroundEffect({ radius: this.reduceTransparency ? 0 : 18, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
              .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#33FFFFFF' : '#99FFFFFF' })
          }
        }
        if (this.ssidMessage.length > 0) {
          ListItem() {
            Text(this.ssidMessage).fontSize(12).fontColor(this.palette().textSecondary).width('100%')
          }
        }
        if(this.showSsidEditor)ListItem(){this.ssidEditor()}
        ListItem() { Column().height(this.mainContentBottomPadding()) }
      }.nestedScroll({scrollForward:NestedScrollMode.PARENT_FIRST,scrollBackward:NestedScrollMode.SELF_FIRST}).layoutWeight(1).padding({ left: 16, right: 16 })
    }
  }

  private async loadApplications(): Promise<void> {
    if (this.applicationLoading) return
    this.applicationLoading = true
    this.applicationMessage = '正在读取系统应用列表'
    try {
      const result: ApplicationCatalogResult = await new ApplicationCatalogService().readInstalledApplications(this.context())
      this.applicationCatalog = result.applications
      this.applicationCatalogState = result.state
      this.applicationMessage = result.message
    } catch (_) {
      this.applicationCatalog = []
      this.applicationCatalogState = 'error'
      this.applicationMessage = '读取应用列表失败，请检查签名权限后重试'
    } finally { this.applicationLoading = false }
  }

  private visibleApplications(): SelectableApplication[] {
    const query: string = this.applicationQuery.toLowerCase()
    return this.applicationCatalog.filter((app: SelectableApplication) =>
      (this.showSystemApplications || !app.systemApp) && (app.label.toLowerCase().includes(query) || app.bundleName.toLowerCase().includes(query)))
  }

  private toggleApplication(bundleName: string): void {
    const next: string[] = this.selectedApplications.includes(bundleName) ?
      this.selectedApplications.filter((name: string) => name !== bundleName) : [...this.selectedApplications, bundleName]
    try {
      normalizeVpnApplicationScope({ mode: 'all', trustedApplications: next })
      this.selectedApplications = next
      this.applicationDirty = true
    } catch (failure) { this.toast(failure instanceof Error ? failure.message : '选择失败') }
  }

  private selectVisibleApplications(invert: boolean): void {
    const names: string[] = this.visibleApplications().map((app: SelectableApplication) => app.bundleName)
    const next: string[] = invert ? invertApplicationSelection(this.selectedApplications, names) :
      [...this.selectedApplications, ...names.filter((name: string) => !this.selectedApplications.includes(name))]
    try {
      normalizeVpnApplicationScope({ mode: 'all', trustedApplications: next })
      this.selectedApplications = next; this.applicationDirty = true
    } catch (failure) { this.toast(failure instanceof Error ? failure.message : '选择失败') }
  }

  private async finishApplications(): Promise<void> {
    if (this.applicationDirty && !await this.saveApplications()) return
    this.page = ''
  }

  private async saveApplications(): Promise<boolean> {
    if (!this.prefs || !this.coordinator || this.busy) return false
    this.busy = true
    try {
      const scope = perAppScope(this.perAppEnabled, this.perAppBypass, this.selectedApplications)
      const running: boolean = this.phase === 'running'
      const profile: SfaProfile | undefined = this.selectedProfile()
      const config: string = running && profile ? this.runtimeConfig(profile) : ''
      if (running) this.applyStatus(await this.coordinator.disconnect())
      this.prefs.putSync('application-scope', JSON.stringify(scope))
      this.prefs.putSync('per-app-enabled', this.perAppEnabled)
      this.prefs.putSync('per-app-bypass', this.perAppBypass)
      await this.prefs.flush()
      this.networkSettings.applicationMode = scope.mode
      this.networkSettings.trustedApplications = scope.trustedApplications.slice()
      this.applicationMode = scope.mode
      if (running && config.length > 0) this.applyStatus(await this.connectProfile(config, scope, profile ? profile.id : 'legacy-default'))
      this.applicationDirty = false
      return true
    } catch (failure) { this.toast(failure instanceof Error ? failure.message : '保存失败'); return false }
    finally { this.busy = false }
  }

  @Builder
  applicationsPage() {
    Column({ space: 0 }) {
      Blank().height(this.contentTopGap())
      Row({ space: 8 }) {
        Text('启用分应用').fontSize(13).fontColor(this.palette().textPrimary)
        Toggle({ type: ToggleType.Switch, isOn: this.perAppEnabled }).scale({ x: 0.8, y: 0.8 })
          .onChange((value: boolean) => { this.perAppEnabled = value; this.applicationDirty = true })
        Blank()
        Text('绕行模式').fontSize(13).fontColor(this.palette().textPrimary)
        Toggle({ type: ToggleType.Switch, isOn: this.perAppBypass }).scale({ x: 0.8, y: 0.8 })
          .onChange((value: boolean) => { this.perAppBypass = value; this.applicationDirty = true })
        Button('ⓘ').width(32).height(40).backgroundColor(Color.Transparent).fontColor(this.palette().textSecondary)
          .onClick(() => this.getUIContext().getPromptAction().showDialog({ title: '分应用代理',
            message: 'SSID 挂起优先：挂起时全部应用不代理。\n启用分应用后，勾选的应用走代理；开启绕行模式后，勾选的应用不代理。未选择应用时代理全部。返回时保存并应用。',
            buttons: [{ text: '确定', color: this.palette().accent }] }))
      }.width('100%').padding({ left: 16, right: 10 }).height(64)
      if (this.applicationSearchVisible) {
        TextInput({ text: this.applicationQuery, placeholder: '搜索应用名称或包名' }).margin({ left: 16, right: 16, bottom: 8 })
          .onChange((value: string) => { this.applicationQuery = value })
      }
      Divider().color(this.palette().border)
      if (this.applicationLoading) {
        LoadingProgress().width(36).height(36).margin(24)
      }
      List({ space: 0 }) {
        ForEach(this.visibleApplications(), (app: SelectableApplication) => {
          ListItem() {
            Row({ space: 16 }) {
              Stack() {
                Text(app.label.substring(0, 1)).fontSize(18).fontColor(this.palette().accent)
                if (app.icon) Image(app.icon).width(36).height(36).borderRadius(8)
              }.width(36).height(36).borderRadius(8).backgroundColor(this.palette().surfaceElevated)
              Column({ space: 4 }) {
                Text(app.label).fontSize(15).fontColor(this.palette().textPrimary).maxLines(1)
                Text(app.bundleName).fontSize(11).fontColor(this.palette().textSecondary).maxLines(1)
              }.layoutWeight(1).constraintSize({ maxWidth: '100%' }).alignItems(HorizontalAlign.Start)
              Checkbox({ name: app.bundleName }).select(this.selectedApplications.includes(app.bundleName))
                .onChange((checked: boolean) => { if (checked !== this.selectedApplications.includes(app.bundleName)) this.toggleApplication(app.bundleName) })
            }.width('100%').height(72).padding({ left: 16, right: 10 })
          }
        }, (app: SelectableApplication) => app.bundleName)
      }.nestedScroll({scrollForward:NestedScrollMode.PARENT_FIRST,scrollBackward:NestedScrollMode.SELF_FIRST}).layoutWeight(1).width('100%').divider({ strokeWidth: 0.5, color: this.palette().border, startMargin: 66 })
      Text(this.applicationMessage).fontSize(12).fontColor(this.palette().textSecondary).width('100%').padding({ left: 16, right: 16, top: 10 })
      Row() {
        Text(`已选 ${this.selectedApplications.length} 个`).fontSize(12).fontColor(this.palette().textSecondary).layoutWeight(1)
        Button('完成').fontSize(14).backgroundColor(Color.Transparent).fontColor(this.palette().accent)
          .enabled(!this.busy).onClick(() => this.finishApplications())
      }.width('100%').padding({ left: 16, right: 12, bottom: this.mainContentBottomPadding() })
    }.layoutWeight(1).width('100%')
  }

  @Builder
  connectionsPage() {
    Column({ space: 12 }) {
      TextInput({ text: this.connectionQuery, placeholder: '搜索域名、地址或出站' }).onChange((value: string) => { this.connectionQuery = value })
      Text(`活动连接 ${this.connectionCount} · 最多显示 100 条`).fontSize(13).fontColor(this.palette().textSecondary)
      List({ space: 12 }) {
        ForEach(this.liveConnections.filter((item: LiveConnection) => `${item.domain} ${item.destination} ${item.outbound}`.toLowerCase().includes(this.connectionQuery.toLowerCase())), (item: LiveConnection) => {
          ListItem() {
            Column({ space: 8 }) {
              Row() {
                Text(`${(item.network || '').toUpperCase()}  ${item.domain || item.destination || ''}`).layoutWeight(1).fontSize(14).fontColor(this.palette().textPrimary)
                Button('关闭').fontSize(12).height(30).enabled(!this.busy).onClick(() => this.control({ action: 'close-connection', id: item.id }))
              }
              Text(`↑ ${this.formatBytes(item.uplinkTotal || 0)}   ↓ ${this.formatBytes(item.downlinkTotal || 0)}`).fontSize(13).fontColor(this.palette().textSecondary)
              Text(`${item.inbound || ''} → ${item.outbound || ''}`).fontSize(13).fontColor(this.palette().textSecondary)
              if (item.rule) Text(item.rule).fontSize(12).fontColor(this.palette().textSecondary).maxLines(2)
            }.width('100%').alignItems(HorizontalAlign.Start).padding(16).backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass).borderRadius(12)
        .backgroundEffect({ radius: this.reduceTransparency ? 0 : 18, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
        .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#33FFFFFF' : '#99FFFFFF' })
          }
        }, (item: LiveConnection) => `${item.id}:${item.uplinkTotal}:${item.downlinkTotal}`)
        ListItem() { Column().height(this.mainContentBottomPadding()) }
      }.nestedScroll({scrollForward:NestedScrollMode.PARENT_FIRST,scrollBackward:NestedScrollMode.SELF_FIRST}).layoutWeight(1).width('100%')
    }.padding({ left: 16, right: 16, top: this.contentTopGap() + 4 }).layoutWeight(1)
  }

  @Builder
  webrtcPage() {
    Column({ space: 12 }) {
      Text('应用内 WebView 检测仅代表本页，不代表其他浏览器。请同时在实际使用的浏览器复测。').fontSize(13).fontColor(this.palette().textSecondary).padding(12)
      Button('在外部浏览器复测候选类型').onClick(() => { this.context().startAbility({ action: 'ohos.want.action.viewData', uri: 'https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/' }).catch(() => { this.toast('无法打开浏览器') }) })
      Web({ src: $rawfile('webrtc-diagnostic.html'), controller: this.webRtcController }).javaScriptAccess(true).domStorageAccess(false).layoutWeight(1)
    }.padding({ top: this.contentTopGap() + 4, bottom: this.mainContentBottomPadding() }).width('100%').layoutWeight(1)
  }

  private async checkUpdates(manual: boolean): Promise<void> {
    if (this.updateChecking) return
    if (!manual && this.prefs && Date.now() - (this.prefs.getSync('last-update-check', 0) as number) < 86400000) return
    this.updateChecking = true
    try {
      const release = await checkAppUpdate()
      if (this.prefs) { this.prefs.putSync('last-update-check', Date.now()); await this.prefs.flush() }
      if (release === null) { if (manual) this.toast('当前已是本渠道最新版本'); return }
      if (!this.uiForeground) return
      const result = await this.getUIContext().getPromptAction().showDialog({
        title: '发现新版本 ' + release.tag_name,
        message: (coreIsPrerelease(CORE_VERSION) ? 'Beta 内核渠道' : '稳定内核渠道') + '\n' + (release.body || '查看 GitHub 更新说明').slice(0, 1800) + '\n下载后请用原签名覆盖安装，以保留配置。',
        buttons: [{ text: '稍后', color: '#777777' }, { text: '查看更新', color: '#5368B5' }]
      })
      if (result.index === 1) await this.openSource(release.html_url)
    } catch (failure) { if (manual) this.toast(failure instanceof Error ? failure.message : '检查更新失败') }
    finally { this.updateChecking = false }
  }

  @Builder
  privacyPage() {
    Scroll() {
      Column({ space: 20 }) {
        Blank().height(this.contentTopGap())
      Row() {
        Text('IPv6').fontSize(16).fontColor(this.palette().textPrimary).layoutWeight(1)
        Text('TUN 接管').fontSize(14).fontColor(this.palette().textSecondary)
      }.width('100%')
      Text('TUN 同时接管 IPv4 与 IPv6，代理流量交给节点；实际走 IPv4 还是 IPv6 由节点侧决定。').fontSize(12).fontColor(this.palette().textSecondary).width('100%')
      Row() {
        Text('WebRTC 防直连').fontSize(16).fontColor(this.palette().textPrimary).layoutWeight(1)
        Toggle({ type: ToggleType.Switch, isOn: this.protectWebRtc }).enabled(!this.busy).onChange((value: boolean) => { this.protectWebRtc = value; this.saveTrafficPrivacy() })
      }.width('100%')
      Text('规则／全局模式下 STUN 使用代理出站；直连模式、SSID 挂起及排除应用仍直连。可能影响需要直连的语音通话；浏览器本地候选地址不由 VPN 隐藏。').fontSize(12).fontColor(this.palette().textSecondary).width('100%')
      Row() {
        Text('禁用 STUN').fontSize(16).fontColor(this.palette().textPrimary).layoutWeight(1)
        Toggle({ type: ToggleType.Switch, isOn: this.strictWebRtc }).enabled(!this.busy).onChange((value: boolean) => { this.strictWebRtc = value; this.saveTrafficPrivacy() })
      }.width('100%')
      Text('开启后，规则／全局模式拒绝可识别的 UDP STUN 探测，适用于导入的完整配置。可能影响语音、视频和游戏；不能阻止浏览器公开本机候选地址。直连、SSID 挂起及排除应用不在保护范围。配置已有的拦截规则仍保留。').fontSize(12).fontColor(this.palette().textSecondary).width('100%')
      Button('WebRTC 网络检测').onClick(() => { this.page = 'webrtc' })
      }.width('100%').padding({ left: 20, right: 20, bottom: this.mainContentBottomPadding() })
    }.nestedScroll({scrollForward:NestedScrollMode.PARENT_FIRST,scrollBackward:NestedScrollMode.SELF_FIRST}).layoutWeight(1).align(Alignment.Top)
  }

  @Builder
  appearancePage() {
    Scroll() {
    Column({ space: 20 }) {
      Text('主题').fontSize(16).fontColor(this.palette().textPrimary).width('100%')
      Row({ space: 8 }) {
        ForEach(['system', 'light', 'dark'], (theme: string) => {
          Button(theme === 'system' ? '跟随系统' : (theme === 'light' ? '浅色' : '深色')).layoutWeight(1)
            .fontSize(14).backgroundColor(this.theme === theme ? this.palette().accentSoft : this.palette().surface)
            .fontColor(this.palette().textPrimary).onClick(() => { this.theme = theme; this.saveAppearance() })
        }, (theme: string) => theme)
      }.width('100%')
      Text('背景').fontSize(16).fontColor(this.palette().textPrimary).width('100%')
      Row({space:8}) {
        Button('默认渐变').onClick(() => { this.backgroundMode = 'default'; this.saveAppearance() })
        Button('选择背景图片').enabled(!this.backgroundImageBusy).onClick(() => this.chooseBackgroundImage())
      }.width('100%')
      Flex({wrap:FlexWrap.Wrap}) {
        ForEach(BACKGROUND_SWATCHES, (swatch: BackgroundSwatch) => {
          Button(swatch.name + (this.backgroundMode === 'solid' && this.backgroundSolidColor === swatch.color ? ' ✓' : ''))
            .width('30%').height(40).margin({right:'3%',bottom:8}).fontSize(12)
            .backgroundColor(swatch.color).fontColor(backgroundColorIsDark(swatch.color) ? '#FFFFFF' : '#17171C')
            .border({width:1,color:this.palette().borderStrong}).onClick(() => this.selectBackgroundColor(swatch.color))
        }, (swatch: BackgroundSwatch) => swatch.color)
      }.width('100%')
      Row({space:8}) {
        TextInput({text:this.backgroundColorDraft,placeholder:'#RRGGBB'}).layoutWeight(1).maxLength(7)
          .onChange((value:string) => { this.backgroundColorDraft = value })
        Button('应用颜色').onClick(() => this.selectBackgroundColor(this.backgroundColorDraft))
      }.width('100%')
      Row() {
        Text('减少透明效果').fontSize(16).fontColor(this.palette().textPrimary).layoutWeight(1)
        Toggle({ type: ToggleType.Switch, isOn: this.reduceTransparency }).onChange((value: boolean) => {
          this.reduceTransparency = value; this.saveAppearance()
        })
      }.width('100%')
    }.width('100%').padding({ left: 20, right: 20, top: this.contentTopGap() + 20, bottom: this.mainContentBottomPadding() })
    }.width('100%').height('100%').clip(true).scrollBar(BarState.Auto)
      .nestedScroll({scrollForward:NestedScrollMode.SELF_FIRST,scrollBackward:NestedScrollMode.SELF_FIRST})
  }

  private selectBackgroundColor(value: string): void {
    try {
      const color: string = normalizeBackgroundColor(value)
      this.backgroundSolidColor = color; this.backgroundColorDraft = color; this.backgroundMode = 'solid'
      this.theme = backgroundColorIsDark(color) ? 'dark' : 'light'
      this.saveAppearance()
    } catch (failure) { this.toast(failure instanceof Error ? failure.message : '颜色格式无效') }
  }

  private async chooseBackgroundImage(): Promise<void> {
    if (this.backgroundImageBusy) return
    this.backgroundImageBusy = true
    let selected: fileIo.File | undefined = undefined
    let source: image.ImageSource | undefined = undefined
    try {
      const files: string[] = await new picker.DocumentViewPicker(this.context()).select({maxSelectNumber:1,fileSuffixFilters:['图片|.jpg,.jpeg,.png,.webp']})
      if (files.length === 0) return
      selected = await fileIo.open(files[0], fileIo.OpenMode.READ_ONLY)
      const stat: fileIo.Stat = await fileIo.stat(selected.fd)
      if (stat.size > 16 * 1024 * 1024) throw new Error('请选择不超过 16 MB 的图片')
      source = image.createImageSource(selected.fd)
      const info: image.ImageInfo = await source.getImageInfo()
      if (info.size.width * info.size.height > 16000000) throw new Error('请选择不超过 1600 万像素的图片')
      const name: string = 'appearance-background-' + Date.now() + '.img'
      await fileIo.copyFile(selected.fd, this.context().filesDir + '/' + name)
      const previous: string = this.backgroundImageName
      this.backgroundImageName = name; this.backgroundMode = 'image'
      const saved: boolean = await this.saveAppearance()
      if (saved && validBackgroundImageName(previous) && previous !== name) {
        try { await fileIo.unlink(this.context().filesDir + '/' + previous) } catch (_) { }
      }
    } catch (failure) { this.toast(failure instanceof Error ? failure.message : '背景图片读取失败') }
    finally {
      if (source) { try { await source.release() } catch (_) { } }
      if (selected) { try { await fileIo.close(selected) } catch (_) { } }
      this.backgroundImageBusy = false
    }
  }

  @Builder
  cardsPage() {
    Scroll() {
    Column({ space: 18 }) {
      ForEach(['traffic', 'connections', 'mode', 'profiles', 'groups'], (card: string) => {
        Row() {
          Text(card === 'traffic' ? '流量' : card === 'connections' ? '连接' : card === 'mode' ? '模式' :
            card === 'profiles' ? '配置' : '代理组').fontSize(16).fontColor(this.palette().textPrimary).layoutWeight(1)
          Toggle({ type: ToggleType.Switch, isOn: this.visibleCards.includes(card) }).onChange((enabled: boolean) => {
            this.visibleCards = enabled ? [...this.visibleCards, card] : this.visibleCards.filter((value: string) => value !== card)
            this.saveUiSettings()
          })
        }.width('100%')
      }, (card: string) => card)
    }.width('100%').padding({ left: 20, right: 20, top: this.contentTopGap() + 20, bottom: this.mainContentBottomPadding() })
    }.width('100%').layoutWeight(1).align(Alignment.Top).scrollBar(BarState.Auto)
  }

  private async openSource(url: string): Promise<void> {
    try { await this.context().startAbility({ action: 'ohos.want.action.viewData', uri: url }) }
    catch (_) { this.toast('无法打开浏览器，可长按复制源码地址') }
  }

  @Builder
  sourceEntry(name: string, detail: string, url: string) {
    Column({ space: 8 }) {
      Text(name).fontSize(17).fontWeight(FontWeight.Medium).fontColor(this.palette().textPrimary).width('100%')
      Text(detail).fontSize(13).fontColor(this.palette().textSecondary).width('100%')
      Text(url).fontSize(13).fontColor(this.palette().accent).width('100%').copyOption(CopyOptions.LocalDevice)
      Button('打开源码仓库').fontSize(13).onClick(() => this.openSource(url))
    }.width('100%').padding(16).borderRadius(16).backgroundColor(this.palette().surfaceElevated)
  }

  @Builder
  sourcesPage() {
    Scroll() {
      Column({ space: 16 }) {
        Blank().height(this.contentTopGap())
        Text('本应用为非官方 HarmonyOS 移植。本版修改后的完整对应源码随 HAP 单独提供；以下为上游及参考项目地址。').fontSize(14).fontColor(this.palette().textSecondary)
        this.sourceEntry('本项目 / sing-box-for-harmonyos', '本移植版本的源码、更新记录和问题反馈。', 'https://github.com/being123321/sing-box-for-harmonyos')
        this.sourceEntry('SagerNet / sing-box', '实际使用内核 1.14.4，含鸿蒙平台适配。GPL-3.0-or-later。', 'https://github.com/SagerNet/sing-box')
        this.sourceEntry('MetaCubeX / meta-rules-dat', '旧版内置配置使用的大陆域名、GeoIP 和 GFW 规则。GPL-3.0。', 'https://github.com/MetaCubeX/meta-rules-dat')
        this.sourceEntry('SagerNet / sing-box-for-android', '安卓版 1.14.4 的界面、图标和配置导入格式参考；Android 代码未直接作为鸿蒙界面运行。', 'https://github.com/SagerNet/sing-box-for-android')
        this.sourceEntry('AI-Scarlett / HarmonyOS_VPN', '应用基础工程，基于 b7a75930d2bf 修改。许可证与声明见对应源码包。', 'https://github.com/AI-Scarlett/HarmonyOS_VPN')
        this.sourceEntry('SagerNet / gvisor', '实际使用网络栈，基于 e9989ea3436f 的兼容源码。Apache-2.0。', 'https://github.com/SagerNet/gvisor')
        this.sourceEntry('yourblacksky / ohos_golang_go', '实际使用 OHOS Go 工具链源码，基于 e7463379a44e，并保留本地运行时启动修复。', 'https://github.com/yourblacksky/ohos_golang_go')
        this.sourceEntry('tljk / FlClash-ohos', '用户提供的鸿蒙代理应用调研参考，未作为本版主界面框架。', 'https://github.com/tljk/FlClash-ohos')
        this.sourceEntry('2dust / v2rayNG', '分应用设置界面和启用／绕行语义参考。Android 应用枚举接口不能直接用于鸿蒙。', 'https://github.com/2dust/v2rayNG')
        this.sourceEntry('miramira8295 / TelegramForHarmony', '用户指定的毛玻璃视觉参考；本版采用 ArkUI 原生模糊材质实现。', 'https://github.com/miramira8295/TelegramForHarmony')
        Text('完整许可证及构建来源记录位于对应源码包的 LICENSE、THIRD_PARTY_NOTICES.md 和 BUILD-MANIFEST.json。').fontSize(13).fontColor(this.palette().textSecondary)
      }.width('100%').padding({ left: 16, right: 16, bottom: this.mainContentBottomPadding() })
    }.nestedScroll({scrollForward:NestedScrollMode.PARENT_FIRST,scrollBackward:NestedScrollMode.SELF_FIRST}).layoutWeight(1).align(Alignment.Top)
  }

  @Builder
  aboutPage() {
    Scroll() {
      Column({ space: 16 }) {
        Blank().height(this.contentTopGap())
        Image($r('app.media.sfa_launcher')).width(96).height(96)
        Text('sing-box').fontSize(26).fontWeight(FontWeight.Bold).fontColor(this.palette().textPrimary)
        Text(CORE_VERSION + ' · HarmonyOS ' + APP_VERSION + (coreIsPrerelease(CORE_VERSION) ? ' · Beta' : ' · 稳定版')).fontSize(14).fontColor(this.palette().textSecondary)
        Button(this.updateChecking?'正在检查更新…':'检查 GitHub 更新').onClick(()=>this.checkUpdates(true))
        Text('非官方鸿蒙移植，未获 SagerNet 官方背书。').fontSize(14).fontColor(this.palette().textSecondary)
        Text('界面参照安卓版 SFA 1.14.4。Android 专有权限、Xposed、USB/IP 等能力不能直接移植；本版工具尚未与安卓版完全一致。')
          .fontSize(13).lineHeight(21).fontColor(this.palette().textSecondary)
        Text('配置在本机加密保存。远程配置仅在你点击保存或更新时下载。VPN 授权由系统处理。')
          .fontSize(13).lineHeight(21).fontColor(this.palette().textSecondary)
        Text('GPL-3.0-or-later · 开源许可与对应源码随安装包单独提供。')
          .fontSize(13).lineHeight(21).fontColor(this.palette().textSecondary)
      }.width('100%').padding({left:24,right:24,top:24,bottom:this.mainContentBottomPadding()})
    }.nestedScroll({scrollForward:NestedScrollMode.PARENT_FIRST,scrollBackward:NestedScrollMode.SELF_FIRST}).layoutWeight(1).align(Alignment.Top)
  }


  private backFromPage(): void {
    if (this.page === 'applications') { this.finishApplications(); return }
    if (this.page === 'json-editor') { this.page = 'editor'; return }
    if (this.page === 'editor') {
      if (this.busy) return
      if (this.editorHasChanges()) {
        this.getUIContext().getPromptAction().showDialog({ title: '配置尚未保存', message: '是否保存当前修改？',
          buttons: [{ text: '继续编辑', color: this.palette().textSecondary }, { text: '放弃修改', color: this.palette().danger }, { text: '保存', color: this.palette().accent }]
        }).then((result) => { if (result.index === 1) this.page = this.editorReturnPage; if (result.index === 2) this.saveEditor() })
      } else this.page = this.editorReturnPage
      return
    }
    if (this.page === 'import') { this.page = 'profiles'; return }
    this.page = drawerParent(this.page)
  }

  @Builder
  importPage() {
    Scroll() {
      Column({ space: 16 }) {
        Blank().height(this.contentTopGap())
        Text('智能导入').fontSize(15).fontColor(this.palette().accent).width('100%')
        Text('支持完整 sing-box JSON、HTTPS 配置地址和 sing-box:// 远程配置。')
          .fontSize(13).fontColor(this.palette().textSecondary).width('100%')
        TextArea({ text: this.importText, placeholder: '粘贴完整 sing-box JSON 或远程配置地址' }).height(240)
          .fontSize(12).fontFamily('monospace').onChange((value: string) => { this.importText = value })
        Row({ space: 12 }) {
          Button('粘贴').layoutWeight(1).height(44).onClick(() => this.pasteImport())
          Button('扫码').layoutWeight(1).height(44).onClick(async () => { await this.scanProfile() })
        }.width('100%')
        Button('导入').width('100%').height(46).enabled(!this.busy)
          .onClick(async () => { await this.importSmart() })
        if (this.busy) LoadingProgress().width(32).height(32)
      }.width('100%').padding({ left: 18, right: 18, bottom: this.mainContentBottomPadding() }).alignItems(HorizontalAlign.Start)
    }.nestedScroll({scrollForward:NestedScrollMode.PARENT_FIRST,scrollBackward:NestedScrollMode.SELF_FIRST}).layoutWeight(1).align(Alignment.Top)
  }

  @State private navTarget: string = ''
  private navSwitchGeneration: number = 0

  private selectNavigation(target: string): void {
    const generation: number = ++this.navSwitchGeneration
    this.tab = target
    this.logScrolled=false;this.logReturning=false
    this.page = ''
    this.navTarget = ''
    // Page selection never waits for animation or an IPC round-trip.
    setTimeout(() => {
      if (generation !== this.navSwitchGeneration || !this.uiForeground || !this.pageAlive) return
      this.drawerScroller.scrollTo({ xOffset: 0, yOffset: 0 })
      this.poll()
    }, 0)
  }

  private highlightedNav(): string {
    return this.navDragging && this.navPreviewIndex >= 0 ? NAVIGATION_TABS[this.navPreviewIndex] : (this.navTarget || this.tab)
  }

  private navGlowLeft(): number {
    const index: number = Math.max(0, NAVIGATION_TABS.indexOf(this.highlightedNav()))
    const x: number = this.navDragging ? this.navPointerX : (index + 0.5) * this.navBarWidth / 4
    return navigationGlowX(x, this.navBarWidth, Math.max(0, this.navBarWidth / 4 - 8))
  }

  private navCapsuleWidth(): number { return Math.max(0, this.navBarWidth / 4 - 8) }

  private navCapsuleHeight(): number { return this.dockSize(56) }

  private finishNavDrag(commit: boolean): void {
    if (!this.navDragging) return
    const target: string = commit && this.navPreviewIndex >= 0 ? NAVIGATION_TABS[this.navPreviewIndex] : ''
    this.navDragging = false; this.navPreviewIndex = -1; this.navIgnoreClickUntil = Date.now() + 350
    if (target.length > 0) this.selectNavigation(target)
  }

  private handleNavTouch(event: TouchEvent): void {
    if (event.type === TouchType.Cancel) { this.finishNavDrag(false); return }
    if (event.touches.length > 1) { this.finishNavDrag(false); return }
    const point: TouchObject | undefined = event.changedTouches[0] || event.touches[0]
    if (event.type === TouchType.Down && point) {
      this.navSwitchGeneration++; this.navTarget = ''
      this.navDragging = true
      this.navPointerX = point.x; this.navPreviewIndex = navigationIndex(point.x, this.navBarWidth)
    } else if (event.type === TouchType.Move && this.navDragging && point) {
      if (point.x < 0 || point.x > this.navBarWidth || point.y < 0 || point.y > this.dockSize(72)) {
        if (point.y >= 0 && point.y <= this.dockSize(72)) {
          this.navPointerX = Math.min(this.navBarWidth, Math.max(0, point.x))
          this.navPreviewIndex = navigationIndex(this.navPointerX, this.navBarWidth)
        }
        this.finishNavDrag(true); return
      }
      this.navPointerX = point.x; this.navPreviewIndex = navigationIndex(point.x, this.navBarWidth)
    } else if (event.type === TouchType.Up) {
      if (this.navDragging && point && point.x >= 0 && point.x <= this.navBarWidth && point.y >= 0 && point.y <= this.dockSize(72)) {
        this.navPointerX = point.x; this.navPreviewIndex = navigationIndex(point.x, this.navBarWidth)
      }
      this.finishNavDrag(true)
    }
  }

  @Builder
  navItem(name: string, label: string) {
    Column({ space: this.dockSize(4) }) {
      Image($rawfile(`sfa-${name}.svg`)).width(this.dockSize(24)).height(this.dockSize(24))
        .fillColor(this.highlightedNav() === name ? this.palette().accent : this.palette().textSecondary)
        .animation({duration:160,curve:Curve.EaseOut})
      Text(label).fontSize(this.dockSize(12)).fontWeight(this.highlightedNav() === name ? FontWeight.Medium : FontWeight.Normal)
        .fontColor(this.highlightedNav() === name ? this.palette().accent : this.palette().textSecondary)
        .animation({duration:160,curve:Curve.EaseOut})
    }.layoutWeight(1).height(this.dockSize(72)).justifyContent(FlexAlign.Center)
      .onClick(() => { if (Date.now() >= this.navIgnoreClickUntil) this.selectNavigation(name) })
  }

  @Builder
  navigationFace() {
          Stack({ alignContent: Alignment.TopStart }) {
            if (this.navBarWidth > 0) {
              Column().width(Math.max(0, this.navBarWidth / 4 - 8)).height(this.dockSize(64)).borderRadius(this.dockSize(28))
                .backgroundColor(this.selectedMenuTint())
                .border({ width: 0.5, color: '#33FFFFFF' })
                .position({ x: this.navGlowLeft(), y: this.dockSize(4) }).hitTestBehavior(HitTestMode.None)
                .animation({ duration: this.navDragging ? 0 : 160, curve: Curve.EaseOut })
            }
          Row() {
            this.navItem('dashboard', '仪表')
            this.navItem('log', '日志')
            this.navItem('tools', '工具')
            this.navItem('settings', '设置')
          }.width('100%').height(this.dockSize(72))
          }.width('100%').height(this.dockSize(72)).borderRadius(this.dockSize(36))
          .onAreaChange((_old: Area, area: Area) => { this.navBarWidth = Number(area.width) })
          .onTouch((event: TouchEvent) => this.handleNavTouch(event))
          .clip(true).attributeModifier(this.glassModifier(true))


  }

  @Builder
  navigationBar() {
    Stack() {
      this.glassBase(this.dockSize(72))
      Tabs({ barPosition: BarPosition.End }) {
        TabContent() { Column() }.tabBar(this.navigationFace())
      }.width('100%').height(this.dockSize(72)).barHeight(this.dockSize(72))
        .barBackgroundColor(Color.Transparent).barMode(BarMode.Fixed).scrollable(false).clip(false)
    }.width('100%').height(this.dockSize(72)).borderRadius(this.dockSize(36))
      .margin({ bottom: this.bottomInset() })
  }

  private contentTopGap(): number { return this.topInset() + 64 }

  private drawerBodyHeight(): number {
    return Math.max(240,this.viewportHeight - this.topInset() - 64 - this.floatingControlsHeight())
  }

  private floatingControlsHeight(): number {
    return this.bottomInset() + this.dockSize(72) + (this.phase === 'running' ? this.runningBarSize(56) : this.dockSize(72)) + 20
  }

  private openDrawer(key: string): void {
    if (drawerRoot(this.page) === key) { this.backFromDrawer(); return }
    this.page = key
    if (key === 'applications') this.loadApplications()
    if (key === 'ssid') this.readCurrentSsid()
  }

  private backFromDrawer(): void {
    if (this.page === 'editor' || this.page === 'json-editor') this.backFromPage()
    else this.page = ''
  }

  @Builder
  drawerHeader(menu: DrawerMenu) {
    if (drawerRoot(this.page) === menu.key) {
      this.appToolbar(true)
    } else {
      Row({space:12}) {
        Column({space:4}) {
          Text(menu.title).fontSize(16).fontColor(this.palette().textPrimary)
          if(menu.detail)Text(menu.detail).fontSize(12).fontColor(this.palette().textSecondary)
        }.layoutWeight(1).alignItems(HorizontalAlign.Start)
        Text('⌄').fontSize(24).fontColor(this.palette().textSecondary)
      }.width('100%').height(72).padding(16).borderRadius(12).backgroundColor(this.palette().surfaceGlass)
        .onClick(()=>this.openDrawer(menu.key))
    }
  }

  @Builder
  configurationDrawer() {
    Column() {
      this.settingRow('自定义配置',this.catalog.profiles.length + ' 个配置','profiles')
      if(this.page === 'profiles')this.profilesPage()
      else if(this.page === 'editor')this.editor()
      else if(this.page === 'json-editor')this.jsonEditor()
      else if(this.page === 'import')this.importPage()
      else if(this.page === 'add-profile')this.addProfileSheet()
    }.width('100%').height('100%')
  }

  @Builder
  drawerBody() {
    if(drawerRoot(this.page) === 'configuration')this.configurationDrawer()
    else if(this.page === 'appearance')this.appearancePage()
    else if(this.page === 'privacy')this.privacyPage()
    else if(this.page === 'ssid')this.ssidPage()
    else if(this.page === 'applications')this.applicationsPage()
    else if(this.page === 'cards')this.cardsPage()
    else if(this.page === 'sources')this.sourcesPage()
    else if(this.page === 'about')this.aboutPage()
    else if(this.page === 'webrtc')this.webrtcPage()
    else if(this.page === 'groups')this.groupsPage()
    else if(this.page === 'connections')this.connectionsPage()
    else if(this.page === 'tailscale') {
      TailscaleEndpointContent({embedded:true,bottomClearance:this.mainContentBottomPadding(),topClearance:this.contentTopGap(),initialPalette:this.palette(),initialCoordinator:this.coordinator,foreground:this.uiForeground})
    } else if(this.page === 'dns-query') {
      Column({space:16}) {
        TextInput({text:this.host,placeholder:'域名'}).onChange((value:string)=>{this.host=value})
        Button('查询').onClick(async()=>{
          try{const result:connection.NetAddress[]=await connection.getAddressesByName(this.host.trim());this.toolResult=result.map((item:connection.NetAddress)=>item.address).join('\n')}
          catch(_){this.toolResult='查询失败'}
        })
        Text(this.toolResult).fontColor(this.palette().textPrimary).copyOption(CopyOptions.InApp)
      }.padding(16)
    }
  }

  @Builder
  drawerRootView() {
    List({scroller:this.drawerScroller,space:10}) {
      ListItem() {
        if(this.tab === 'dashboard' || this.tab === 'log') {
          Column(){if(this.tab==='log')this.logsPage();else this.dashboard()}
            .height(this.viewportHeight-this.topInset()).width('100%')
        } else Column(){Blank().height(this.page === 'appearance' ? 0 : 64)}
      }
      ForEach(drawerMenus(this.tab,this.page),(menu:DrawerMenu)=>{
        if(drawerRoot(this.page)===menu.key) {
          ListItemGroup({header:this.drawerHeader(menu)}) {
            ListItem(){Column(){this.drawerBody()}.height(this.drawerBodyHeight()).width('100%')}
          }
        } else ListItem(){this.drawerHeader(menu)}
      },(menu:DrawerMenu)=>menu.key)
      if(this.page||this.tab==='tools'||this.tab==='settings')ListItem(){Column(){Blank().height(this.floatingControlsHeight())}}
    }.width('100%').height(this.page === 'appearance' ? Math.max(240,this.viewportHeight-this.contentTopGap()) : '100%')
      .margin({top:this.page === 'appearance' ? this.contentTopGap() : 0})
      .padding({top:this.page === 'appearance' ? 0 : this.topInset(),left:12,right:12})
      .sticky(StickyStyle.Header)
      .onScrollIndex((start:number)=>{
        const active:number=drawerMenus(this.tab,this.page).findIndex((menu:DrawerMenu)=>menu.key===drawerRoot(this.page))
        this.drawerPinned=this.page.length>0&&active>=0&&start>=active+1
      })
      .onWillScroll((offset:number):ScrollResult=>({offsetRemain:this.page&&this.page!=='appearance'&&this.drawerPinned&&offset>0?0:offset}))
  }

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
      if (this.backgroundMode === 'image' && this.backgroundImageName) {
        Image('file://' + this.context().filesDir + '/' + this.backgroundImageName)
          .width('100%').height('100%').objectFit(ImageFit.Cover).hitTestBehavior(HitTestMode.None)
        Column() {}.width('100%').height('100%')
          .backgroundColor(this.palette() === DARK_PALETTE ? '#55000000' : '#55FFFFFF').hitTestBehavior(HitTestMode.None)
      }
      Column() {
        if (!this.ready) {
          Column({ space: 16 }) {
            LoadingProgress().width(40).height(40)
            Text('正在加载配置').fontColor(this.palette().textSecondary)
          }.layoutWeight(1).justifyContent(FlexAlign.Center)
        } else if (this.page === 'import') this.importPage()
        else if (this.page === 'profiles') this.profilesPage()
        else if (this.page === 'editor') this.editor()
        else if (this.page === 'json-editor') this.jsonEditor()
        else if (this.page === 'add-profile') {
          Scroll() { Column() {
            Blank().height(this.contentTopGap())
            this.addProfileSheet()
            Blank().height(this.mainContentBottomPadding())
          }.width('100%') }.width('100%').layoutWeight(1).align(Alignment.Top)
        }
        else if (this.page === 'groups') this.groupsPage()
        else if (this.page === 'sources') this.sourcesPage()
        else if (this.page === 'ssid') this.ssidPage()
        else if (this.page === 'connections') this.connectionsPage()
        else if (this.page === 'applications') this.applicationsPage()
        else if (this.page === 'appearance') this.appearancePage()
        else if (this.page === 'privacy') this.privacyPage()
        else if (this.page === 'webrtc') this.webrtcPage()
        else if (this.page === 'about') this.aboutPage()
        else if (this.page === 'cards') this.cardsPage()
        else if (this.page === 'tailscale') TailscaleEndpointContent({embedded:true,bottomClearance:this.mainContentBottomPadding(),topClearance:this.contentTopGap(),initialPalette:this.palette(),initialCoordinator:this.coordinator,foreground:this.uiForeground})
        else if (this.page === 'dns-query') Scroll() { Column({space:16}) {
          Blank().height(this.contentTopGap())
          TextInput({text:this.host,placeholder:'域名'}).onChange((value:string)=>{this.host=value})
          Button('查询').onClick(async()=>{
            try{const result:connection.NetAddress[]=await connection.getAddressesByName(this.host.trim());this.toolResult=result.map((item:connection.NetAddress)=>item.address).join('\n')}
            catch(_){this.toolResult='查询失败'}
          })
          Text(this.toolResult).fontColor(this.palette().textPrimary).copyOption(CopyOptions.InApp)
          Blank().height(this.mainContentBottomPadding())
        }.width('100%').padding(16) }.width('100%').layoutWeight(1).align(Alignment.Top)
        else if (this.tab === 'log') this.logsPage()
        else if (this.tab === 'tools') this.toolsPage()
        else if (this.tab === 'settings') this.settingsPage()
        else this.dashboard()
      }.width('100%').height('100%')

      if (!(this.ready && this.tab === 'log' && this.page === '') || (this.tab === 'log' && this.page === '' && this.logScrolled && this.logReturning)) {
        Stack({alignContent:Alignment.TopStart}) {
          Column() {
            Blank().height(this.topInset())
            this.appToolbar()
          }.width('100%').height(this.topInset() + 64)
        }.width('100%').height(this.topInset() + 64).position({ x: 0, y: 0 })
          .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP])
      }


      if (this.ready) {
        Column({ space: 0 }) {
          if (this.phase === 'running') {
            Stack({ alignContent: Alignment.TopStart }) {
              this.glassBackdrop(this.runningBarSize(56), true)
              Row({ space: this.runningBarSize(10) }) {
              Text(this.recovering ? '恢复中…' : (this.suspended ? '挂起中…' : '已启动')).fontSize(this.runningBarSize(16)).fontColor((this.palette() === DARK_PALETTE ? '#FFFFFF' : '#101018')).layoutWeight(1)
              Row({ space: this.runningBarSize(4) }) { Text(this.connectionCount.toString()).fontSize(this.runningBarSize(14)); this.icon('connections', this.runningBarSize(18)) }
                .padding(this.runningBarSize(10)).borderRadius(this.runningBarSize(10)).backgroundColor(this.dockAccent())
                .onClick(() => { this.page = 'connections' }).accessibilityText('打开连接列表')
              Button() {
                Row({ space: this.runningBarSize(4) }) { Text(this.groups.length.toString()).fontSize(this.runningBarSize(14)).fontColor((this.palette() === DARK_PALETTE ? '#FFFFFF' : '#101018')); this.icon('folder', this.runningBarSize(18)) }
              }.height(this.runningBarSize(36)).borderRadius(this.runningBarSize(10)).backgroundColor(this.dockAccent()).accessibilityText('代理组')
                .onClick(() => this.openGroups())
                .bindSheet($$this.showGroups, this.groupsPage(), {
                  height: '100%', showClose: false, dragBar: true,
                  backgroundColor: this.reduceTransparency ? this.palette().surface : (this.palette() === DARK_PALETTE ? '#661C1D21' : '#66F5F3FA'),
                  blurStyle: this.reduceTransparency ? BlurStyle.NONE : BlurStyle.COMPONENT_THICK
                })

              Button(this.elapsed() + ' ■').fontSize(this.runningBarSize(14)).height(this.runningBarSize(36)).borderRadius(this.runningBarSize(10))
                .fontColor((this.palette() === DARK_PALETTE ? '#FFFFFF' : '#101018')).backgroundColor(this.dockAccent())
                .onClick(() => this.toggleService()).accessibilityText('停止')
              }.width('100%').height(this.runningBarSize(56)).padding({ left: this.runningBarSize(16), right: this.runningBarSize(16) })
            }.width('84%').height(this.runningBarSize(56)).borderRadius(this.runningBarSize(28)).clip(true)
          } else {
          Row() {
            Blank()
            Button() { this.icon(this.phase === 'running' ? 'stop' : 'play', this.dockSize(24)) }
              .width(this.dockSize(56)).height(this.dockSize(56)).borderRadius(this.dockSize(16))
              .backgroundColor(this.dockAccent())
              .shadow({ radius: this.dockSize(8), color: this.palette().shadow, offsetY: this.dockSize(4) })
              .enabled(!this.busy || this.phase === 'running')
              .accessibilityText(this.phase === 'running' ? '停止' : '启动')
              .onClick(() => this.toggleService())
          }.width('100%').padding({ right: this.dockSize(16), bottom: this.dockSize(16) })
          }
          this.navigationBar()
        }.width('80%').padding({ left: this.dockSize(12), right: this.dockSize(12) })
      }

    }.width('100%').height('100%').backgroundColor(this.backgroundStop(this.palette().background))
      .onAreaChange((_old:Area,area:Area)=>{this.viewportHeight=Number(area.height);this.viewportWidth=Number(area.width)})
      .linearGradient({ angle: 155, colors: [
        [this.backgroundStop(this.palette().background), 0.0],
        [this.backgroundStop(this.palette().backgroundGlow), 0.45],
        [this.backgroundStop(this.palette().backgroundGlowSecondary), 0.75],
        [this.backgroundStop(this.palette().background), 1.0]] })
      .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
      .bindSheet($$this.sheetVisible, this.mainSheet(), { height: SheetSize.FIT_CONTENT, dragBar: true, showClose: false,
        backgroundColor: this.reduceTransparency ? this.palette().surface : (this.palette() === DARK_PALETTE ? '#261C1D21' : '#18F5F3FA'),
        blurStyle: this.reduceTransparency ? BlurStyle.NONE : BlurStyle.COMPONENT_ULTRA_THIN })

  }
}
