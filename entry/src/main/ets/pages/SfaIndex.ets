import { uiMaterial } from '@kit.ArkUI'
import { deviceInfo } from '@kit.BasicServicesKit'
import { CommonModifier } from '@ohos.arkui.modifier'
import { cleanLogLine, logBody } from '../domain/LogPresentation'
import type { VpnApplicationScope } from '../domain/NetworkSettings'
import { NAVIGATION_TABS, navigationIndex, navigationGlowX } from '../domain/NavigationDrag'
import { SubscriptionUsage, parseSubscriptionUsage, usageLabel, usageProgress, usageRemaining, usageExpiry } from '../domain/SubscriptionUsage'
import { responseHeaderValue } from '../domain/SubscriptionHeaders'
import { SubscriptionInfo, subscriptionInfoFromJson, subscriptionInfoFromNames } from '../domain/SubscriptionInfo'
import { physicalProbeDns } from '../services/PhysicalNetwork'
import { APP_VERSION, CORE_VERSION, coreIsPrerelease, RELEASES_URL } from '../domain/BuildInfo'
import { checkAppUpdate } from '../services/AppUpdateService'
import { SavedUiSettings, parseSavedUiSettings } from '../domain/SavedUiSettings'
import { dashboardModes } from '../domain/RuntimeModes'
import { QuickCatalog, QuickNode, QuickSubscription, emptyQuickCatalog, importQuickNodes, quickNode, builtinProfile, withBuiltinProfiles, buildNodeTestConfig } from '../domain/QuickStart'
import { nodeProbeErrorLabel, nodeProbeErrorCode } from '../domain/NodeProbeDiagnostic'
import { NodeProbeService } from '../services/NodeProbeService'
import { NodeDraft, emptyNodeDraft, draftFromNode, draftNodeUri } from '../domain/NodeDraft'
import { QuickStartStore } from '../services/QuickStartStore'
import { installBuiltinRules } from '../services/BuiltinRules'
import { pasteboard } from '@kit.BasicServicesKit'
import { UiActivityLease } from '../domain/RuntimeActivity'
import { webview } from '@kit.ArkWeb'
import { window } from '@kit.ArkUI'
import { scanBarcode, scanCore, generateBarcode } from '@kit.ScanKit'
import { image } from '@kit.ImageKit'
import { fileIo, fileUri } from '@kit.CoreFileKit'
import { wifiManager } from '@kit.ConnectivityKit'
import { ScannedProfile, parseProfileQr } from '../domain/ProfileQr'
import { SsidPolicy, SsidAction, normalizeSsidPolicy, withSsidRule } from '../domain/SsidPolicy'
import { invertApplicationSelection, perAppScope } from '../domain/PerAppPolicy'
import { writeAtomicText } from '../services/AtomicFileWriter'
import { trafficRates, TrafficSample, TrafficRates, delayColor } from '../domain/RuntimeTelemetry'
import { systemShare } from '@kit.ShareKit'
import { bundleManager, common } from '@kit.AbilityKit'
import { preferences } from '@kit.ArkData'
import { http, connection } from '@kit.NetworkKit'
import { picker } from '@kit.CoreFileKit'
import { hilog } from '@kit.PerformanceAnalysisKit'
import type { CoreStatus } from '../core/CoreGateway'
import { ProfileNode, profileNodes, editProfileNode, copyProfileNode, standaloneProfileNode, sameProfileNode } from '../domain/ProfileNodes'
import { DrawerMenu, drawerRoot, drawerParent, drawerMenus } from '../domain/DrawerRoutes'
import { BackgroundSwatch, BACKGROUND_SWATCHES, normalizeBackgroundColor, backgroundColorIsDark, validBackgroundImageName } from '../domain/BackgroundAppearance'
import { ConnectionCoordinator } from '../services/ConnectionCoordinator'
import { SfaProfileStore } from '../services/SfaProfileStore'
import { readLocalDocument } from '../services/LocalDocumentReader'
import { LocalConfigStore } from '../services/LocalConfigStore'
import { prepareLocalConfig } from '../domain/LocalConfig'
import { configIpv6Enabled } from '../domain/Ipv6Policy'
import { RuleSetUpdate, updateBuiltinRules } from '../services/BuiltinRuleUpdater'
import { nodeUrisFromSingBox } from '../domain/SingBoxImport'
import { SfaCatalog, SfaProfile, emptySfaCatalog, saveSfaProfile, deleteSfaProfile, validateSfaContent, mergeRetainedProfileNodes } from '../domain/SfaProfiles'
import { ApplicationCatalogResult, ApplicationCatalogService, SelectableApplication } from '../services/ApplicationCatalogService'
import { NetworkSettings, defaultNetworkSettings, vpnApplicationScope, normalizeVpnApplicationScope, validateApplicationBundleName } from '../domain/NetworkSettings'
import { DARK_PALETTE, LIGHT_PALETTE, AppPalette } from '../ui/DesignSystem'
import { HttpsUrlGuard } from '../services/SubscriptionService'
import { TailscaleEndpointContent } from './TailscaleEndpointPage'
import type { TailscaleStatusUpdate, TailscaleEndpointStatus } from '../domain/TailscaleTypes'

interface CodedFailure { code?: number }
interface CachedProfileNodes { content: string; nodes: ProfileNode[] }
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
  @State baseExpanded: boolean = false
  @State expandedProfileNodes: string[] = []
  @State profileNodeJson: string = ''
  @State profileNodeSourceId: string = ''
  @State profileNodeTag: string = ''
  @State nodeDropTarget: string = ''
  @State reorderId: string = ''
  @State nodeCopyVisible: boolean = false
  @State nodeCopySourceId: string = ''
  @State nodeCopyTag: string = ''
  @State nodeCopyHover: string = ''
  @State configNodeSelectionSource: string = ''
  @State configNodeSelection: string[] = []
  private nodeCopyTags: string[] = []
  private draggedConfigId: string = ''
  private copyingNodeBatch: boolean = false
  private nodeCopyCancelled: boolean = false
  @State nodeEnteredTarget: string = ''
  private profileNodeOriginalContent: string = ''
  private draggedProfileId: string = ''
  private draggedNodeTag: string = ''
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
  private profileNodeCache: Map<string,CachedProfileNodes> = new Map()
  @State updateChecking: boolean = false
  @State showAddProfile: boolean = false
  @State quick: QuickCatalog = emptyQuickCatalog()
  @State importText: string = ''
  @State nodeQuery: string = ''
  @State selectedNodeIds: string[] = []
  @State selectedProfileIds: string[] = []
  @State rulesUpdatedAt: number = 0
  @State baseMode: string = 'mainland'
  @State urlDraft: string = ''
  @State showUrlImport: boolean = false
  @State nodeDraft: NodeDraft = emptyNodeDraft()
  @State editingNodeId: string = ''
  @State editingNodeUri: string = ''
  @State rawNodeEditor: boolean = false
  @State showNodeShare: boolean = false
  @State sharedNodeUri: string = ''
  private quickStore: QuickStartStore | null = null
  private builtinRulesDir: string = ''
  private nodeSummaryCache: Map<string, string[]> = new Map()
  @State nodeDelays: Map<string, number> = new Map()
  private webRtcController: webview.WebviewController = new webview.WebviewController()
  private nodeTestTimer: number = 0
  private nodeTestGeneration: number = 0
  private nodeProbe: NodeProbeService | null = null
  @State nodeErrors: Map<string, string> = new Map()
  @State nodeTesting: boolean = false
  @State nodeTestProgress: string = ''
  private activeConfig: string = ''
  private upgraded: boolean = false
  private vpnIntent: boolean = false
  private ruleUpdateRunning: boolean = false
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
  @State tab: string = 'dashboard'
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
  private quickUsageAttempts: Map<string, number> = new Map()
  private usageRefreshing: boolean = false
  private usageAttemptAt: number = 0
  private usageAttemptProfile: string = ''
  private subscriptionInfoCache: Map<string, SubscriptionInfo> = new Map()
  private glassModifierCache: Map<string, CommonModifier> = new Map()
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
  private polling: boolean = false
  private previousAt: number = 0
  private previousUpload: number = 0
  private previousDownload: number = 0
  private commandEpoch: number = 0

  aboutToAppear(): void {
    hilog.info(0, 'SfaUI', 'Constructed page without loading the native core')
    this.pageAlive = true
    this.initialize()
  }

  aboutToDisappear(): void {
    this.stopNavSheen()
    this.pageAlive = false
    this.publishUiActivity(false)
    this.stopNodeTests()
    if (this.timer !== 0) clearInterval(this.timer)
    this.timer = 0
    // The VPN extension retains ownership. Closing this page never disconnects.
  }

  private publishUiActivity(foreground: boolean): void {
    if (!this.leasePath) return
    const lease: UiActivityLease = { foreground: foreground, updatedAt: Date.now() }
    this.leaseWrittenAt = lease.updatedAt
    const path: string = this.leasePath
    this.leaseQueue = this.leaseQueue.then(() => writeAtomicText(path, JSON.stringify(lease))).catch(() => {})
  }

  private onUiForegroundChanged(): void {
    if (this.timer !== 0) clearInterval(this.timer)
    this.timer = 0
    const active: boolean = this.uiForeground && this.pageAlive
    if (active) this.startNavSheen()
    else this.stopNavSheen()
    this.publishUiActivity(active)
    if (!active) this.stopNodeTests()
    else if (this.page === 'nodes') this.startNodeTests()
    if (active && this.ready) {
      this.poll()
      this.timer = setInterval(() => this.poll(), 1000)
    } else {
      // Keep the last bounded page snapshot for instant foreground restoration.
      // Only the sampling baseline expires; no background UI work continues.
      this.trafficSample = null
    }
  }

  onBackPress(): boolean {
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
      this.rulesUpdatedAt = this.prefs.getSync('rules-updated-at', 0) as number
      this.baseMode = this.prefs.getSync('base-mode', 'mainland') as string
      this.vpnIntent = this.prefs.getSync('vpn-active', false) as boolean
      let version: string = ''
      try {
        version = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT).versionName
      } catch (_) { version = '' }
      const lastVersion: string = this.prefs.getSync('last-version', '') as string
      this.upgraded = lastVersion.length > 0 && version.length > 0 && lastVersion !== version
      if (version.length > 0) { this.prefs.putSync('last-version', version); await this.prefs.flush() }
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
      this.quickStore = new QuickStartStore(this.context().filesDir)
      stage = '读取加密节点目录'
      this.quick = await this.quickStore.load()
      stage = '安装内置规则'
      this.builtinRulesDir = await installBuiltinRules(this.context())
      stage = '保存加密配置'
      await this.persist(withBuiltinProfiles(this.catalog, this.quick, this.builtinRulesDir, this.baseMode))
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
      if (this.upgraded) setTimeout(() => { this.handleUpgradeRestart().catch(() => {}) }, 1500)
    }
  }

  // An in-place upgrade kills the running VPN extension process, which leaves
  // the system VPN without a heartbeat. Restore the session the user had.
  private async handleUpgradeRestart(): Promise<void> {
    const interrupted: boolean = this.message.includes('心跳已中断')
    if (!this.coordinator || (!this.vpnIntent && !interrupted)) { this.upgraded = false; return }
    this.upgraded = false
    this.toast('检测到应用升级，正在重新建立 VPN')
    this.busy = true
    try {
      try { this.applyStatus(await this.coordinator.disconnect()) } catch (_) { }
      const profile: SfaProfile | undefined = this.selectedProfile()
      if (!profile) return
      const config: string = this.runtimeConfig(profile)
      this.applyStatus(await this.connectProfile(config, vpnApplicationScope(this.networkSettings), profile.id))
      this.activeConfig = config
      this.toast('VPN 已重新建立')
    } catch (failure) {
      this.toast(failure instanceof Error ? failure.message : '升级后重建 VPN 失败，请手动连接')
    } finally { this.busy = false }
  }

  private async poll(): Promise<void> {
    if (!this.uiForeground || !this.pageAlive || this.polling || !this.coordinator || this.busy) return
    if (Date.now() - this.leaseWrittenAt >= 10000) this.publishUiActivity(true)
    this.polling = true
    try {
      const status: CoreStatus = await this.coordinator.getStatus()
      this.applyStatus(status)
      this.refreshSubscriptionUsage().catch(() => {})
      // 刷新 Tailscale 端点列表（用于工具页面的端点入口显示）
      try {
        const tsStatus = await this.coordinator.tailscaleStatus()
        this.tailscaleEndpoints = tsStatus.endpoints ?? []
      } catch (_) { /* Tailscale 状态获取失败不影响主流程 */ }
    } catch (failure) {
      this.message = failure instanceof Error ? failure.message : '服务状态暂不可读，正在确认'
      // Keep the last valid page state while checking a delayed heartbeat.
      const profile: SfaProfile | undefined = this.selectedProfile()
      if (profile && this.coordinator && Date.now() - this.lastOrphanRecoveryAt >= 60000) {
        this.lastOrphanRecoveryAt = Date.now()
        this.busy = true
        try {
          if (await this.coordinator.recoverOrphanedSession(profile.id)) {
            this.message = 'VPN 已失效，正在重新建立连接'
            const config: string = this.runtimeConfig(profile)
            this.applyStatus(await this.connectProfile(config, vpnApplicationScope(this.networkSettings), profile.id))
          }
        } catch (recoveryFailure) {
          this.message = recoveryFailure instanceof Error ? recoveryFailure.message : '自动恢复未完成，请安全停止后重试'
        } finally { this.busy = false }
      }
    } finally { this.polling = false }
  }

  private applyStatus(status: CoreStatus): void {
    const now: number = Date.now()
    this.clockMillis = now
    this.upload = status.uploadBytes
    this.download = status.downloadBytes
    this.connectionCount = status.activeConnections
    this.phase = status.lastError.length > 0 ? 'error' : (status.running ? 'running' : 'stopped')
    if (status.running !== this.vpnIntent && this.prefs) {
      this.vpnIntent = status.running
      this.prefs.putSync('vpn-active', status.running)
      this.prefs.flush().catch(() => {})
    }
    this.recovering = (status.stage || '').startsWith('recover')
    this.message = status.lastError || (this.recovering ? '正在自动恢复 VPN 连接' : (status.running ? '已启动' : '已停止'))
    if (status.running && this.startedAt === 0) this.startedAt = now
    if (!status.running) this.startedAt = 0
    if (status.snapshotJson) {
      try {
        const snapshot: RuntimeSnapshot = JSON.parse(status.snapshotJson) as RuntimeSnapshot
        this.suspended = snapshot.suspended === true
        if (this.recovering && this.nodeProbe !== null) this.stopNodeTests()
        if (this.suspended) { this.uploadRate = 0; this.downloadRate = 0 }
        if (snapshot.groups) {
          this.groups = snapshot.groups.group || []
          this.refreshGroupSubscriptionInfo(this.groups, now, status.sessionId || '')
        }
        this.liveConnections = (snapshot.connections || []).sort((a: LiveConnection, b: LiveConnection): number => a.id.localeCompare(b.id))
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
        if (snapshot.mode) this.mode = snapshot.mode
        if (snapshot.modes) this.modes = dashboardModes(snapshot.modes, this.mode)
      } catch (_) { this.message = '运行数据格式错误' }
    }
    if (!status.running) {
      this.groupSubscriptionRemaining = ''; this.groupSubscriptionExpiry = ''
      this.groupSubscriptionProfile = ''; this.groupSubscriptionRefreshedAt = 0
      this.liveConnections = []; this.groups = []; this.modes = []; this.mode = ''; this.trafficSample = null
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
    if (!this.uiForeground || !this.pageAlive || this.suspended || !this.coordinator || this.groupTestBusy || this.phase !== 'running') return
    this.groupTestBusy = true; this.testingGroup = tag || '*'; this.lastGroupTestAt = Date.now()
    try {
      for (const group of this.groups) {
        if (!this.uiForeground || !this.pageAlive || this.suspended) break
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

  private async persist(catalog: SfaCatalog): Promise<void> {
    if (!this.store) throw new Error('配置存储尚未就绪')
    await this.store.save(catalog)
    this.subscriptionInfoCache.clear()
    this.groupSubscriptionRemaining = ''; this.groupSubscriptionExpiry = ''
    this.groupSubscriptionProfile = ''; this.groupSubscriptionRefreshedAt = 0
    this.catalog = catalog
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
        this.maybeAutoUpdateRules()
      }
    } catch (failure) {
      this.phase = 'error'; this.message = failure instanceof Error ? failure.message : '启动失败'
      this.toast(this.message)
    } finally { this.busy = false }
  }

  private async connectProfile(config: string, scope: VpnApplicationScope, profileId: string): Promise<CoreStatus> {
    if (!this.coordinator) throw new Error('连接服务尚未就绪')
    const status: CoreStatus = await this.coordinator.connect(config, scope, profileId)
    if (status.sessionId && status.running) { this.runtimeProfileSessions.clear(); this.runtimeProfileSessions.set(status.sessionId, profileId) }
    return status
  }

  private async selectProfile(id: string): Promise<void> {
    if (this.busy || id === this.catalog.selectedId) return
    const wasRunning: boolean = this.phase === 'running'
    const epoch: number = ++this.commandEpoch
    const previous: SfaCatalog = this.catalog
    this.busy = true
    try {
      if (wasRunning && this.coordinator) {
        this.phase = 'stopping'; this.message = '正在切换配置'
        this.applyStatus(await this.coordinator.disconnect())
      }
      await this.persist({ version: 1, profiles: this.catalog.profiles, selectedId: id })
      const profile: SfaProfile | undefined = this.selectedProfile()
      if (wasRunning && this.coordinator && profile && epoch === this.commandEpoch) {
        this.phase = 'starting'
        const config: string = this.runtimeConfig(profile)
        this.applyStatus(await this.connectProfile(config, vpnApplicationScope(this.networkSettings), profile.id))
        this.activeConfig = config
        this.maybeAutoUpdateRules()
      }
    } catch (failure) {
      this.phase = 'error'; this.message = failure instanceof Error ? failure.message : '配置切换失败'
      if (this.catalog.selectedId === previous.selectedId) this.catalog = previous
      this.toast(this.message)
    } finally { this.busy = false }
  }

  private editProfile(profile?: SfaProfile): void {
    if (profile && builtinProfile(profile.id)) { this.page = 'nodes'; return }
    this.editorError = ''
    this.editingId = profile?.id || ''
    this.draftName = profile?.name || ''
    this.draftKind = profile?.kind || 'local'
    this.draftUrl = profile?.url || ''
    this.draftContent = profile?.content || ''
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

  private async saveEditor(): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.editorError = ''
    let stage: string = this.draftKind === 'remote' ? '下载配置' : '读取配置'
    try {
      const original: SfaProfile | undefined = this.catalog.profiles.find((item: SfaProfile) => item.id === this.editingId)
      const modified: boolean = original !== undefined && this.draftContent !== original.content
      const edited: boolean = original !== undefined && (modified || this.draftName.trim() !== original.name || this.draftKind !== original.kind || this.draftUrl.trim() !== original.url)
      let saveCopy: boolean = false
      if (edited) {
        validateSfaContent(this.draftContent)
        const result = await this.getUIContext().getPromptAction().showDialog({
          title: '如何保存配置？', message: '覆盖原配置后，远程订阅更新会覆盖本次修改；另存为本地配置可独立保留。',
          buttons: [{ text: '继续编辑', color: this.palette().textSecondary }, { text: '覆盖原配置', color: this.palette().danger }, { text: '另存配置', color: this.palette().accent }]
        })
        if (result.index === 0) return
        saveCopy = result.index === 2
      }
      const restart: boolean = !saveCopy && this.editingId.length > 0 && this.editingId === this.catalog.selectedId && this.phase === 'running'
      let downloadedUsage: SubscriptionUsage | undefined = undefined
      const content: string = this.draftKind === 'remote' && !saveCopy && (!original || this.draftUrl.trim() !== original.url) ? await this.downloadRaw(this.draftUrl, true, (usage: SubscriptionUsage | undefined) => { downloadedUsage = usage }) : this.draftContent
      stage = '校验配置 JSON'
      validateSfaContent(content)
      const baseName: string = (this.draftName.trim() || '未命名配置') + (saveCopy ? '（本地修改）' : '')
      let profileName: string = baseName; let suffix: number = 2
      while(this.catalog.profiles.some((item:SfaProfile)=>item.name===profileName&&(saveCopy||item.id!==this.editingId)))profileName=baseName+' '+suffix++
      const profile: SfaProfile = { id: saveCopy ? `profile-${Date.now()}` : this.editingId || `profile-${Date.now()}`, name: profileName,
        kind: saveCopy ? 'local' : this.draftKind, url: !saveCopy && this.draftKind === 'remote' ? this.draftUrl.trim() : '', content: content, updatedAt: Date.now(),
        usage: !saveCopy && this.draftKind === 'remote' ? (downloadedUsage || (original?.url === this.draftUrl.trim() ? original?.usage : undefined)) : undefined,
        retainedNodeTags: !saveCopy ? original?.retainedNodeTags : undefined,
        localNodeEdits: !saveCopy && this.draftKind === 'remote' && (modified || original?.localNodeEdits === true) }
      stage = '保存加密配置'
      await this.persist(saveSfaProfile(this.catalog, profile))
      if (restart && this.coordinator) {
        this.phase = 'stopping'
        this.applyStatus(await this.coordinator.disconnect())
        this.phase = 'starting'
        this.applyStatus(await this.connectProfile(this.runtimeConfig(profile), vpnApplicationScope(this.networkSettings), profile.id))
      }
      this.page = 'profiles'; this.toast(saveCopy ? '已另存本地配置，原配置及当前连接保持不变' : '配置已保存')
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

  private async updateProfile(profile: SfaProfile): Promise<void> {
    if (this.busy || profile.kind !== 'remote') return
    const decision = await this.getUIContext().getPromptAction().showDialog({title:'更新配置的覆盖方式',
      message:'更新远端配置；已选择“更新时保留”的新增节点不受影响。可以先另存当前配置再更新。',
      buttons:[{text:'取消',color:this.palette().textSecondary},{text:'更新并覆盖',color:this.palette().danger},{text:'先另存再更新',color:this.palette().accent}]})
    if (decision.index === 0 || this.busy) return
    this.busy = true
    try {
      let downloadedUsage: SubscriptionUsage | undefined = undefined
      const content: string = await this.downloadRaw(profile.url, true, (usage: SubscriptionUsage | undefined) => { downloadedUsage = usage })
      if(this.catalog.profiles.find((item:SfaProfile)=>item.id===profile.id)?.content!==profile.content)throw new Error('配置已变化，请重新确认更新')
      let next:SfaCatalog=this.catalog
      if(decision.index===2){
        const base:string=profile.name+'（更新前）';let name:string=base;let suffix:number=2
        while(next.profiles.some((item:SfaProfile)=>item.name===name))name=base+' '+suffix++
        next=saveSfaProfile(next,{id:'snapshot-'+Date.now(),name:name,kind:'local',url:'',content:profile.content,updatedAt:Date.now()})
      }
      await this.persist(saveSfaProfile(next, { id: profile.id, name: profile.name, kind: profile.kind,
        url: profile.url, content: mergeRetainedProfileNodes(profile, content), retainedNodeTags: profile.retainedNodeTags,
        updatedAt: Date.now(), usage: downloadedUsage || profile.usage }))
      this.toast('配置已更新；运行中的服务继续使用原配置，重启后应用')
    } catch (failure) { this.toast(failure instanceof Error ? failure.message : '更新失败') }
    finally { this.busy = false }
  }

  private removeProfile(profile: SfaProfile): void {
    if (builtinProfile(profile.id)) { this.toast('内置基础配置不能删除'); return }
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
    if (this.page === 'profile-node-editor') return '编辑节点'
    if (this.page === 'add-profile') return '添加配置'
    if (this.page === 'url-import') return 'URL 导入'
    if (this.page === 'tailscale') return 'Tailscale'
    if (this.page === 'dns-query') return 'DNS 查询'
    if (this.page === 'sources') return '开源项目与源码地址'
    if (this.page === 'ssid') return '按需连接'
    if (this.page === 'connections') return '连接'
    if (this.page === 'applications') return '分应用代理'
    if (this.page === 'profiles') return '配置'
    if (this.page === 'json-editor') return '配置 JSON'
    if (this.page === 'editor') return this.editingId ? '编辑配置' : '新建配置'
    if (this.page === 'nodes') return '节点导入'
    if (this.page === 'import') return '导入节点'
    if (this.page === 'node-editor') return this.editingNodeId ? '编辑节点' : '新建节点'
    if (this.page === 'presets') return '基础配置'
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
    Stack() {
      this.glassBackdrop(64, false, false)
    Row({ space: 12 }) {
      if (this.page.length > 0) {
        Button('‹').fontSize(30).width(44).height(44).backgroundColor(Color.Transparent)
          .fontColor(this.palette().textPrimary).onClick(() => this.backFromPage())
      }
      Text(this.title()).fontSize(22).fontWeight(FontWeight.Normal).fontColor(this.palette().textPrimary)
        .layoutWeight(1).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
      if (this.page === 'applications') {
        Button('⌕').width(40).height(44).fontSize(26).backgroundColor(Color.Transparent).fontColor(this.palette().textPrimary)
          .onClick(() => { this.applicationSearchVisible = !this.applicationSearchVisible })
        Button('⋮').width(40).height(44).fontSize(25).backgroundColor(Color.Transparent).fontColor(this.palette().textPrimary)
          .bindMenu([
            { value: '全选', action: () => this.selectVisibleApplications(false) },
            { value: '反选', action: () => this.selectVisibleApplications(true) },
            { value: '显示 / 隐藏系统应用', action: () => { this.showSystemApplications = !this.showSystemApplications; this.saveUiSettings() } },
            { value: '刷新应用列表', action: () => this.loadApplications() },
            { value: '导入包名名单', action: () => this.importApplications() }
          ])
      } else if (this.page === 'nodes') {
        Button('+').width(48).height(48).fontSize(28).backgroundColor(Color.Transparent)
          .fontColor(this.palette().textPrimary).onClick(() => { this.page = 'import' })
      } else if (this.page === 'node-editor') {
        Button('保存').fontSize(14).backgroundColor(Color.Transparent).fontColor(this.palette().accent)
          .enabled(!this.busy).onClick(() => this.saveNode())
      } else if (this.page === 'profiles') {
        Button('+').width(48).height(48).fontSize(28).backgroundColor(Color.Transparent)
          .fontColor(this.palette().textPrimary).onClick(() => { this.page = 'add-profile' })
      } else if (this.page === 'json-editor') {
        Button('完成').fontSize(14).backgroundColor(Color.Transparent).fontColor(this.palette().accent)
          .onClick(() => { this.page = 'editor' })
      } else if (this.page === 'editor') {
        Button('保存').fontSize(14).backgroundColor(Color.Transparent).fontColor(this.palette().accent)
          .enabled(!this.busy).onClick(() => this.saveEditor())
      } else if (this.tab === 'dashboard' && this.page === '') {
        Button('⋮').width(44).height(44).fontSize(26).backgroundColor(Color.Transparent)
          .fontColor(this.palette().textPrimary).onClick(() => { this.page = 'cards' })
      } else if (this.tab === 'log' && this.page === '') {
        Button('清空').fontSize(14).backgroundColor(Color.Transparent).fontColor(this.palette().accent)
          .enabled(this.phase === 'running' && !this.busy).onClick(() => this.control({ action: 'clear-logs' }))
      }
    }.width('100%').height(64).padding({ left: this.page.length > 0 ? 8 : 16, right: inDrawer ? 68 : 12 })
    }.width('100%').height(64)
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

  private shareConfigNodeEntry(profile: SfaProfile, node: ProfileNode): void {
    let link: string = ''
    try {
      const uris: string[] = nodeUrisFromSingBox(JSON.stringify({ outbounds: [JSON.parse(node.json) as Object] }))
      link = uris.length > 0 ? uris[0] : ''
    } catch (_) { link = '' }
    if (!link) { this.toast('此节点无法生成分享链接'); return }
    this.presentShare(node.tag, link)
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
    Column({ space: 14 }) {
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
      Column() { Text('节点').fontSize(13).fontColor(Color.White) }
        .width(72).height('100%').justifyContent(FlexAlign.Center).backgroundColor('#4C8DFF').borderRadius(12)
        .margin({ left: 6 }).onClick(() => { this.toggleProfileNodes(profile.id) })
      Column() { Text('分享').fontSize(13).fontColor(Color.White) }
        .width(72).height('100%').justifyContent(FlexAlign.Center).backgroundColor('#6B7A8F').borderRadius(12)
        .margin({ left: 6 }).onClick(() => { this.shareProfileEntry(profile) })
    }
  }

  @Builder
  nodeStartActions(profile: SfaProfile, node: ProfileNode) {
    Column() { Text('分享').fontSize(13).fontColor(Color.White) }
      .width(72).height('100%').justifyContent(FlexAlign.Center).backgroundColor('#6B7A8F').borderRadius(12)
      .onClick(() => { this.shareConfigNodeEntry(profile, node) })
  }

  @Builder
  configNodeRow(profile: SfaProfile, node: ProfileNode) {
    Row({ space: 10 }) {
      Text('⠿').fontSize(22).fontColor(this.palette().textSecondary)
        .draggable(true)
        .onDragStart(() => { this.openNodeCopy(profile, node); return { extraInfo: '复制节点' } })
        .accessibilityText('拖动节点到配置')
      if (this.configNodeSelectionSource === profile.id && this.configNodeSelection.length > 0) {
        Text(this.configNodeSelection.includes(node.tag) ? '✓' : '○').fontSize(18).fontColor(this.palette().accent)
      }
      Column({ space: 3 }) {
        Text(node.tag).fontSize(14).fontColor(this.palette().textPrimary).maxLines(2)
        Text(node.type).fontSize(11).fontColor(this.palette().textSecondary)
      }.layoutWeight(1).alignItems(HorizontalAlign.Start)
      Button('编辑').height(34).fontSize(12).onClick(() => this.editConfigNode(profile, node))
      Button('分享').height(34).fontSize(12).backgroundColor(Color.Transparent).fontColor(this.palette().accent)
        .onClick(() => this.shareConfigNodeEntry(profile, node))
    }.width('100%').padding(12).backgroundColor(this.palette().surfaceMuted).borderRadius(10)
      .onClick(() => { if (this.configNodeSelection.length > 0) this.toggleConfigNodeSelection(profile.id, node.tag) })
      .gesture(LongPressGesture().onAction(() => this.toggleConfigNodeSelection(profile.id, node.tag)))
  }

  private async shareSelectedProfile(): Promise<void> {
    const profile: SfaProfile | undefined = this.selectedProfile()
    if (!profile) return
    this.shareProfileEntry(profile)
  }

  @Builder
  pickerEditAction(profile: SfaProfile) {
    Column() { Text('编辑').fontSize(14).fontColor(Color.White) }
      .width(72).height('100%').justifyContent(FlexAlign.Center).backgroundColor('#1E6FFF').borderRadius(12)
      .onClick(() => {
        this.sheetVisible = false
        if (profile.kind === 'builtin') this.page = 'nodes'
        else this.editProfile(profile)
      })
  }

  @Builder
  pickerDeleteAction(profile: SfaProfile) {
    if (profile.kind === 'builtin') {
      Column() { Text('内置').fontSize(13).fontColor(this.palette().textSecondary) }
        .width(72).height('100%').justifyContent(FlexAlign.Center)
        .backgroundColor(this.palette().surfaceMuted).borderRadius(12)
    } else {
      Column() { Text('删除').fontSize(14).fontColor(Color.White) }
        .width(72).height('100%').justifyContent(FlexAlign.Center).backgroundColor('#D93025').borderRadius(12)
        .onClick(() => { this.sheetVisible = false; this.removeProfile(profile) })
    }
  }

  @Builder
  profileDragHandle(profile: SfaProfile) {
    Text('⠿').fontSize(22).fontColor(this.palette().textSecondary).width(28).height(44)
      .draggable(true)
      .onDragStart(() => { this.draggedConfigId = profile.id; return { extraInfo: '调整配置顺序' } })
      .onDragEnd(() => { this.draggedConfigId = '' })
      .accessibilityText('上下拖动配置排序')
  }

  @Builder
  profilePicker() {
    Column({ space: 6 }) {
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
      List({ space: 6 }) {
        ForEach(this.catalog.profiles, (profile: SfaProfile) => {
          ListItem() {
            Row({ space: 12 }) {
              this.profileDragHandle(profile)
              if (this.selectedProfileIds.length > 0) {
                Text(this.selectedProfileIds.includes(profile.id) ? '✓' : '○').fontSize(18).fontColor(this.palette().accent)
              }
              this.icon('file', 24)
              Column({ space: 2 }) {
                Text(profile.name).fontSize(16).fontColor(this.palette().textPrimary).maxLines(1)
                Text(this.profileSubtitle(profile)).fontSize(12).fontColor(this.palette().textSecondary)
              }.layoutWeight(1).alignItems(HorizontalAlign.Start)
              if (this.selectedProfileIds.length === 0 && this.catalog.selectedId === profile.id) {
                Text('✓').fontSize(24).fontColor(this.palette().accent)
              }
            }.width('100%').height(56).padding({ left: 16, right: 12 }).borderRadius(12)
              .backgroundColor(this.catalog.selectedId === profile.id ? this.palette().surfaceMuted : this.palette().surfaceElevated)
              .onClick(() => {
                if (this.selectedProfileIds.length > 0) { this.toggleProfileSelection(profile.id); return }
                this.sheetVisible = false; this.selectProfile(profile.id)
              })
              .gesture(LongPressGesture().onAction(() => this.toggleProfileSelection(profile.id)))
              .onDrop(() => this.dropProfileOrder(profile.id))
          }.swipeAction({ start: this.pickerEditAction(profile), end: this.pickerDeleteAction(profile) })
        }, (profile: SfaProfile) => profile.id)
      }.nestedScroll({scrollForward:NestedScrollMode.PARENT_FIRST,scrollBackward:NestedScrollMode.SELF_FIRST}).width('100%').height(360)
    }.width('100%').padding({ left: 16, right: 16, bottom: 24 })
  }

  @Builder
  profilesCard() {
    Column() {
      Row({ space: 8 }) {
        this.icon('profiles', 20)
        Text('配置').fontSize(16).fontWeight(FontWeight.Bold).fontColor(this.palette().textPrimary).layoutWeight(1)
        Button('+').fontSize(24).width(44).height(44).borderRadius(12).backgroundColor(this.palette().surfaceMuted)
          .fontColor(this.palette().textSecondary).onClick(() => { this.openSheet('add') })
      }.width('100%').margin({ bottom: 12 })
      if (this.catalog.profiles.length === 0) {
        Text('没有配置').fontSize(14).fontColor(this.palette().textSecondary).padding({ top: 16, bottom: 16 })
          .width('100%').onClick(() => { this.openSheet('add') })
      } else {
        Row({ space: 12 }) {
          this.icon('file', 20)
          Text(this.selectedProfile()?.name || '选择配置').fontSize(16).fontColor(this.palette().textPrimary)
            .layoutWeight(1).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          this.icon('unfold', 20)
        }.width('100%').height(48).padding({ left: 16, right: 16 }).borderRadius(12)
          .backgroundColor(this.palette().surfaceMuted).onClick(() => { this.openSheet('picker') })
        Row({ space: 6 }) {
          this.icon(this.selectedProfile()?.kind === 'remote' ? 'cloud' : 'file', 14)
          Text(this.selectedProfile()?.kind === 'remote' ? '远程' : '本地').fontSize(12).fontColor(this.palette().textSecondary)
          if (this.selectedProfile()?.kind === 'remote') {
            this.icon('clock', 14)
            Text(this.profileAge(this.selectedProfile())).fontSize(12).fontColor(this.palette().textSecondary)
          }
        }.width('100%').height(18).margin({ top: 12, bottom: 8 })
        ForEach(this.catalog.profiles.filter((item: SfaProfile) => item.id === this.catalog.selectedId), (item: SfaProfile) => {
          this.subscriptionDetails(item)
        }, (item: SfaProfile) => item.id + '-' + item.updatedAt + '-' + (item.usage?.updatedAt || 0))
        if (this.selectedProfile()?.kind === 'remote' && this.hasSubscriptionTraffic(this.selectedProfile())) {
          Button('刷新流量').fontSize(12).height(30).backgroundColor(Color.Transparent).fontColor(this.palette().accent)
            .enabled(!this.busy).onClick(() => this.refreshSubscriptionUsage(true))
        }
        Row({ space: 12 }) {
          Button() { this.icon('edit', 20) }.width(44).height(44).borderRadius(12)
            .backgroundColor(this.palette().surfaceMuted).accessibilityText('编辑配置')
            .onClick(() => this.editProfile(this.selectedProfile()))
          if (this.selectedProfile()?.kind === 'remote') {
            Button() { this.icon('refresh', 20) }.width(44).height(44).borderRadius(12)
              .backgroundColor(this.palette().surfaceMuted).enabled(!this.busy).accessibilityText('更新配置')
              .onClick(() => { const profile: SfaProfile | undefined = this.selectedProfile(); if (profile) this.updateProfile(profile) })
          }
          Button() { this.icon('share', 20) }.width(44).height(44).borderRadius(12)
            .backgroundColor(this.palette().surfaceMuted).accessibilityText('分享配置')
            .onClick(() => this.shareSelectedProfile())
        }.width('100%')
        if (this.selectedProfile()?.kind === 'builtin' && this.quick.nodes.length === 0) {
          Text('尚未导入节点：请到 工具 → 基础配置 → 节点选择 添加，或导入你自己的配置。')
            .fontSize(13).fontColor(this.palette().danger).width('100%').margin({ top: 12 })
        }
      }
    }.width('100%').padding(16).backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass).borderRadius(12)
        .backgroundEffect({ radius: this.reduceTransparency ? 0 : 18, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
        .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#33FFFFFF' : '#99FFFFFF' })

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
                    .onClick(() => this.control({ action: 'mode', mode: mode }))
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

  private async refreshQuickUsage(): Promise<void> {
    const source: QuickSubscription | undefined = this.quick.subscriptions.find((item: QuickSubscription) =>
      Date.now() - (this.quickUsageAttempts.get(item.id) || 0) >= 300000)
    if (!source || this.usageRefreshing || this.busy || !this.uiForeground || !this.pageAlive) return
    this.quickUsageAttempts.set(source.id, Date.now()); this.usageRefreshing = true
    try {
      const usage: SubscriptionUsage | undefined = await this.downloadUsage(source.url)
      const current: QuickSubscription | undefined = this.quick.subscriptions.find((item: QuickSubscription) => item.id === source.id)
      if (usage === undefined || !current || current.url !== source.url || !this.quickStore || this.busy || !this.uiForeground || !this.pageAlive) return
      this.busy = true
      try {
        const updated: QuickSubscription = { id: current.id, name: current.name, url: current.url, updatedAt: current.updatedAt, usage: usage }
        const next: QuickCatalog = { version: 1, nodes: this.quick.nodes, subscriptions: this.quick.subscriptions.map((item: QuickSubscription) => item.id === updated.id ? updated : item) }
        // Metadata only: do not regenerate the base config or restart VPN.
        await this.quickStore.save(next)
        this.quick = next
      } finally { this.busy = false }
    } catch (_) { /* Keep the last account snapshot on a failed HEAD request. */ }
    finally { this.usageRefreshing = false }
  }

  private async refreshSubscriptionUsage(force: boolean = false): Promise<void> {
    const profile: SfaProfile | undefined = this.selectedProfile()
    if (!this.uiForeground || !this.pageAlive || this.busy || this.usageRefreshing || !profile) return
    if (profile.kind === 'builtin') { await this.refreshQuickUsage(); return }
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
    if (!profile || profile.kind === 'builtin') return { remaining: '', expiry: '' }
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
  nodeSubscriptionUsage(source: QuickSubscription) {
    if (usageLabel(source.usage)) {
    Column({ space: 5 }) {
      Text(source.name).fontSize(12).fontColor(this.palette().textSecondary).width('100%')
      Text(usageLabel(source.usage)).fontSize(13).fontColor(this.palette().textPrimary).width('100%')
      this.quotaMeter(source.usage)
      if (usageExpiry(source.usage)) Text(usageExpiry(source.usage)).fontSize(12).fontColor(this.palette().textSecondary)
    }.width('100%').alignItems(HorizontalAlign.Start).margin({ top: 6, bottom: 6 })
    }
  }

  @Builder
  subscriptionDetails(profile?: SfaProfile) {
    if (profile?.kind === 'builtin') {
      ForEach(this.quick.subscriptions, (source: QuickSubscription) => {
        this.nodeSubscriptionUsage(source)
      }, (source: QuickSubscription) => source.id + '-' + (source.usage?.updatedAt || 0))
    } else if (this.hasSubscriptionTraffic(profile)) {
      Column({ space: 5 }) {
        if (usageLabel(profile?.usage)) {
          Text(usageLabel(profile?.usage)).fontSize(13).fontColor(this.palette().textPrimary).width('100%')
        }
        this.quotaMeter(profile?.usage)
        if (this.subscriptionInformation(profile).remaining) {
          Text(this.subscriptionInformation(profile).remaining).fontSize(13).fontWeight(FontWeight.Medium).fontColor(this.palette().accent).width('100%')
        }
        if (this.subscriptionInformation(profile).expiry) {
          Text(this.subscriptionInformation(profile).expiry).fontSize(12).fontColor(this.palette().textSecondary).width('100%')
        }

      }.width('100%').alignItems(HorizontalAlign.Start).margin({ top: 8, bottom: 8 })
    }
  }

  private profileSubtitle(profile: SfaProfile): string {
    if (profile.kind === 'builtin') return `内置 · ${this.quick.nodes.length} 个节点`
    if (profile.kind === 'remote') return '远程 · ' + this.profileAge(profile)
    return '本地'
  }

  private toggleProfileSelection(id: string): void {
    this.selectedProfileIds = this.selectedProfileIds.includes(id)
      ? this.selectedProfileIds.filter((item: string) => item !== id)
      : [...this.selectedProfileIds, id]
  }

  private listedProfileNodes(profile: SfaProfile): ProfileNode[] {
    const cached:CachedProfileNodes|undefined=this.profileNodeCache.get(profile.id)
    if(cached&&cached.content===profile.content)return cached.nodes
    try {
      const nodes:ProfileNode[]=profileNodes(profile.content)
      if(this.profileNodeCache.size>=3)this.profileNodeCache.clear()
      this.profileNodeCache.set(profile.id,{content:profile.content,nodes:nodes})
      return nodes
    } catch (_) { return [] }
  }

  private toggleProfileNodes(id: string): void {
    this.expandedProfileNodes = this.expandedProfileNodes.includes(id)
      ? this.expandedProfileNodes.filter((item: string) => item !== id) : [...this.expandedProfileNodes,id]
  }

  private editConfigNode(profile: SfaProfile, node: ProfileNode): void {
    if (profile.kind === 'builtin') {
      const entry: QuickNode | undefined = this.quick.nodes.find((item: QuickNode) => node.tag.endsWith(' · ' + item.id))
      if (entry) { this.openNode(entry); return }
    }
    this.profileNodeSourceId = profile.id; this.profileNodeTag = node.tag
    this.profileNodeOriginalContent = profile.content; this.profileNodeJson = node.json
    this.page = 'profile-node-editor'
  }

  private async saveConfigNode(): Promise<void> {
    if (this.busy) return
    const original: SfaProfile | undefined = this.catalog.profiles.find((item: SfaProfile) => item.id === this.profileNodeSourceId)
    if (!original || original.content !== this.profileNodeOriginalContent) { this.toast('配置已更新，请重新展开节点编辑'); return }
    let ownsBusy: boolean = false
    try {
      const content: string = editProfileNode(original.content,this.profileNodeTag,this.profileNodeJson)
      const decision = await this.getUIContext().getPromptAction().showDialog({title:'如何保存节点？',
        message:'覆盖原节点后，配置或订阅更新会覆盖修改；另存为本地节点配置可独立保留。',
        buttons:[{text:'取消',color:this.palette().textSecondary},{text:'覆盖原节点',color:this.palette().danger},{text:'另存节点',color:this.palette().accent}]})
      if (decision.index === 0 || this.busy) return
      if (this.catalog.profiles.find((item: SfaProfile) => item.id === original.id)?.content !== original.content) throw new Error('配置已变化，请重新编辑')
      this.busy = true; ownsBusy = true
      if (decision.index === 2) {
        const base: string = this.profileNodeTag + '（本地节点）'
        let name: string = base; let suffix: number = 2
        while (this.catalog.profiles.some((item: SfaProfile) => item.name === name)) name = base + ' ' + suffix++
        await this.persist(saveSfaProfile(this.catalog,{id:'profile-node-' + Date.now(),name:name,kind:'local',url:'',content:standaloneProfileNode(content,this.profileNodeTag),updatedAt:Date.now()}))
      } else {
        await this.persist(saveSfaProfile(this.catalog,{id:original.id,name:original.name,kind:original.kind,url:original.url,usage:original.usage,content:content,retainedNodeTags:original.retainedNodeTags,updatedAt:Date.now(),localNodeEdits:original.kind === 'remote'}))
      }
      this.page = 'profiles'; this.toast('已保存，运行中的配置不受影响；重新启动后使用修改')
    } catch (failure) { this.toast(failure instanceof Error ? failure.message : '保存失败，原配置保留') }
    finally { if(ownsBusy)this.busy = false }
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

  private openNodeCopy(profile: SfaProfile, node: ProfileNode): void {
    if (this.busy || this.copyingNodeBatch) return
    this.nodeCopyTags = this.configNodeSelectionSource === profile.id && this.configNodeSelection.includes(node.tag)
      ? this.configNodeSelection.slice() : [node.tag]
    this.nodeCopySourceId = profile.id; this.nodeCopyTag = node.tag; this.nodeCopyHover = ''
    this.nodeCopyVisible = true
  }

  private toggleConfigNodeSelection(profileId: string, tag: string): void {
    if (this.configNodeSelectionSource !== profileId) this.configNodeSelection = []
    this.configNodeSelectionSource = profileId
    this.configNodeSelection = this.configNodeSelection.includes(tag)
      ? this.configNodeSelection.filter((item: string) => item !== tag) : [...this.configNodeSelection, tag]
  }

  private async dropProfileOrder(targetId: string): Promise<void> {
    const sourceId: string = this.draggedConfigId
    this.draggedConfigId = ''
    if (!sourceId || sourceId === targetId || this.busy || this.copyingNodeBatch) return
    const profiles: SfaProfile[] = this.catalog.profiles.slice()
    const from: number = profiles.findIndex((item: SfaProfile) => item.id === sourceId)
    const to: number = profiles.findIndex((item: SfaProfile) => item.id === targetId)
    if (from < 0 || to < 0) return
    profiles.splice(to, 0, profiles.splice(from, 1)[0])
    try { await this.persist({version:this.catalog.version,selectedId:this.catalog.selectedId,profiles:profiles}) }
    catch (_) { this.toast('顺序保存失败') }
  }

  private closeNodeCopy(): void {
    this.nodeCopyVisible = false; this.nodeCopyHover = ''
  }

  private async copyNodeToTarget(target: SfaProfile): Promise<void> {
    if (this.copyingNodeBatch || this.busy) return
    const sourceId: string = this.nodeCopySourceId
    const tags: string[] = this.nodeCopyTags.slice()
    this.nodeCopyVisible = false; this.nodeCopyHover = ''
    this.copyingNodeBatch = true
    this.nodeCopyCancelled = false
    try {
      for (const tag of tags) {
        const current: SfaProfile | undefined = this.catalog.profiles.find((item: SfaProfile) => item.id === target.id)
        if (!current) break
        this.draggedProfileId = sourceId; this.draggedNodeTag = tag
        await this.dropConfigNode(current)
        if (this.nodeCopyCancelled) break
      }
    } finally { this.draggedProfileId = ''; this.draggedNodeTag = ''; this.copyingNodeBatch = false }
  }

  private async dropConfigNode(target: SfaProfile): Promise<void> {
    const sourceId: string = this.draggedProfileId; const tag: string = this.draggedNodeTag
    this.nodeDropTarget = ''
    const source: SfaProfile | undefined = this.catalog.profiles.find((item: SfaProfile) => item.id === sourceId)
    if (!source || !tag || this.busy) return
    this.nodeEnteredTarget = target.id
    setTimeout(() => { this.nodeEnteredTarget = '' },1200)
    if (this.listedProfileNodes(target).some((node:ProfileNode)=>sameProfileNode(source.content,tag,target.content,node.tag))) { this.toast('相同节点已存在，保留原内容'); return }
    let ownsBusy: boolean = false
    try {
      const duplicate: boolean = this.listedProfileNodes(target).some((item: ProfileNode) => item.tag === tag)
      // Copying into the built-in base profile is the common path: no prompt.
      let decisionIndex: number = 1
      {
        const decision = await this.getUIContext().getPromptAction().showDialog({title:duplicate ? '同名节点内容不同' : '复制节点到配置？',
          message:tag + ' → ' + target.name + '。是否保存？源节点保留，同名可以覆盖或保留两份。',
          buttons:duplicate ? [{text:'取消',color:this.palette().textSecondary},{text:'覆盖',color:this.palette().danger},{text:'保留两份',color:this.palette().accent}]
            : [{text:'取消',color:this.palette().textSecondary},{text:'确认复制',color:this.palette().accent}]})
        decisionIndex = decision.index
      }
      if (decisionIndex === 0 || this.busy) { this.nodeCopyCancelled = true; return }
      let retain: boolean = false
      if (target.kind === 'remote') {
        const updateChoice = await this.getUIContext().getPromptAction().showDialog({title:'允许订阅更新覆盖新增节点？',
          message:'选择“更新时保留”，下次更新订阅仍保留本次加入的节点。',
          buttons:[{text:'取消保存',color:this.palette().textSecondary},{text:'允许覆盖',color:this.palette().danger},{text:'更新时保留',color:this.palette().accent}]})
        if (updateChoice.index === 0 || this.busy) { this.nodeCopyCancelled = true; return }
        retain = updateChoice.index === 2
      }
      if (this.catalog.profiles.find((item: SfaProfile) => item.id === target.id)?.content !== target.content) throw new Error('目标配置已更新，请重新拖入')
      this.busy = true; ownsBusy = true
      if (target.kind === 'builtin') {
        const originalQuick: QuickNode | undefined = source.kind === 'builtin' ? this.quick.nodes.find((item:QuickNode)=>tag.endsWith(' · '+item.id)) : undefined
        const raw: ProfileNode | undefined = this.listedProfileNodes(source).find((item:ProfileNode)=>item.tag===tag)
        const uris: string[] = originalQuick ? [originalQuick.uri] : nodeUrisFromSingBox(JSON.stringify({outbounds:[JSON.parse(raw?.json || '{}') as Object]}))
        if (uris.length !== 1) throw new Error('此节点含依赖，请另存为本地节点配置后使用')
        const replaceQuick: QuickNode | undefined = duplicate && decisionIndex === 1 ? this.quick.nodes.find((item:QuickNode)=>tag.endsWith(' · '+item.id)) : undefined
        if(!replaceQuick&&this.quick.nodes.some((item:QuickNode)=>item.uri===uris[0])){this.toast('相同节点已存在，保留原内容');return}
        const next: QuickCatalog = replaceQuick ? {version:1,subscriptions:this.quick.subscriptions,nodes:this.quick.nodes.map((item:QuickNode):QuickNode=>item.id===replaceQuick.id?{id:item.id,uri:uris[0],sourceId:item.sourceId}:item)} : importQuickNodes(this.quick,uris[0])
        await this.persistQuick(next)
      } else {
        const copied = copyProfileNode(source.content,tag,target.content,duplicate && decisionIndex === 1)
        const retained: string[] = (target.retainedNodeTags || []).filter((item: string) => item !== copied.tag)
        if (retain) retained.push(copied.tag)
        await this.persist(saveSfaProfile(this.catalog,{id:target.id,name:target.name,kind:target.kind,url:target.url,usage:target.usage,content:copied.content,retainedNodeTags:retained,updatedAt:Date.now(),localNodeEdits:target.kind === 'remote'}))
      }
      this.toast('节点已复制，源节点保留')
    } catch (failure) { this.nodeCopyCancelled = true; this.toast(failure instanceof Error ? failure.message : '复制失败，原配置保留') }
    finally { if(ownsBusy)this.busy = false }
  }

  @Builder
  configNodeEditor() {
    Column({space:12}) {
      Text('编辑 ' + this.profileNodeTag).fontSize(17).fontColor(this.palette().textPrimary).width('100%')
      Text('完整节点 JSON；保留 tag 以维护策略组引用。').fontSize(12).fontColor(this.palette().textSecondary)
      TextArea({text:this.profileNodeJson}).layoutWeight(1).width('100%').fontSize(13).fontFamily('monospace')
        .maxLength(1048576).onChange((value:string)=>{this.profileNodeJson=value})
      Button('保存方式…').onClick(()=>this.saveConfigNode())
    }.width('100%').height('100%').padding(16)
  }

  private selectAllProfiles(): void {
    const selectable: string[] = this.catalog.profiles
      .filter((profile: SfaProfile) => !builtinProfile(profile.id))
      .map((profile: SfaProfile) => profile.id)
    this.selectedProfileIds = this.selectedProfileIds.length === selectable.length ? [] : selectable
  }

  private removeProfiles(ids: string[]): void {
    const targets: string[] = ids.filter((id: string) => !builtinProfile(id))
    if (targets.length === 0) { this.toast('内置基础配置不能删除'); return }
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

  private async choosePreset(id: string): Promise<void> {
    if (this.quick.nodes.length === 0) { this.toast('请先导入节点'); this.page = 'nodes'; return }
    await this.selectProfile(id)
    if (this.phase !== 'error') { this.tab = 'tools'; this.page = '' }
  }

  @Builder
  profileEditAction(profile: SfaProfile) {
    Column() { Text('编辑').fontSize(14).fontColor(Color.White) }
      .width(72).height('100%').justifyContent(FlexAlign.Center).backgroundColor('#1E6FFF').borderRadius(12)
      .onClick(() => { if (profile.kind === 'builtin') this.page = 'nodes'; else this.editProfile(profile) })
  }

  @Builder
  profileDeleteAction(profile: SfaProfile) {
    if (profile.kind === 'builtin') {
      Column() { Text('内置').fontSize(13).fontColor(this.palette().textSecondary) }
        .width(72).height('100%').justifyContent(FlexAlign.Center)
        .backgroundColor(this.palette().surfaceMuted).borderRadius(12)
    } else {
      Column() { Text('删除').fontSize(14).fontColor(Color.White) }
        .width(72).height('100%').justifyContent(FlexAlign.Center).backgroundColor('#D93025').borderRadius(12)
        .onClick(() => this.removeProfile(profile))
    }
  }

  @Builder
  profilesPage() {
    Column() {
      if (this.initializationError.length > 0) {
        Text(this.initializationError).fontSize(14).fontColor(this.palette().danger).padding({ top: this.contentTopGap() + 4, left: 16, right: 16 })
        Button('重试读取配置').enabled(!this.busy).onClick(() => { this.initialize() })
      }
      List({ space: 10 }) {
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
              this.profileDragHandle(profile)
              Text(this.selectedProfileIds.length > 0 ? (this.selectedProfileIds.includes(profile.id) ? '✓' : '○') :
                (this.catalog.selectedId === profile.id ? '●' : '○')).fontSize(20).fontColor(this.palette().accent)
              Column({ space: 4 }) {
                Text(profile.name).fontSize(16).fontColor(this.palette().textPrimary).maxLines(1)
                Text(this.profileSubtitle(profile)).fontSize(12).fontColor(this.palette().textSecondary).maxLines(1)
                this.subscriptionDetails(profile)
              }.layoutWeight(1).alignItems(HorizontalAlign.Start)
              if (profile.kind === 'remote') {
                Button('更新').fontSize(12).height(34).backgroundColor(Color.Transparent)
                  .fontColor(this.palette().accent).onClick(() => this.updateProfile(profile))
              }
              if (profile.kind === 'builtin' || this.selectedProfileIds.includes(profile.id)) {
                Button('节点').fontSize(12).height(34).backgroundColor(Color.Transparent)
                  .fontColor(this.palette().accent).onClick(() => this.toggleProfileNodes(profile.id))
              }
              if(this.nodeDropTarget===profile.id)Text('松开复制').fontSize(12).fontColor(this.palette().accent)
              else if(this.nodeEnteredTarget===profile.id)Text('已接收').fontSize(12).fontColor(this.palette().accent)
              if (this.reorderId === profile.id) {
                Button('↑').width(34).height(34).fontSize(14).backgroundColor(this.palette().surfaceMuted)
                  .fontColor(this.palette().textPrimary).onClick(() => this.moveProfile(profile.id, -1))
                Button('↓').width(34).height(34).fontSize(14).backgroundColor(this.palette().surfaceMuted)
                  .fontColor(this.palette().textPrimary).onClick(() => this.moveProfile(profile.id, 1))
                Button('完成').height(34).fontSize(12).backgroundColor(Color.Transparent).fontColor(this.palette().accent)
                  .onClick(() => { this.reorderId = '' })
              }
            }.width('100%').constraintSize({ minHeight: 76 }).padding(16).backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass).borderRadius(12)
        .backgroundEffect({ radius: this.reduceTransparency ? 0 : 18, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
        .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#33FFFFFF' : '#99FFFFFF' })
              .onClick(() => {
                if (this.selectedProfileIds.length > 0) this.toggleProfileSelection(profile.id)
                else this.selectProfile(profile.id)
              })
              .gesture(LongPressGesture().onAction(() => this.toggleProfileSelection(profile.id)))
              .onDragEnter(()=>{if(this.draggedNodeTag)this.nodeDropTarget=profile.id})
              .onDragLeave(()=>{this.nodeDropTarget=''})
              .onDrop(()=>{if(this.draggedConfigId)this.dropProfileOrder(profile.id);else this.dropConfigNode(profile)})
              .scale({x:this.nodeEnteredTarget===profile.id?1.015:1,y:this.nodeEnteredTarget===profile.id?1.015:1})
              .animation({duration:180,curve:Curve.EaseOut})
              .border({width:this.nodeDropTarget===profile.id?2:0.8,color:this.nodeDropTarget===profile.id?this.palette().accent:'#66FFFFFF'})
            }.width('100%')
          }.swipeAction({ start: this.profileStartActions(profile), end: this.profileDeleteAction(profile) })
          if (this.expandedProfileNodes.includes(profile.id)) {
            if (this.configNodeSelectionSource === profile.id && this.configNodeSelection.length > 0) {
              ListItem() {
                Row({space:8}) {
                  Text('已选 ' + this.configNodeSelection.length + ' 个节点').layoutWeight(1).fontSize(14).fontColor(this.palette().textPrimary)
                  Button('全选').height(34).onClick(() => { this.configNodeSelection = this.listedProfileNodes(profile).map((item: ProfileNode) => item.tag) })
                  Button('复制到…').height(34).onClick(() => {
                    const first: ProfileNode | undefined = this.listedProfileNodes(profile).find((item: ProfileNode) => item.tag === this.configNodeSelection[0])
                    if (first) this.openNodeCopy(profile, first)
                  })
                  Button('取消').height(34).onClick(() => { this.configNodeSelection = [] })
                }.width('100%').padding(8).backgroundColor(this.palette().accentSoft).borderRadius(12)
              }
            }
            ForEach(this.listedProfileNodes(profile), (node: ProfileNode) => {
              ListItem() { this.configNodeRow(profile, node) }
                .swipeAction({ start: this.nodeStartActions(profile, node) })
            }, (node: ProfileNode) => profile.id + ':' + node.tag)
          }
        }, (profile: SfaProfile) => `${profile.id}-${profile.updatedAt}-${profile.usage?.updatedAt || 0}`)
        if (this.catalog.profiles.length === 0) {
          ListItem() {
            Column({ space: 12 }) {
              Text('没有配置').fontColor(this.palette().textSecondary)
              Button('新建配置').onClick(() => { this.page = 'add-profile' })
            }.width('100%').padding(24).alignItems(HorizontalAlign.Center)
          }
        }
      }.nestedScroll({scrollForward:NestedScrollMode.PARENT_FIRST,scrollBackward:NestedScrollMode.SELF_FIRST}).layoutWeight(1).padding({ left: 16, right: 16, bottom: 16 })
    }
  }


  @Builder
  editor() {
    Scroll() {
      Column({ space: 16 }) {
        Blank().height(this.contentTopGap())
        if (this.editingId) Button('分享当前配置').fontSize(13).width('100%').height(40)
          .onClick(() => { const target: SfaProfile | undefined = this.catalog.profiles.find((item: SfaProfile) => item.id === this.editingId); if (target) this.shareProfileEntry(target) })
        if (this.editorError.length > 0) Text(this.editorError).fontSize(14).fontColor(this.palette().danger).width('100%')
        Text('基本信息').fontSize(14).fontColor(this.palette().accent).width('100%')
        TextInput({ placeholder: '名称', text: this.draftName }).height(52)
          .onChange((value: string) => { this.draftName = value })
        Text('配置类型').fontSize(14).fontColor(this.palette().accent).width('100%')
        Row({ space: 12 }) {
          Button('本地').layoutWeight(1).backgroundColor(this.draftKind === 'local' ? this.palette().accentSoft : this.palette().surface)
            .fontColor(this.palette().textPrimary).onClick(() => { this.draftKind = 'local' })
          Button('远程').layoutWeight(1).backgroundColor(this.draftKind === 'remote' ? this.palette().accentSoft : this.palette().surface)
            .fontColor(this.palette().textPrimary).onClick(() => { this.draftKind = 'remote' })
        }.width('100%')
        if (this.draftKind === 'remote') {
          TextInput({ placeholder: 'URL', text: this.draftUrl }).height(52).onChange((value: string) => { this.draftUrl = value })
          Text('下载完整 sing-box 配置，不进行 Clash/URI 转换。').fontSize(13).fontColor(this.palette().textSecondary).width('100%')
        } else {
          Text('配置来源').fontSize(14).fontColor(this.palette().accent).width('100%')
          Button('从文件导入').width('100%').onClick(() => this.importFile())
        }
        Text(this.jsonSummary()).fontSize(13).fontColor(this.palette().textSecondary).width('100%')
        Button('查看 / 编辑完整 JSON').width('100%').onClick(() => { this.page = 'json-editor' })
        Text('原订阅更新会覆盖订阅内容；修改 JSON 后可另存为本地配置。').fontSize(12).fontColor(this.palette().textSecondary)

        if (this.busy) LoadingProgress().width(32).height(32)
      }.width('100%').padding({ left: 20, right: 20, bottom: 32 })
    }.nestedScroll({scrollForward:NestedScrollMode.PARENT_FIRST,scrollBackward:NestedScrollMode.SELF_FIRST}).layoutWeight(1).align(Alignment.Top)
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
    }.width('100%').layoutWeight(1).padding({ left: 16, right: 16, bottom: this.bottomInset() + 16 })
  }

  @Builder
  groupNode(group: GroupInfo, item: GroupItem) {
    Column({ space: 4 }) {
      Text(item.tag).fontSize(16).fontWeight(FontWeight.Medium).fontColor(this.palette().textPrimary)
        .width('100%').maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
      Row() {
        Text(this.nodeType(item.type)).fontSize(12).fontColor(this.palette().textSecondary).layoutWeight(1)
        if (item.urlTestDelay) Text(item.urlTestDelay.toString() + 'ms').fontSize(12).fontWeight(FontWeight.Bold)
          .fontColor(delayColor(item.urlTestDelay))
      }.width('100%')
    }.width('100%').height(64).padding(12).borderRadius(12)
      .backgroundColor(group.selected === item.tag ? this.palette().accentSoft : this.palette().background)
      .onClick(() => { if (group.selectable) this.control({ action: 'select', group: group.tag, outbound: item.tag }) })
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
                      if (group.selected === item.tag) Circle().width(4).height(4).fill(Color.White)
                    }.width(11).height(11).borderRadius(4).backgroundColor(delayColor(item.urlTestDelay || 0))
                  }, (item: GroupItem) => item.tag)
                }.width('100%').height(22).onClick(() => this.toggleGroup(group.tag))
              }
            }.width('100%').padding(16).borderRadius(16)
              .backgroundColor(this.palette() === DARK_PALETTE ? '#8025262B' : '#80EEEDF5')
          }, (group: GroupInfo) => group.tag + ':' + group.selected + ':' + group.items.map((item: GroupItem) => item.tag + (item.urlTestDelay || 0).toString()).join('|'))
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

  @Builder
  logsPage() {
    Column({ space: 10 }) {
      TextInput({ placeholder: '搜索日志', text: this.logQuery }).height(44)
        .onChange((value: string) => { this.logQuery = value })
      Row({ space: 8 }) {
        ForEach(['all', 'info', 'warn', 'error', 'debug'], (level: string) => {
          Text(level === 'all' ? '全部' : this.logBadge(level + ' ')).fontSize(12).fontColor(this.palette().textPrimary)
            .padding(8).borderRadius(16).backgroundColor(this.logLevel === level ? this.palette().accentSoft : Color.Transparent)
            .onClick(() => { this.logLevel = level; this.saveUiSettings() })
        }, (level: string) => level)
      }.width('100%')
      List({ space: 8 }) {
          ForEach(this.logs.filter((line: string) => cleanLogLine(line).toLowerCase().includes(this.logQuery.toLowerCase()) &&
            (this.logLevel === 'all' || line.startsWith(this.logLevel + ' '))), (line: string) => {
            ListItem() {
            Column({ space: 6 }) {
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
            }
          }, (_line: string, index: number) => index.toString())
          if (this.logs.length === 0) {
            ListItem() { Text('暂无日志').fontColor(this.palette().textSecondary).margin({ top: 48 }) }
          }
          ListItem() { Column().height(this.mainContentBottomPadding()) }
      }.nestedScroll({scrollForward:NestedScrollMode.PARENT_FIRST,scrollBackward:NestedScrollMode.SELF_FIRST}).layoutWeight(1).width('100%')
    }.layoutWeight(1).padding({ left: 16, right: 16, top: this.contentTopGap() + 4, bottom: this.bottomInset() })
  }

  @Builder
  settingRow(title: string, detail: string, target: string) {
    Row() {
      Column({ space: 5 }) {
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
        Blank().height(this.topInset() + 64)
        Column() {
          this.settingRow('应用设置', '主题、透明效果', 'appearance')
          this.settingRow('WebRTC 防护', 'STUN 代理与禁用 STUN', 'privacy')
          this.settingRow('配置', `${this.catalog.profiles.length} 个配置`, 'profiles')
          this.baseConfigMenu()
          this.settingRow('按需连接', '按 Wi-Fi 分别挂起或直连，离开后恢复', 'ssid')
          this.settingRow('分应用代理', '启用分应用、绕行模式', 'applications')
          this.settingRow('仪表盘项目', '显示或隐藏卡片', 'cards')
        }.width('100%').backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass).borderRadius(12)
        .backgroundEffect({ radius: this.reduceTransparency ? 0 : 18, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
        .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#33FFFFFF' : '#99FFFFFF' })
        Column() {
          this.settingRow('开源项目与源码地址', '项目来源、版本与许可证', 'sources')
          this.settingRow('关于', 'sing-box ' + CORE_VERSION + (coreIsPrerelease(CORE_VERSION) ? ' · Beta' : ' · 稳定版'), 'about')
          Row() {
            Text(this.updateChecking ? '正在检查更新…' : '检查 GitHub 更新').fontColor(this.palette().textPrimary).layoutWeight(1)
            Text(APP_VERSION).fontColor(this.palette().textSecondary)
          }.width('100%').padding(16).constraintSize({ minHeight: 64 }).onClick(() => { this.checkUpdates(true) })
        }.width('100%').backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass).borderRadius(12)
        .backgroundEffect({ radius: this.reduceTransparency ? 0 : 18, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
        .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#33FFFFFF' : '#99FFFFFF' })
      }.width('100%').padding({ left: 16, right: 16, bottom: this.mainContentBottomPadding() })
    }.layoutWeight(1).align(Alignment.Top)
  }

  @Builder
  toolsPage() {
    Scroll() {
      Column({ space: 16 }) {
        Blank().height(this.topInset() + 64)
        Column() {
          this.baseConfigMenu()
          this.settingRow('WebRTC 网络检测', '区分本机候选与 STUN 出口', 'webrtc')
          this.settingRow('Tailscale', '端点、登录与 Taildrop', 'tailscale')
          this.settingRow('DNS 查询', '解析域名并查看地址', 'dns-query')
        }.width('100%').backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass).borderRadius(12)
        .backgroundEffect({ radius: this.reduceTransparency ? 0 : 18, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
        .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#33FFFFFF' : '#99FFFFFF' })
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

  private glassModifier(interactive: boolean): CommonModifier {
    const key: string = (this.palette() === DARK_PALETTE ? 'dark' : 'light') + '-' + this.reduceTransparency + '-' + interactive
    const cached: CommonModifier | undefined = this.glassModifierCache.get(key)
    if (cached) return cached
    const modifier: CommonModifier = new CommonModifier()
    if (!this.reduceTransparency && deviceInfo.apiAvailable('26.0.0')) {
      try {
        if (uiMaterial.isImmersiveMaterialSupported()) {
          hilog.info(0x0000, 'HarmonyNetGlass', 'native material level=%{public}d state=%{public}d interactive=%{public}s',
            uiMaterial.getGlobalMaterialLevel(), uiMaterial.getMaterialInfo().state, interactive.toString())
          modifier.systemMaterial(new uiMaterial.ImmersiveMaterial({
            style: uiMaterial.ImmersiveStyle.ULTRA_THIN,
            materialColor: Color.Transparent, colorInvert: false,
            applyShadow: true, interactive: interactive,
            lightEffect: { color: '#66' + this.palette().accent.substring(1) }
          }))
        }
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
        .backgroundColor(this.reduceTransparency ? this.palette().surface : (this.palette() === DARK_PALETTE ? '#661C1D21' : '#66F5F3FA'))
        .backgroundEffect({ radius: this.reduceTransparency ? 0 : 12, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
        .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#55FFFFFF' : '#AAFFFFFF' })
        .shadow({ radius: 8, color: this.palette().shadow, offsetY: 3 })
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

  private dockAccent(): string {
    return this.reduceTransparency ? this.palette().accentSoft : '#40' + this.palette().accentSoft.substring(1)
  }

  private mainContentBottomPadding(): number {
    if (this.page) return 16
    // Reserve the floating controls, navigation, system inset and a visible gap.
    const controlsHeight: number = this.phase === 'running' ? 56 : 72
    return this.bottomInset() + this.dockSize(72 + 6 + 8 + controlsHeight) + 20
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
    if (builtinProfile(profile.id) && this.quick.nodes.length === 0) throw new Error('请先导入节点，再启动内置配置')
    return prepareLocalConfig(profile.content, { ipv6Enabled: configIpv6Enabled(profile.content), protectWebRtc: this.protectWebRtc, strictWebRtc: this.strictWebRtc })
  }

  private quickEditable(): boolean {
    return !this.busy
  }

  private async persistQuick(next: QuickCatalog): Promise<void> {
    if (!this.quickStore) throw new Error('节点存储尚未就绪')
    await this.quickStore.save(next)
    this.quick = next
    await this.persist(withBuiltinProfiles(this.catalog, next, this.builtinRulesDir, this.baseMode))
    this.nodeDelays = new Map()
    await this.restartBaseIfRunning()
  }

  private async restartBaseIfRunning(silent: boolean = false): Promise<void> {
    const profile: SfaProfile | undefined = this.selectedProfile()
    if (!profile || !this.coordinator || !builtinProfile(profile.id)) return
    if (this.phase !== 'running' && this.phase !== 'error') return
    const previous: string = this.activeConfig
    if (this.quick.nodes.length === 0) {
      this.applyStatus(await this.coordinator.disconnect())
      this.activeConfig = ''
      this.toast('已删除全部节点，代理已停止')
      return
    }
    try {
      // runtimeConfig re-parses and adapts the profile, so a broken node never
      // reaches the core; connect itself validates the config once more.
      const config: string = this.runtimeConfig(profile)
      this.applyStatus(await this.coordinator.disconnect())
      this.applyStatus(await this.connectProfile(config, vpnApplicationScope(this.networkSettings), profile.id))
      this.activeConfig = config
      if (!silent) this.toast('节点已更新，核心与 VPN 已重启')
    } catch (failure) {
      // A failed apply must not leave the user offline: restore the config
      // that was running before this change instead of stopping the VPN.
      if (previous.length > 0) {
        try {
          this.applyStatus(await this.coordinator.disconnect())
          this.applyStatus(await this.connectProfile(previous, vpnApplicationScope(this.networkSettings), profile.id))
          this.activeConfig = previous
          if (!silent) this.toast('新配置启动失败，已恢复原配置继续运行')
          return
        } catch (_) { }
      }
      if (!silent) this.toast(failure instanceof Error ? failure.message : '节点已保存，但重启失败，请手动重新连接')
    }
  }

  // Runs after a successful start: refresh the GFW/mainland rule-sets quietly,
  // at most once a day, and apply them with a silent restart. Any failure keeps
  // the current rule-sets and the running session untouched.
  private async maybeAutoUpdateRules(): Promise<void> {
    if (this.ruleUpdateRunning) return
    const profile: SfaProfile | undefined = this.selectedProfile()
    if (!profile || !builtinProfile(profile.id)) return
    if (this.phase !== 'running') return
    if (Date.now() - this.rulesUpdatedAt < 24 * 60 * 60 * 1000) return
    this.ruleUpdateRunning = true
    try {
      const result: RuleSetUpdate = await updateBuiltinRules(this.context())
      this.rulesUpdatedAt = result.updatedAt
      if (this.prefs) { this.prefs.putSync('rules-updated-at', result.updatedAt); await this.prefs.flush() }
      await this.restartBaseIfRunning(true)
    } catch (_) {
      // Silent by design: keep the bundled rule-sets and the current session.
    } finally { this.ruleUpdateRunning = false }
  }

  private async setBaseMode(mode: string): Promise<void> {
    if (this.baseMode === mode || this.busy) return
    this.baseMode = mode
    if (this.prefs) { this.prefs.putSync('base-mode', mode); await this.prefs.flush() }
    try {
      await this.persist(withBuiltinProfiles(this.catalog, this.quick, this.builtinRulesDir, mode))
      await this.restartBaseIfRunning()
    } catch (failure) { this.toast(failure instanceof Error ? failure.message : '分流方式保存失败') }
  }

  private async importUrl(): Promise<void> {
    const url: string = this.urlDraft.trim()
    if (!/^https:\/\//i.test(url)) { this.toast('订阅地址需要 HTTPS'); return }
    if (this.busy) return
    this.busy = true
    try {
      const body: string = await this.downloadRaw(url, false)
      let uris: string[]
      try { uris = nodeUrisFromSingBox(body) }
      catch (failure) { this.offerFullProfile(body, url, failure instanceof Error ? failure.message : '节点参数不能完整转换'); return }
      if (uris.length > 0) {
        await this.persistQuick(importQuickNodes(this.quick, uris.join('\n')))
      } else if (body.trim().startsWith('{')) {
        throw new Error('配置中没有可导入的节点')
      } else {
        const source: QuickSubscription = { id: `subscription-${Date.now()}`, name: '节点订阅', url: url, updatedAt: Date.now() }
        await this.persistQuick(importQuickNodes(this.quick, body, source))
      }
      this.showUrlImport = false
      this.page = 'nodes'
      this.toast('导入完成')
    } catch (failure) { this.toast(failure instanceof Error ? failure.message : '导入失败') }
    finally { this.busy = false }
  }

  private async updateRules(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const result: RuleSetUpdate = await updateBuiltinRules(this.context())
      this.rulesUpdatedAt = result.updatedAt
      if (this.prefs) { this.prefs.putSync('rules-updated-at', result.updatedAt); await this.prefs.flush() }
      this.toast(`规则集已更新（${this.formatBytes(result.totalBytes)}）`)
      await this.restartBaseIfRunning()
    } catch (failure) {
      this.toast('规则集更新失败，继续按原来的配置运行')
    } finally { this.busy = false }
  }

  private formatTime(value: number): string {
    const date: Date = new Date(value)
    const pad = (part: number): string => part < 10 ? `0${part}` : `${part}`
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  private onPageChanged(): void {
    if(this.page!=='groups')this.showGroups=false
    const root:string=drawerRoot(this.page)
    if(root!==this.previousDrawerRoot)this.drawerPinned = false
    this.previousDrawerRoot=root
    if (this.page && (this.tab === 'dashboard' || this.tab === 'log')) {
      const index: number = drawerMenus(this.tab,this.page).findIndex((item: DrawerMenu) => item.key === drawerRoot(this.page))
      setTimeout(() => { try { this.drawerScroller.scrollToIndex(index + 1,true,ScrollAlign.START) } catch (_) { } },80)
    }
    if (this.page === 'nodes') this.startNodeTests()
    else this.stopNodeTests()
  }

  private startNodeTests(): void {
    this.stopNodeTests()
    this.testAllNodes().catch(() => {})
    this.nodeTestTimer = setInterval(() => { this.testAllNodes().catch(() => {}) }, 20000)
  }

  private stopNodeTests(): void {
    this.nodeTestGeneration++
    this.nodeProbe?.close()
    this.nodeProbe = null
    if (this.nodeTestTimer !== 0) clearInterval(this.nodeTestTimer)
    this.nodeTestTimer = 0
    this.nodeTestProgress = ''
  }

  private nodeTag(entry: QuickNode): string {
    try { return `${quickNode(entry).name} · ${entry.id}` } catch (_) { return entry.id }
  }

  private canTestNodes(): boolean {
    return this.phase === 'running' && !this.suspended && !this.recovering && builtinProfile(this.catalog.selectedId)
  }

  private delayText(entry: QuickNode): string {
    const value: number | undefined = this.nodeDelays.get(entry.id)
    if (value === undefined) return this.nodeTesting ? '…' : '—'
    if (value <= 0) return this.nodeErrors.get(entry.id) || '测速失败'
    return `${Math.round(value)}ms`
  }

  private delayColorFor(entry: QuickNode): string {
    const value: number | undefined = this.nodeDelays.get(entry.id)
    if (value === undefined || value <= 0) return this.palette().textSecondary
    return delayColor(value)
  }

  // Reuse loaded outbounds when possible. Manual tests otherwise use a
  // temporary outbound-only worker without switching profiles or starting VPN.
  private async testAllNodes(manual: boolean = false): Promise<void> {
    if (this.nodeTesting) return
    if (!this.coordinator || !this.ready || !this.uiForeground || this.page !== 'nodes') return
    const live: boolean = this.canTestNodes()
    if (!live && !manual) return
    if ((!manual && this.suspended) || this.recovering || this.phase === 'starting' || this.phase === 'stopping') {
      if (manual) this.toast(this.suspended ? '按需连接已挂起，暂不发起代理测速' : '连接正在切换，请稍后测速')
      return
    }
    if (this.quick.nodes.length === 0) {
      if (manual) this.toast('还没有节点')
      return
    }
    this.nodeTesting = true
    const probe: NodeProbeService | null = manual && !live ? new NodeProbeService(this.context().filesDir, this.context().cacheDir) : null
    this.nodeProbe = probe
    const generation: number = this.nodeTestGeneration
    this.nodeTestProgress = ''
    const next: Map<string, number> = new Map()
    const errors: Map<string, string> = new Map()
    try {
      const nodes: QuickNode[] = this.visibleQuickNodes()
      for (let index: number = 0; index < nodes.length; index++) {
        if (generation !== this.nodeTestGeneration || this.page !== 'nodes' || !this.uiForeground || (!manual && this.suspended)) break
        const entry: QuickNode = nodes[index]
        this.nodeTestProgress = `${index + 1}/${nodes.length}`
        try {
          next.set(entry.id, probe !== null ? await probe.test(buildNodeTestConfig(entry, await physicalProbeDns())) : await this.coordinator.urlTest(this.nodeTag(entry)))
        } catch (failure) {
          next.set(entry.id, -1)
          const message: string = failure instanceof Error ? failure.message : ''
          const known: string[] = ['超时', 'DNS 失败', 'TLS 失败', '网络不可用', '连接失败', '握手失败', '初始化失败', '清理失败', '测速启动失败', '已取消', '测速失败']
          errors.set(entry.id, known.includes(message) ? message : nodeProbeErrorLabel(nodeProbeErrorCode(message)))
        }
        if (generation !== this.nodeTestGeneration || this.page !== 'nodes' || !this.uiForeground) break
        this.nodeDelays = next
        this.nodeErrors = errors
      }
    } finally {
      probe?.close()
      if (this.nodeProbe === probe) this.nodeProbe = null
      this.nodeTesting = false
      if (generation === this.nodeTestGeneration) {
        this.nodeTestProgress = ''
        if (this.page === 'nodes' && this.uiForeground) { this.nodeDelays = next; this.nodeErrors = errors }
      } else if (this.nodeTestTimer !== 0 && this.page === 'nodes' && this.uiForeground) {
        // Wait for the previous core request before beginning the next round.
        this.testAllNodes().catch(() => {})
      }
    }
  }

  private offerFullProfile(content: string, url: string, reason: string): void {
    this.getUIContext().getPromptAction().showDialog({ title: '保留完整配置', message: reason,
      buttons: [{ text: '取消', color: this.palette().textSecondary }, { text: '作为完整配置导入', color: this.palette().accent }] }).then((result) => {
      if (result.index !== 1) return
      this.editProfile(); this.draftName = '完整配置'; this.draftContent = content
      this.draftKind = url ? 'remote' : 'local'; this.draftUrl = url
    }).catch(() => { this.toast('请从配置页导入原始完整 JSON') })
  }

  private async importSmart(): Promise<void> {
    if (this.busy) return
    const text: string = this.importText.trim()
    if (!text) { this.toast('请粘贴节点链接、订阅地址或完整 JSON'); return }
    if (text.startsWith('{')) {
      let uris: string[]
      try { uris = nodeUrisFromSingBox(text) }
      catch (failure) { this.offerFullProfile(text, '', failure instanceof Error ? failure.message : '节点参数不能完整转换'); return }
      if (uris.length > 0) {
        if (!this.quickEditable()) return
        this.busy = true
        try {
          await this.persistQuick(importQuickNodes(this.quick, uris.join('\n')))
          this.importText = ''
          this.page = 'nodes'
          this.toast(`已从 sing-box 配置导入 ${uris.length} 个节点`)
        } catch (failure) { this.toast(failure instanceof Error ? failure.message : 'sing-box 节点导入失败') }
        finally { this.busy = false }
        return
      }
    }
    if (text.startsWith('{') || text.startsWith('sing-box://')) {
      try {
        const profile: ScannedProfile = parseProfileQr(text)
        this.editProfile(); this.draftName = profile.name; this.draftKind = profile.kind
        this.draftUrl = profile.url; this.draftContent = profile.content
      } catch (_) { this.toast('不是有效的 sing-box 配置或远程配置链接') }
      return
    }
    if (!this.quickEditable()) return
    this.busy = true
    try {
      // http://user:pass@host:port#name is an HTTP proxy node; anything else
      // with an http:// prefix is treated as an insecure subscription URL.
      const httpProxyNode: boolean = /^http:\/\/[^\s/]+@[^\s/]+:\d+(#.*)?$/i.test(text)
      const remote: boolean = /^https:\/\//i.test(text)
      if (/^http:\/\//i.test(text) && !httpProxyNode) throw new Error('订阅地址需要 HTTPS')
      let downloadedUsage: SubscriptionUsage | undefined = undefined
      const body: string = remote ? await this.downloadRaw(text, false, (usage: SubscriptionUsage | undefined) => { downloadedUsage = usage }) : text
      if (remote && body.trim().startsWith('{')) {
        validateSfaContent(body)
        this.editProfile(); this.draftKind = 'remote'; this.draftUrl = text; this.draftName = '远程配置'; this.draftContent = body
        this.toast('已识别完整 JSON，保存后按原配置运行'); return
      }
      const old: QuickSubscription | undefined = this.quick.subscriptions.find((item: QuickSubscription) => item.url === text)
      const source: QuickSubscription | undefined = remote ? { id: old?.id || `subscription-${Date.now()}`, name: old?.name || '节点订阅', url: text, updatedAt: Date.now(), usage: downloadedUsage || old?.usage } : undefined
      await this.persistQuick(importQuickNodes(this.quick, body, source))
      this.importText = ''; this.page = 'nodes'; this.toast('节点已导入，可选择内置配置启动')
    } catch (failure) { this.toast(failure instanceof Error ? failure.message : '导入失败，原节点已保留') }
    finally { this.busy = false }
  }

  private async pasteImport(): Promise<void> {
    try { this.importText = (await pasteboard.getSystemPasteboard().getData()).getPrimaryText() }
    catch (_) { this.toast('未能读取剪贴板，请在输入框长按粘贴') }
  }

  private openNode(entry?: QuickNode, protocol?: string): void {
    this.editingNodeId = entry?.id || ''; this.editingNodeUri = entry?.uri || ''
    this.nodeDraft = entry ? draftFromNode(quickNode(entry)) : emptyNodeDraft()
    if (entry === undefined && protocol !== undefined) {
      const draft: NodeDraft = this.cloneNodeDraft(this.nodeDraft)
      draft.protocol = protocol
      if (protocol === 'shadowsocks') draft.port = '8388'
      if (protocol === 'hysteria2') draft.port = '443'
      this.nodeDraft = draft
    }
    // Editing the original link is lossless, including protocol extensions.
    this.rawNodeEditor = entry !== undefined; this.page = 'node-editor'
  }

  private async saveNode(): Promise<void> {
    if (!this.quickEditable()) return
    this.busy = true
    try {
      const uri: string = this.rawNodeEditor ? this.editingNodeUri.trim() : draftNodeUri(this.nodeDraft)
      const node = quickNode({ id: 'draft', uri: uri, sourceId: '' })
      const original: QuickNode | undefined = this.quick.nodes.find((item: QuickNode) => item.id === this.editingNodeId)
      let saveCopy: boolean = false
      if (original) {
        const decision = await this.getUIContext().getPromptAction().showDialog({title:'如何保存节点？',
          message:'覆盖订阅节点后，订阅更新会覆盖修改；另存节点则独立保留。',
          buttons:[{text:'取消',color:this.palette().textSecondary},{text:'覆盖原节点',color:this.palette().danger},{text:'另存节点',color:this.palette().accent}]})
        if (decision.index === 0) return
        saveCopy = decision.index === 2
      }
      const entry: QuickNode = { id: saveCopy ? 'local-' + Date.now() + '-' + node.id : (this.editingNodeId || node.id), uri: uri, sourceId: saveCopy ? '' : (original?.sourceId || '') }
      const nodes: QuickNode[] = this.quick.nodes.slice()
      const index: number = nodes.findIndex((item: QuickNode) => item.id === entry.id)
      if (index < 0) nodes.push(entry); else nodes[index] = entry
      await this.persistQuick({ version: 1, subscriptions: this.quick.subscriptions, nodes: nodes })
      this.page = 'nodes'; this.toast(entry.sourceId ? '已覆盖节点；订阅更新会覆盖修改' : '已保存独立本地节点')
    } catch (failure) { this.toast(failure instanceof Error ? failure.message : '节点保存失败') }
    finally { this.busy = false }
  }

  private removeQuickNodes(ids: string[]): void {
    if (!this.quickEditable() || !ids.length) return
    this.getUIContext().getPromptAction().showDialog({ title: '删除节点', message: `删除 ${ids.length} 个节点？订阅节点下次更新可能重新出现。`,
      buttons: [{ text: '取消', color: this.palette().textSecondary }, { text: '删除', color: this.palette().danger }] }).then(async (result) => {
      if (result.index !== 1 || !this.quickEditable()) return
      this.busy = true
      try { await this.persistQuick({ version: 1, subscriptions: this.quick.subscriptions, nodes: this.quick.nodes.filter((item: QuickNode) => !ids.includes(item.id)) }); this.selectedNodeIds = [] }
      catch (_) { this.toast('删除失败，请重新打开节点页确认') }
      finally { this.busy = false }
    })
  }

  private async refreshNodeSubscription(source: QuickSubscription): Promise<void> {
    if (!this.quickEditable()) return
    const decision=await this.getUIContext().getPromptAction().showDialog({title:'更新订阅节点？',
      message:'此订阅的节点将被远端内容覆盖。独立另存的本地节点不受影响。',
      buttons:[{text:'取消',color:this.palette().textSecondary},{text:'更新并覆盖',color:this.palette().danger}]})
    if(decision.index!==1||!this.quickEditable())return
    this.busy = true
    try {
      let downloadedUsage: SubscriptionUsage | undefined = undefined
      const body: string = await this.downloadRaw(source.url, false, (usage: SubscriptionUsage | undefined) => { downloadedUsage = usage })
      if (body.trim().startsWith('{')) throw new Error('此订阅已变为完整 JSON，请从智能导入添加为独立配置')
      await this.persistQuick(importQuickNodes(this.quick, body, { id: source.id, name: source.name, url: source.url, updatedAt: Date.now(), usage: downloadedUsage || source.usage }))
      this.toast('订阅已更新')
    } catch (failure) { this.toast(failure instanceof Error ? failure.message : '订阅更新失败，原节点已保留') }
    finally { this.busy = false }
  }

  private async removeNodeSubscription(source: QuickSubscription): Promise<void> {
    if (!this.quickEditable()) return
    this.getUIContext().getPromptAction().showDialog({ title: '删除订阅', message: '同时删除此订阅提供的节点？手动编辑过的独立节点保留。',
      buttons: [{ text: '取消', color: this.palette().textSecondary }, { text: '删除', color: this.palette().danger }] }).then(async (result) => {
      if (result.index !== 1 || !this.quickEditable()) return
      this.busy = true
      try { await this.persistQuick({ version: 1, subscriptions: this.quick.subscriptions.filter((item: QuickSubscription) => item.id !== source.id), nodes: this.quick.nodes.filter((item: QuickNode) => item.sourceId !== source.id) }) }
      catch (_) { this.toast('订阅删除失败') } finally { this.busy = false }
    })
  }

  private visibleQuickNodes(): QuickNode[] {
    const query: string = this.nodeQuery.trim().toLowerCase()
    return this.quick.nodes.filter((entry: QuickNode) => !query ||
      (this.nodeLabel(entry) + ' ' + this.nodeDetail(entry)).toLowerCase().includes(query))
  }

  private toggleQuickSelection(id: string): void {
    this.selectedNodeIds = this.selectedNodeIds.includes(id) ? this.selectedNodeIds.filter((item: string) => item !== id) : [...this.selectedNodeIds, id]
  }

  private async copyNodeUris(uris: string[]): Promise<void> {
    try { await pasteboard.getSystemPasteboard().setData(pasteboard.createPlainTextData(uris.join('\n'))); this.toast('节点链接已复制') }
    catch (_) { this.toast('复制失败') }
  }

  private async scanProfile(autoImport: boolean = false): Promise<void> {
    this.sheetVisible = false
    try {
      const result: scanBarcode.ScanResult = await scanBarcode.startScanForResult(this.context(), {
        scanTypes: [scanCore.ScanType.QR_CODE], enableAlbum: true
      })
      if (!result.originalValue) return
      this.importText = result.originalValue
      this.page = 'import'
      this.toast('已识别二维码，请检查后导入')
      if (autoImport) await this.importSmart()
    } catch (failure) { this.toast(failure instanceof Error ? failure.message : '扫码已取消或不可用') }
    finally { this.syncWindowTheme() }
  }

  @Builder
  addProfileSheet() {
    Column({ space: 6 }) {
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
      List({ space: 10 }) {
        if(this.showSsidEditor)ListItem(){this.ssidEditor()}
        ListItem() {
          Column() { Blank().height(this.contentTopGap()) }.width('100%')
        }
        ListItem() {
          Row({ space: 10 }) {
            Column({ space: 6 }) {
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
            Row({ space: 10 }) {
              if (this.selectedSsids.length > 0) {
                Text(this.selectedSsids.includes(ssid) ? '✓' : '○').fontSize(18).fontColor(this.palette().accent)
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
      }.nestedScroll({scrollForward:NestedScrollMode.PARENT_FIRST,scrollBackward:NestedScrollMode.SELF_FIRST}).layoutWeight(1).padding({ left: 16, right: 16, bottom: 16 })
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
            Row({ space: 14 }) {
              Stack() {
                Text(app.label.substring(0, 1)).fontSize(18).fontColor(this.palette().accent)
                if (app.icon) Image(app.icon).width(36).height(36).borderRadius(8)
              }.width(36).height(36).borderRadius(8).backgroundColor(this.palette().surfaceElevated)
              Column({ space: 4 }) {
                Text(app.label).fontSize(15).fontColor(this.palette().textPrimary).maxLines(1)
                Text(app.bundleName).fontSize(11).fontColor(this.palette().textSecondary).maxLines(1)
              }.layoutWeight(1).alignItems(HorizontalAlign.Start)
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
      }.width('100%').padding({ left: 16, right: 12, bottom: this.bottomInset() + 12 })
    }.layoutWeight(1).width('100%')
  }

  @Builder
  connectionsPage() {
    Column({ space: 10 }) {
      TextInput({ text: this.connectionQuery, placeholder: '搜索域名、地址或出站' }).onChange((value: string) => { this.connectionQuery = value })
      Text(`活动连接 ${this.connectionCount} · 最多显示 100 条`).fontSize(13).fontColor(this.palette().textSecondary)
      List({ space: 10 }) {
        ForEach(this.liveConnections.filter((item: LiveConnection) => `${item.domain} ${item.destination} ${item.outbound}`.toLowerCase().includes(this.connectionQuery.toLowerCase())), (item: LiveConnection) => {
          ListItem() {
            Column({ space: 6 }) {
              Row() {
                Text(`${(item.network || '').toUpperCase()}  ${item.domain || item.destination || ''}`).layoutWeight(1).fontSize(14).fontColor(this.palette().textPrimary)
                Button('关闭').fontSize(12).height(30).enabled(!this.busy).onClick(() => this.control({ action: 'close-connection', id: item.id }))
              }
              Text(`↑ ${this.formatBytes(item.uplinkTotal || 0)}   ↓ ${this.formatBytes(item.downlinkTotal || 0)}`).fontSize(13).fontColor(this.palette().textSecondary)
              Text(`${item.inbound || ''} → ${item.outbound || ''}`).fontSize(13).fontColor(this.palette().textSecondary)
              if (item.rule) Text(item.rule).fontSize(12).fontColor(this.palette().textSecondary).maxLines(2)
            }.width('100%').alignItems(HorizontalAlign.Start).padding(14).backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass).borderRadius(12)
        .backgroundEffect({ radius: this.reduceTransparency ? 0 : 18, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
        .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#33FFFFFF' : '#99FFFFFF' })
          }
        }, (item: LiveConnection) => `${item.id}:${item.uplinkTotal}:${item.downlinkTotal}`)
      }.nestedScroll({scrollForward:NestedScrollMode.PARENT_FIRST,scrollBackward:NestedScrollMode.SELF_FIRST}).layoutWeight(1).width('100%')
    }.padding({ left: 16, right: 16, top: this.contentTopGap() + 4, bottom: this.bottomInset() + 20 }).layoutWeight(1)
  }

  @Builder
  webrtcPage() {
    Column({ space: 10 }) {
      Text('应用内 WebView 检测仅代表本页，不代表其他浏览器。请同时在实际使用的浏览器复测。').fontSize(13).fontColor(this.palette().textSecondary).padding(12)
      Button('在外部浏览器复测候选类型').onClick(() => { this.context().startAbility({ action: 'ohos.want.action.viewData', uri: 'https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/' }).catch(() => { this.toast('无法打开浏览器') }) })
      Web({ src: $rawfile('webrtc-diagnostic.html'), controller: this.webRtcController }).javaScriptAccess(true).domStorageAccess(false).layoutWeight(1)
    }.padding({ top: this.contentTopGap() + 4, bottom: this.bottomInset() + 16 }).width('100%').layoutWeight(1)
  }

  @Builder
  baseConfigMenu() {
    Column() {
      Row() {
        Column({ space: 5 }) {
          Text('基础配置').fontSize(16).fontColor(this.palette().textPrimary)
          Text('节点选择 / 模式选择').fontSize(13).fontColor(this.palette().textSecondary)
        }.layoutWeight(1).alignItems(HorizontalAlign.Start)
        Text(this.baseExpanded ? '⌃' : '⌄').fontSize(22).fontColor(this.palette().textSecondary)
      }.width('100%').padding(16).constraintSize({ minHeight: 72 })
        .onClick(() => { this.baseExpanded = !this.baseExpanded })
      if (this.baseExpanded) {
        Column() {
          this.settingRow('节点选择', this.quick.nodes.length + ' 个节点 · 导入与测速', 'nodes')
          this.settingRow('模式选择', '大陆直连 / GFW 分流', 'presets')
        }.width('100%').padding({ left: 16 })
      }
    }.width('100%')
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
      }.width('100%').padding({ left: 20, right: 20, bottom: this.bottomInset() + 24 })
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
    }.width('100%').padding({ left: 20, right: 20, top: 20, bottom: this.floatingControlsHeight() + 24 })
    }.width('100%').height('100%').padding({top:this.contentTopGap()}).clip(true).scrollBar(BarState.Auto)
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
    }.padding({ left: 20, right: 20, top: this.contentTopGap() + 20, bottom: this.bottomInset() + 20 }).layoutWeight(1)
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
        this.sourceEntry('MetaCubeX / meta-rules-dat', '内置与在线更新的大陆域名、GeoIP 和 GFW 规则。GPL-3.0。', 'https://github.com/MetaCubeX/meta-rules-dat')
        this.sourceEntry('SagerNet / sing-box-for-android', '安卓版 1.14.4 的界面、图标和配置导入格式参考；Android 代码未直接作为鸿蒙界面运行。', 'https://github.com/SagerNet/sing-box-for-android')
        this.sourceEntry('AI-Scarlett / HarmonyOS_VPN', '应用基础工程，基于 b7a75930d2bf 修改。许可证与声明见对应源码包。', 'https://github.com/AI-Scarlett/HarmonyOS_VPN')
        this.sourceEntry('SagerNet / gvisor', '实际使用网络栈，基于 e9989ea3436f 的兼容源码。Apache-2.0。', 'https://github.com/SagerNet/gvisor')
        this.sourceEntry('yourblacksky / ohos_golang_go', '实际使用 OHOS Go 工具链源码，基于 e7463379a44e，并保留本地运行时启动修复。', 'https://github.com/yourblacksky/ohos_golang_go')
        this.sourceEntry('tljk / FlClash-ohos', '用户提供的鸿蒙代理应用调研参考，未作为本版主界面框架。', 'https://github.com/tljk/FlClash-ohos')
        this.sourceEntry('2dust / v2rayNG', '分应用设置界面和启用／绕行语义参考。Android 应用枚举接口不能直接用于鸿蒙。', 'https://github.com/2dust/v2rayNG')
        this.sourceEntry('miramira8295 / TelegramForHarmony', '用户指定的毛玻璃视觉参考；本版采用 ArkUI 原生模糊材质实现。', 'https://github.com/miramira8295/TelegramForHarmony')
        Text('完整许可证及构建来源记录位于对应源码包的 LICENSE、THIRD_PARTY_NOTICES.md 和 BUILD-MANIFEST.json。').fontSize(13).fontColor(this.palette().textSecondary)
      }.width('100%').padding({ left: 16, right: 16, bottom: this.bottomInset() + 24 })
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
      }.width('100%').padding(24)
    }.nestedScroll({scrollForward:NestedScrollMode.PARENT_FIRST,scrollBackward:NestedScrollMode.SELF_FIRST}).layoutWeight(1).align(Alignment.Top)
  }


  private backFromPage(): void {
    if (this.page === 'applications') { this.finishApplications(); return }
    if (this.page === 'json-editor') { this.page = 'editor'; return }
    if (this.page === 'editor') {
      if (this.busy) return
      const original: SfaProfile | undefined = this.catalog.profiles.find((item: SfaProfile) => item.id === this.editingId)
      if (this.draftContent !== (original?.content || '')) {
        this.getUIContext().getPromptAction().showDialog({ title: '配置尚未保存', message: '是否保存当前修改？',
          buttons: [{ text: '继续编辑', color: this.palette().textSecondary }, { text: '放弃修改', color: this.palette().danger }, { text: '保存', color: this.palette().accent }]
        }).then((result) => { if (result.index === 1) this.page = 'profiles'; if (result.index === 2) this.saveEditor() })
      } else this.page = 'profiles'
      return
    }
    if (this.page === 'import' || this.page === 'node-editor') { this.page = 'nodes'; return }
    if (this.page === 'nodes' || this.page === 'presets') this.baseExpanded = true
    this.page = drawerParent(this.page)
  }

  private nodeBasics(entry: QuickNode): string[] {
    // Parsing a share link allocates a full node model; cache per URI so large
    // subscriptions do not re-parse every row on each keystroke or scroll.
    const cached: string[] | undefined = this.nodeSummaryCache.get(entry.uri)
    if (cached !== undefined) return cached
    let label: string = entry.id
    let detail: string = '节点参数无效'
    try {
      const node = quickNode(entry)
      label = node.name.length > 0 ? node.name : entry.id
      detail = `${node.protocol.toUpperCase()} · ${node.server}:${node.port}`
    } catch (_) { }
    const summary: string[] = [label, detail]
    this.nodeSummaryCache.set(entry.uri, summary)
    return summary
  }

  private nodeLabel(entry: QuickNode): string {
    return this.nodeBasics(entry)[0]
  }

  private nodeDetail(entry: QuickNode): string {
    return this.nodeBasics(entry)[1]
  }

  private selectedUris(): string[] {
    return this.quick.nodes.filter((entry: QuickNode) => this.selectedNodeIds.includes(entry.id))
      .map((entry: QuickNode) => entry.uri)
  }

  private async shareNode(entry: QuickNode): Promise<void> {
    try {
      const data: systemShare.SharedData = new systemShare.SharedData({ utd: 'general.plain-text', content: entry.uri, title: this.nodeLabel(entry) })
      await new systemShare.ShareController(data).show(this.context(), {})
    } catch (_) { await this.copyNodeUris([entry.uri]) }
  }

  private cloneNodeDraft(draft: NodeDraft): NodeDraft {
    return { name: draft.name, protocol: draft.protocol, server: draft.server, port: draft.port, username: draft.username, credential: draft.credential,
      method: draft.method, alterId: draft.alterId, security: draft.security, sni: draft.sni, insecure: draft.insecure,
      alpn: draft.alpn, fingerprint: draft.fingerprint, publicKey: draft.publicKey, shortId: draft.shortId, flow: draft.flow,
      transport: draft.transport, path: draft.path, host: draft.host, serviceName: draft.serviceName }
  }

  private setNodeProtocol(value: string): void {
    const next: NodeDraft = this.cloneNodeDraft(this.nodeDraft)
    next.protocol = value
    this.nodeDraft = next
  }

  private setNodeTransport(value: string): void {
    const next: NodeDraft = this.cloneNodeDraft(this.nodeDraft)
    next.transport = value
    this.nodeDraft = next
  }

  private setNodeSecurity(value: string): void {
    const next: NodeDraft = this.cloneNodeDraft(this.nodeDraft)
    next.security = value
    this.nodeDraft = next
  }

  @Builder
  importPage() {
    Scroll() {
      Column({ space: 14 }) {
        Blank().height(this.contentTopGap())
        Text('智能导入').fontSize(15).fontColor(this.palette().accent).width('100%')
        Text('支持节点分享链接（ss / vmess / vless / trojan / hy2）、https 订阅地址、完整 sing-box JSON，以及 sing-box:// 远程配置。内容会自动识别。')
          .fontSize(13).fontColor(this.palette().textSecondary).width('100%')
        TextArea({ text: this.importText, placeholder: '在这里粘贴节点链接、订阅地址或 JSON' }).height(240)
          .fontSize(12).fontFamily('monospace').onChange((value: string) => { this.importText = value })
        Row({ space: 10 }) {
          Button('粘贴').layoutWeight(1).height(44).onClick(() => this.pasteImport())
          Button('扫码').layoutWeight(1).height(44).onClick(async () => { await this.scanProfile() })
        }.width('100%')
        Button('导入').width('100%').height(46).enabled(!this.busy)
          .onClick(async () => { await this.importSmart() })
        if (this.busy) LoadingProgress().width(32).height(32)
        Text('导入的节点会写进内置配置，之后打开“大陆以外代理”或“GFW 分流”即可启动。')
          .fontSize(12).fontColor(this.palette().textSecondary).width('100%')
      }.width('100%').padding({ left: 18, right: 18, bottom: 40 }).alignItems(HorizontalAlign.Start)
    }.nestedScroll({scrollForward:NestedScrollMode.PARENT_FIRST,scrollBackward:NestedScrollMode.SELF_FIRST}).layoutWeight(1).align(Alignment.Top)
  }

  private selectAllNodes(): void {
    const ids: string[] = this.visibleQuickNodes().map((entry: QuickNode) => entry.id)
    this.selectedNodeIds = this.selectedNodeIds.length === ids.length ? [] : ids
  }

  @Builder
  nodeEditAction(entry: QuickNode) {
    Column() { Text('编辑').fontSize(14).fontColor(Color.White) }
      .width(72).height('100%').justifyContent(FlexAlign.Center).backgroundColor('#1E6FFF').borderRadius(12)
      .onClick(() => this.openNode(entry))
  }

  @Builder
  nodeDeleteAction(entry: QuickNode) {
    Column() { Text('删除').fontSize(14).fontColor(Color.White) }
      .width(72).height('100%').justifyContent(FlexAlign.Center).backgroundColor('#D93025').borderRadius(12)
      .onClick(() => this.removeQuickNodes([entry.id]))
  }

  @Builder
  nodesPage() {
    Column() {
      List({ space: 10 }) {
        ListItem() {
          Column() { Blank().height(this.contentTopGap()) }.width('100%')
        }
        ListItem() {
          Row({ space: 10 }) {
            Column({ space: 6 }) {
              Text('节点导入').fontSize(22).fontWeight(FontWeight.Bold).fontColor(this.palette().textPrimary)
              Text(`已导入 ${this.quick.nodes.length} 个节点 · ${this.quick.subscriptions.length} 个订阅`)
                .fontSize(12).fontColor(this.palette().textSecondary)
              Text(this.canTestNodes() ? '实时测速中 · 每 20 秒刷新' : (this.suspended ? '已挂起 · 可单独手动测速' : '点击测速，无需启动基础配置'))
                .fontSize(11).fontColor(this.palette().textSecondary)
            }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            Button() {
              Row({ space: 4 }) {
                this.icon('speed', 16)
                Text(this.nodeTesting ? (this.nodeTestProgress.length > 0 ? this.nodeTestProgress : '测速中')
                  : '测速').fontSize(12).fontColor(this.palette().textPrimary)
              }
            }.height(40).padding({ left: 10, right: 10 }).backgroundColor(this.palette().accentSoft)
              .enabled(!this.nodeTesting)
              .accessibilityText('测试已导入节点延迟')
              .onClick(async () => { await this.testAllNodes(true) })
            Button('+').width(48).height(48).fontSize(28).backgroundColor(this.palette().accentSoft)
              .fontColor(this.palette().textPrimary)
              .bindMenu([
                { value: '手动输入', action: () => this.openNode() },
                { value: '二维码导入（支持订阅）', action: async () => { await this.scanProfile(true) } },
                { value: 'URL 导入（支持订阅）', action: () => { this.urlDraft = ''; this.page = 'url-import' } }
              ])
          }.width('100%').padding(16).backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass).borderRadius(12)
        .backgroundEffect({ radius: this.reduceTransparency ? 0 : 18, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
        .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#33FFFFFF' : '#99FFFFFF' })
        }
        ForEach(this.quick.subscriptions, (source: QuickSubscription) => {
          ListItem() {
            Row({ space: 8 }) {
              Column({ space: 3 }) {
                Text(source.name).fontSize(15).fontColor(this.palette().textPrimary).maxLines(1)
                Text(source.url).fontSize(11).fontColor(this.palette().textSecondary).maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
              }.layoutWeight(1).alignItems(HorizontalAlign.Start)
              Button('更新').fontSize(12).height(36).backgroundColor(Color.Transparent)
                .fontColor(this.palette().accent).enabled(!this.busy).onClick(() => this.refreshNodeSubscription(source))
              Button('删除').fontSize(12).height(36).backgroundColor(Color.Transparent)
                .fontColor(this.palette().danger).enabled(!this.busy).onClick(() => this.removeNodeSubscription(source))
            }.width('100%').padding(14).backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass).borderRadius(12)
        .backgroundEffect({ radius: this.reduceTransparency ? 0 : 18, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
        .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#33FFFFFF' : '#99FFFFFF' })
          }
        }, (source: QuickSubscription) => source.id + '-' + (source.usage?.updatedAt || 0))
        if (this.quick.nodes.length > 0) {
          ListItem() {
            TextInput({ placeholder: '搜索节点', text: this.nodeQuery }).height(44)
              .onChange((value: string) => { this.nodeQuery = value })
          }
        }
        if (this.selectedNodeIds.length > 0) {
          ListItem() {
            Row({ space: 8 }) {
              Text(`已选 ${this.selectedNodeIds.length}`).fontSize(14).fontColor(this.palette().textPrimary).layoutWeight(1)
              Button('全选').fontSize(13).height(38).backgroundColor(Color.Transparent).fontColor(this.palette().accent)
                .onClick(() => this.selectAllNodes())
              Button('分享').fontSize(13).height(38).onClick(() => this.copyNodeUris(this.selectedUris()))
              Button('删除').fontSize(13).height(38).fontColor(this.palette().danger)
                .onClick(() => this.removeQuickNodes(this.selectedNodeIds))
              Button('取消').fontSize(13).height(38).backgroundColor(Color.Transparent)
                .onClick(() => { this.selectedNodeIds = [] })
            }.width('100%').padding(12).backgroundColor(this.palette().accentSoft).borderRadius(12)
          }
        }
        ForEach(this.visibleQuickNodes(), (entry: QuickNode) => {
          ListItem() {
            Row({ space: 10 }) {
              if (this.selectedNodeIds.length > 0) {
                Text(this.selectedNodeIds.includes(entry.id) ? '✓' : '○').fontSize(18).fontColor(this.palette().accent)
              }
              Column({ space: 3 }) {
                Text(this.nodeLabel(entry)).fontSize(15).fontColor(this.palette().textPrimary).maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                Text(this.nodeDetail(entry)).fontSize(12).fontColor(this.palette().textSecondary).maxLines(1)
              }.layoutWeight(1).alignItems(HorizontalAlign.Start)
              Text(this.delayText(entry)).fontSize(12).fontColor(this.delayColorFor(entry))
                .width(52).textAlign(TextAlign.End)
              Button('分享').fontSize(12).height(34).backgroundColor(Color.Transparent)
                .fontColor(this.palette().accent).onClick(() => this.shareNode(entry))
            }.width('100%').height(68).padding(14).backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass).borderRadius(12)
        .backgroundEffect({ radius: this.reduceTransparency ? 0 : 18, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
        .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#33FFFFFF' : '#99FFFFFF' })
              .onClick(() => {
                if (this.selectedNodeIds.length > 0) this.toggleQuickSelection(entry.id)
                else this.openNode(entry)
              })
              .gesture(LongPressGesture().onAction(() => this.toggleQuickSelection(entry.id)))
          }.swipeAction({ start: this.nodeEditAction(entry), end: this.nodeDeleteAction(entry) })
        }, (entry: QuickNode) => entry.id)
        if (this.quick.nodes.length === 0) {
          ListItem() {
            Column({ space: 12 }) {
              Text('还没有节点').fontSize(16).fontColor(this.palette().textPrimary)
              Text('用链接、二维码或手动添加导入节点。导入后即可启动内置基础配置。')
                .fontSize(13).fontColor(this.palette().textSecondary).textAlign(TextAlign.Center)
            }.width('100%').padding(24).backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass).borderRadius(12)
        .backgroundEffect({ radius: this.reduceTransparency ? 0 : 18, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
        .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#33FFFFFF' : '#99FFFFFF' })
              .alignItems(HorizontalAlign.Center)
          }
        }
      }.nestedScroll({scrollForward:NestedScrollMode.PARENT_FIRST,scrollBackward:NestedScrollMode.SELF_FIRST}).layoutWeight(1).padding({ left: 16, right: 16, bottom: 16 })
    }
  }

  @Builder
  nodeEditorPage() {
    Scroll() {
      Column({ space: 12 }) {
        Blank().height(this.contentTopGap())
        Row() {
          Column({ space: 3 }) {
            Text('直接编辑分享链接').fontSize(15).fontColor(this.palette().textPrimary)
            Text('保留协议扩展参数，适合高级节点').fontSize(12).fontColor(this.palette().textSecondary)
          }.layoutWeight(1).alignItems(HorizontalAlign.Start)
          Toggle({ type: ToggleType.Switch, isOn: this.rawNodeEditor })
            .onChange((value: boolean) => { this.rawNodeEditor = value })
        }.width('100%').padding(14).backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass).borderRadius(12)
        .backgroundEffect({ radius: this.reduceTransparency ? 0 : 18, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
        .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#33FFFFFF' : '#99FFFFFF' })
        if (this.rawNodeEditor) {
          TextArea({ text: this.editingNodeUri, placeholder: 'vless://…' }).height(200).fontSize(12)
            .fontFamily('monospace').onChange((value: string) => { this.editingNodeUri = value })
          Text('按原始链接保存，下面表单里的参数不会覆盖它。').fontSize(12)
            .fontColor(this.palette().textSecondary).width('100%')
        } else {
          TextInput({ text: this.nodeDraft.name, placeholder: '别名（remarks）' }).height(48)
            .onChange((value: string) => { this.nodeDraft.name = value })
          Text('协议（protocol）').fontSize(13).fontColor(this.palette().accent).width('100%')
          Button(this.nodeDraft.protocol.toUpperCase()).width('100%').height(44)
            .backgroundColor(this.palette().surface).fontColor(this.palette().textPrimary)
            .bindMenu([
              { value: 'VLESS', action: () => this.setNodeProtocol('vless') },
              { value: 'VMess', action: () => this.setNodeProtocol('vmess') },
              { value: 'Shadowsocks', action: () => this.setNodeProtocol('shadowsocks') },
              { value: 'Trojan', action: () => this.setNodeProtocol('trojan') },
              { value: 'Hysteria2', action: () => this.setNodeProtocol('hysteria2') },
              { value: 'Hysteria', action: () => this.setNodeProtocol('hysteria') },
              { value: 'TUIC', action: () => this.setNodeProtocol('tuic') },
              { value: 'AnyTLS', action: () => this.setNodeProtocol('anytls') },
              { value: 'ShadowTLS', action: () => this.setNodeProtocol('shadowtls') },
              { value: 'Snell', action: () => this.setNodeProtocol('snell') },
              { value: 'SSH', action: () => this.setNodeProtocol('ssh') },
              { value: 'SOCKS', action: () => this.setNodeProtocol('socks') },
              { value: 'HTTP', action: () => this.setNodeProtocol('http') }
            ])
          TextInput({ text: this.nodeDraft.server, placeholder: '地址（address）' }).height(48)
            .onChange((value: string) => { this.nodeDraft.server = value })
          TextInput({ text: this.nodeDraft.port, placeholder: '端口（port）' }).height(48).type(InputType.Number)
            .onChange((value: string) => { this.nodeDraft.port = value })
          if (this.nodeDraft.protocol === 'socks' || this.nodeDraft.protocol === 'http' || this.nodeDraft.protocol === 'ssh') {
            TextInput({ text: this.nodeDraft.username, placeholder: '用户名（username）' }).height(48)
              .onChange((value: string) => { this.nodeDraft.username = value })
          }
          TextInput({ text: this.nodeDraft.credential,
            placeholder: this.nodeDraft.protocol === 'tuic' ? 'UUID:密码（uuid:password）' :
              (this.nodeDraft.protocol === 'snell' ? 'PSK（psk）' :
                (this.nodeDraft.protocol === 'vless' || this.nodeDraft.protocol === 'vmess' ? '用户 ID（id）' : '密码（password）')) }).height(48)
            .onChange((value: string) => { this.nodeDraft.credential = value })
          if (this.nodeDraft.protocol === 'shadowsocks') {
            TextInput({ text: this.nodeDraft.method, placeholder: '加密方式（method），如 aes-128-gcm' }).height(48)
              .onChange((value: string) => { this.nodeDraft.method = value })
          }
          if (this.nodeDraft.protocol === 'vmess') {
            TextInput({ text: this.nodeDraft.method, placeholder: '加密方式（security），如 auto' }).height(48)
              .onChange((value: string) => { this.nodeDraft.method = value })
            TextInput({ text: this.nodeDraft.alterId, placeholder: 'alterId' }).height(48).type(InputType.Number)
              .onChange((value: string) => { this.nodeDraft.alterId = value })
          }
          Text('传输协议（network）').fontSize(13).fontColor(this.palette().accent).width('100%')
          Row({ space: 6 }) {
            ForEach(['tcp', 'ws', 'grpc', 'http'], (transport: string) => {
              Button(transport).fontSize(12).layoutWeight(1).height(38)
                .backgroundColor(this.nodeDraft.transport === transport ? this.palette().accentSoft : this.palette().surface)
                .fontColor(this.palette().textPrimary)
                .onClick(() => this.setNodeTransport(transport))
            }, (transport: string) => transport)
          }.width('100%')
          if (this.nodeDraft.transport !== 'tcp') {
            TextInput({ text: this.nodeDraft.path, placeholder: 'path' }).height(48)
              .onChange((value: string) => { this.nodeDraft.path = value })
            TextInput({ text: this.nodeDraft.host, placeholder: 'host（伪装域名）' }).height(48)
              .onChange((value: string) => { this.nodeDraft.host = value })
          }
          Text('TLS（security）').fontSize(13).fontColor(this.palette().accent).width('100%')
          Row({ space: 6 }) {
            ForEach(['none', 'tls', 'reality'], (security: string) => {
              Button(security).fontSize(12).layoutWeight(1).height(38)
                .backgroundColor(this.nodeDraft.security === security ? this.palette().accentSoft : this.palette().surface)
                .fontColor(this.palette().textPrimary)
                .onClick(() => this.setNodeSecurity(security))
            }, (security: string) => security)
          }.width('100%')
          if (this.nodeDraft.security !== 'none') {
            TextInput({ text: this.nodeDraft.sni, placeholder: 'SNI（serverName）' }).height(48)
              .onChange((value: string) => { this.nodeDraft.sni = value })
            TextInput({ text: this.nodeDraft.fingerprint, placeholder: '指纹（fingerprint），如 chrome' }).height(48)
              .onChange((value: string) => { this.nodeDraft.fingerprint = value })
          }
          if (this.nodeDraft.security === 'reality') {
            TextInput({ text: this.nodeDraft.publicKey, placeholder: 'REALITY 公钥' }).height(48)
              .onChange((value: string) => { this.nodeDraft.publicKey = value })
            TextInput({ text: this.nodeDraft.shortId, placeholder: 'REALITY shortId' }).height(48)
              .onChange((value: string) => { this.nodeDraft.shortId = value })
          }
          if (this.nodeDraft.protocol === 'vless') {
            TextInput({ text: this.nodeDraft.flow, placeholder: 'flow（可选，如 xtls-rprx-vision）' }).height(48)
              .onChange((value: string) => { this.nodeDraft.flow = value })
          }
        }
      }.width('100%').padding({ left: 18, right: 18, bottom: 40 }).alignItems(HorizontalAlign.Start)
    }.nestedScroll({scrollForward:NestedScrollMode.PARENT_FIRST,scrollBackward:NestedScrollMode.SELF_FIRST}).layoutWeight(1).align(Alignment.Top)
  }

  @Builder
  presetsPage() {
    Column({ space: 12 }) {
      Blank().height(this.contentTopGap())
      Text('基础配置').fontSize(15).fontColor(this.palette().accent).width('100%')
      Text('由“节点导入”和“分流方式”组成，proxy 组包含 AUTO 与全部节点，AUTO 按延迟自动选择。')
        .fontSize(13).fontColor(this.palette().textSecondary).width('100%')
      Row({ space: 12 }) {
        Column({ space: 4 }) {
          Text('节点导入').fontSize(16).fontColor(this.palette().textPrimary)
          Text(`${this.quick.nodes.length} 个节点 · 手动 / 二维码 / URL / sing-box JSON`).fontSize(12)
            .fontColor(this.palette().textSecondary)
        }.layoutWeight(1).alignItems(HorizontalAlign.Start)
        Text('›').fontSize(24).fontColor(this.palette().textSecondary)
      }.width('100%').padding(16).backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass).borderRadius(12)
        .backgroundEffect({ radius: this.reduceTransparency ? 0 : 18, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
        .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#33FFFFFF' : '#99FFFFFF' })
        .onClick(() => { this.page = 'nodes' })
      Text('分流方式').fontSize(14).fontColor(this.palette().accent).width('100%')
      ForEach(['gfw', 'mainland'], (mode: string) => {
        Row({ space: 12 }) {
          Column({ space: 4 }) {
            Text(mode === 'gfw' ? 'GFW 分流' : '代理大陆以外流量').fontSize(16).fontColor(this.palette().textPrimary)
            Text(mode === 'gfw' ? '仅 GFW 名单走 proxy，其余直连' : '大陆域名与 IP 直连，其余走 proxy')
              .fontSize(12).fontColor(this.palette().textSecondary)
          }.layoutWeight(1).alignItems(HorizontalAlign.Start)
          Text(this.baseMode === mode ? '✓' : '○').fontSize(20).fontColor(this.palette().accent)
        }.width('100%').padding(16).backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass).borderRadius(12)
        .backgroundEffect({ radius: this.reduceTransparency ? 0 : 18, saturation: 1.25, brightness: 1.02, color: Color.Transparent })
        .border({ width: 0.8, color: this.palette() === DARK_PALETTE ? '#33FFFFFF' : '#99FFFFFF' })
          .onClick(() => this.setBaseMode(mode))
      }, (mode: string) => mode)
      Text('TUN 接管 IPv4 与 IPv6；代理流量统一交给节点，走 IPv4 还是 IPv6 由节点决定。')
        .fontSize(12).fontColor(this.palette().textSecondary).width('100%')
      if (this.quick.nodes.length === 0) {
        Text('尚未导入节点：请先在“节点导入”里添加节点，或导入你自己的配置。')
          .fontSize(13).fontColor(this.palette().danger).width('100%')
      }
      Button(this.busy ? '正在更新…' : '更新规则集（GFW / 国内域名）').width('100%').height(46)
        .enabled(!this.busy).onClick(async () => { await this.updateRules() })
      Text(this.rulesUpdatedAt > 0 ? `上次更新：${this.formatTime(this.rulesUpdatedAt)}` :
        '尚未更新过，当前使用安装包内置规则；更新后会自动重启以生效。')
        .fontSize(12).fontColor(this.palette().textSecondary).width('100%')
      Button(this.catalog.selectedId === 'builtin-base' ? '基础配置使用中' : '使用基础配置').width('100%').height(46)
        .enabled(this.catalog.selectedId !== 'builtin-base')
        .onClick(() => this.choosePreset('builtin-base'))
    }.width('100%').padding({ left: 16, right: 16, bottom: 24 })
  }

  @Builder
  urlImportSheet() {
    Column({ space: 14 }) {
      Text('URL 导入').fontSize(20).fontWeight(FontWeight.Bold).fontColor(this.palette().textPrimary).width('100%')
      Text('支持节点链接、sing-box JSON 和订阅地址（https）；订阅会自动识别节点列表。').fontSize(13)
        .fontColor(this.palette().textSecondary).width('100%')
      TextInput({ text: this.urlDraft, placeholder: 'https://…' }).height(48)
        .onChange((value: string) => { this.urlDraft = value })
      Button('导入').width('100%').height(46).enabled(!this.busy).onClick(async () => { await this.importUrl() })
      Button('取消').width('100%').height(42).backgroundColor(Color.Transparent)
        .fontColor(this.palette().textSecondary).onClick(() => { this.showUrlImport = false; this.page = 'nodes' })
    }.width('100%').padding({ left: 20, right: 20, top: 20, bottom: 24 })
  }

  private highlightedNav(): string {
    return this.navDragging && this.navPreviewIndex >= 0 ? NAVIGATION_TABS[this.navPreviewIndex] : this.tab
  }

  @State navSheenPhase: boolean = false
  private navSheenTimer: number = 0

  private stopNavSheen(): void {
    if (this.navSheenTimer !== 0) clearTimeout(this.navSheenTimer)
    this.navSheenTimer = 0
  }

  private startNavSheen(): void {
    this.stopNavSheen()
    if (!this.uiForeground || !this.pageAlive || this.reduceTransparency) return
    // Re-arm on each foreground/appearance instead of setting a one-way flag.
    this.navSheenTimer = setTimeout(() => {
      this.navSheenTimer = 0
      this.navSheenPhase = !this.navSheenPhase
      this.startNavSheen()
    }, 2400)
  }

  private navGlowLeft(): number {
    const index: number = Math.max(0, NAVIGATION_TABS.indexOf(this.tab))
    const x: number = this.navDragging ? this.navPointerX : (index + 0.5) * this.navBarWidth / 4
    return navigationGlowX(x, this.navBarWidth, Math.max(0, this.navBarWidth / 4 - 8))
  }

  private navCapsuleWidth(): number { return Math.max(0, this.navBarWidth / 4 - 8) }

  private navCapsuleHeight(): number { return this.dockSize(56) }

  private finishNavDrag(commit: boolean): void {
    if (!this.navDragging) return
    if (commit && this.navPreviewIndex >= 0) { this.tab = NAVIGATION_TABS[this.navPreviewIndex]; this.page = ''; this.drawerScroller.scrollTo({xOffset:0,yOffset:0}) }
    this.navDragging = false; this.navPreviewIndex = -1; this.navIgnoreClickUntil = Date.now() + 350
  }

  private handleNavTouch(event: TouchEvent): void {
    if (event.type === TouchType.Cancel) { this.finishNavDrag(false); return }
    if (event.touches.length > 1) { this.finishNavDrag(false); return }
    const point: TouchObject | undefined = event.changedTouches[0] || event.touches[0]
    if (event.type === TouchType.Down && point) {
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
        .scale({x:this.highlightedNav() === name ? 1.1 : 1,y:this.highlightedNav() === name ? 1.1 : 1})
        .animation({duration:160,curve:Curve.EaseOut})
      Text(label).fontSize(this.dockSize(12)).fontWeight(this.highlightedNav() === name ? FontWeight.Medium : FontWeight.Normal)
        .fontColor(this.highlightedNav() === name ? this.palette().accent : this.palette().textSecondary)
        .scale({x:this.highlightedNav() === name ? 1.1 : 1,y:this.highlightedNav() === name ? 1.1 : 1})
        .animation({duration:160,curve:Curve.EaseOut})
    }.layoutWeight(1).height(this.dockSize(72)).justifyContent(FlexAlign.Center)
      .onClick(() => { if (Date.now() >= this.navIgnoreClickUntil) { this.tab = name; this.page = '' } })
  }

  @Builder
  navigationFace() {
          Stack({ alignContent: Alignment.TopStart }) {
            if (this.navBarWidth > 0) {
              Column().width(Math.max(0, this.navBarWidth / 4 - 8)).height(this.dockSize(64)).borderRadius(this.dockSize(28))
                .backgroundColor(this.dockAccent()).border({ width: 0.8, color: '#66' + this.palette().accent.substring(1) })
                .shadow({ radius: this.dockSize(8), color: '#40' + this.palette().accent.substring(1), offsetY: 0 })
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
      .margin({ top: this.dockSize(6), bottom: this.bottomInset() + this.dockSize(8) })
  }

  private contentTopGap(): number { return this.topInset() + 64 }

  private drawerBodyHeight(): number {
    return Math.max(240,this.viewportHeight - this.topInset() - 64 - this.floatingControlsHeight())
  }

  private floatingControlsHeight(): number {
    return this.bottomInset() + this.dockSize(72 + 6 + 8 + (this.phase === 'running' ? 80 : 72)) + 20
  }

  private openDrawer(key: string): void {
    if (drawerRoot(this.page) === key) { this.backFromDrawer(); return }
    this.page = key
    if (key === 'applications') this.loadApplications()
    if (key === 'ssid') this.readCurrentSsid()
  }

  private backFromDrawer(): void {
    if (this.page === 'editor' || this.page === 'json-editor' || this.page === 'node-editor' || this.page === 'profile-node-editor') {
      this.getUIContext().getPromptAction().showDialog({title:'收起编辑菜单？',message:'未保存的内容仍保留在当前编辑草稿中。',
        buttons:[{text:'继续编辑',color:this.palette().accent},{text:'收起',color:this.palette().textSecondary}]})
        .then((result)=>{if(result.index===1)this.page=''})
    } else this.page = ''
  }

  @Builder
  drawerHeader(menu: DrawerMenu) {
    if (drawerRoot(this.page) === menu.key) {
      Stack({alignContent:Alignment.End}) {
        this.appToolbar(true)
        Button('收起').height(36).fontSize(13).backgroundColor(Color.Transparent).fontColor(this.palette().accent)
          .margin({right:8}).onClick(()=>this.backFromDrawer())
      }.width('100%').height(64).backgroundColor(this.reduceTransparency ? this.palette().surface : this.palette().surfaceGlass)
        .backgroundEffect({radius:this.filmRadius(),saturation:1.35,brightness:1.02,color:this.filmColor()})
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
      this.baseConfigMenu()
      this.settingRow('自定义配置',this.catalog.profiles.length + ' 个配置 · 编辑与复制节点','profiles')
      if(this.page === 'nodes')this.nodesPage()
      else if(this.page === 'presets')this.presetsPage()
      else if(this.page === 'profiles')this.profilesPage()
      else if(this.page === 'editor')this.editor()
      else if(this.page === 'json-editor')this.jsonEditor()
      else if(this.page === 'node-editor')this.nodeEditorPage()
      else if(this.page === 'profile-node-editor')this.configNodeEditor()
      else if(this.page === 'import')this.importPage()
      else if(this.page === 'add-profile')this.addProfileSheet()
      else if(this.page === 'url-import')this.urlImportSheet()
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
      TailscaleEndpointContent({embedded:true,initialPalette:this.palette(),initialCoordinator:this.coordinator,foreground:this.uiForeground})
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
        } else if (this.page === 'presets') this.presetsPage()
        else if (this.page === 'nodes') this.nodesPage()
        else if (this.page === 'import') this.importPage()
        else if (this.page === 'node-editor') this.nodeEditorPage()
        else if (this.page === 'profile-node-editor') this.configNodeEditor()
        else if (this.page === 'profiles') this.profilesPage()
        else if (this.page === 'editor') this.editor()
        else if (this.page === 'json-editor') this.jsonEditor()
        else if (this.page === 'add-profile') this.addProfileSheet()
        else if (this.page === 'url-import') this.urlImportSheet()
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
        else if (this.page === 'tailscale') TailscaleEndpointContent({embedded:true,initialPalette:this.palette(),initialCoordinator:this.coordinator,foreground:this.uiForeground})
        else if (this.page === 'dns-query') Column({space:16}) {
          TextInput({text:this.host,placeholder:'域名'}).onChange((value:string)=>{this.host=value})
          Button('查询').onClick(async()=>{
            try{const result:connection.NetAddress[]=await connection.getAddressesByName(this.host.trim());this.toolResult=result.map((item:connection.NetAddress)=>item.address).join('\n')}
            catch(_){this.toolResult='查询失败'}
          })
          Text(this.toolResult).fontColor(this.palette().textPrimary).copyOption(CopyOptions.InApp)
        }.padding(16)
        else if (this.tab === 'log') this.logsPage()
        else if (this.tab === 'tools') this.toolsPage()
        else if (this.tab === 'settings') this.settingsPage()
        else this.dashboard()
      }.width('100%').height('100%')

      Column() {
        Blank().height(this.topInset())
        this.appToolbar()
      }.width('100%').height(this.topInset() + 64).position({ x: 0, y: 0 })


      if (this.nodeCopyVisible) {
        Stack({ alignContent: Alignment.Center }) {
          Column({ space: 10 }) {
            Text(this.nodeCopyTags.length > 1 ? '复制 ' + this.nodeCopyTags.length + ' 个节点到…' : '复制「' + this.nodeCopyTag + '」到…').fontSize(16).fontColor(this.palette().textPrimary).width('100%')
            List({ space: 8 }) {
              ForEach(this.catalog.profiles, (item: SfaProfile) => {
                ListItem() {
                  Row({ space: 10 }) {
                    Text(item.name).fontSize(15).fontColor(this.palette().textPrimary).layoutWeight(1).maxLines(1)
                    Text(this.nodeCopyHover === item.id ? '松开复制' : '复制').fontSize(12)
                      .fontColor(this.nodeCopyHover === item.id ? this.palette().accent : this.palette().textSecondary)
                  }.width('100%').height(54).padding({ left: 16, right: 16 }).borderRadius(12)
                    .backgroundColor(this.nodeCopyHover === item.id ? this.palette().accentSoft : this.palette().surfaceGlass)
                    .onClick(() => { this.copyNodeToTarget(item) })
                    .onDragEnter(() => { this.nodeCopyHover = item.id })
                    .onDragLeave(() => { if (this.nodeCopyHover === item.id) this.nodeCopyHover = '' })
                    .onDrop(() => { this.copyNodeToTarget(item) })
                }
              }, (item: SfaProfile) => item.id)
            }.width('100%').height(320)
            Button('取消').width('100%').height(42).backgroundColor(Color.Transparent).fontColor(this.palette().textSecondary)
              .onClick(() => this.closeNodeCopy())
          }.width('90%').padding(20).borderRadius(20).backgroundColor(this.palette().surface)
        }.width('100%').height('100%').backdropBlur(24).backgroundColor('#66000000')
      }

      if (this.ready) {
        Column({ space: 0 }) {
          if (this.phase === 'running') {
            Stack({ alignContent: Alignment.TopStart }) {
              this.glassBackdrop(this.dockSize(56), true)
              Row({ space: this.dockSize(10) }) {
              Text(this.recovering ? '恢复中…' : (this.suspended ? '挂起中…' : '已启动')).fontSize(this.dockSize(16)).fontColor((this.palette() === DARK_PALETTE ? '#FFFFFF' : '#101018')).layoutWeight(1)
              Row({ space: this.dockSize(4) }) { Text(this.connectionCount.toString()).fontSize(this.dockSize(14)); this.icon('connections', this.dockSize(18)) }
                .padding(this.dockSize(10)).borderRadius(this.dockSize(10)).backgroundColor(this.dockAccent())
                .onClick(() => { this.page = 'connections' }).accessibilityText('打开连接列表')
              Button() {
                Row({ space: this.dockSize(4) }) { Text(this.groups.length.toString()).fontSize(this.dockSize(14)).fontColor((this.palette() === DARK_PALETTE ? '#FFFFFF' : '#101018')); this.icon('folder', this.dockSize(18)) }
              }.height(this.dockSize(36)).borderRadius(this.dockSize(10)).backgroundColor(this.dockAccent()).accessibilityText('代理组')
                .onClick(() => this.openGroups())
                .bindSheet($$this.showGroups, this.groupsPage(), {
                  height: '100%', showClose: false, dragBar: true,
                  backgroundColor: this.reduceTransparency ? this.palette().surface : (this.palette() === DARK_PALETTE ? '#661C1D21' : '#66F5F3FA'),
                  blurStyle: this.reduceTransparency ? BlurStyle.NONE : BlurStyle.COMPONENT_THICK
                })

              Button(this.elapsed() + ' ■').fontSize(this.dockSize(14)).height(this.dockSize(36)).borderRadius(this.dockSize(10))
                .fontColor((this.palette() === DARK_PALETTE ? '#FFFFFF' : '#101018')).backgroundColor(this.dockAccent())
                .onClick(() => this.toggleService()).accessibilityText('停止')
              }.width('100%').height(this.dockSize(56)).padding({ left: this.dockSize(16), right: this.dockSize(16) })
            }.width('100%').height(this.dockSize(56)).borderRadius(this.dockSize(28)).clip(true)
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
      .onAreaChange((_old:Area,area:Area)=>{this.viewportHeight=Number(area.height)})
      .linearGradient({ angle: 155, colors: [
        [this.backgroundStop(this.palette().background), 0.0],
        [this.backgroundStop(this.palette().backgroundGlow), 0.45],
        [this.backgroundStop(this.palette().backgroundGlowSecondary), 0.75],
        [this.backgroundStop(this.palette().background), 1.0]] })
      .expandSafeArea([SafeAreaType.SYSTEM], [SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM])
      .bindSheet($$this.sheetVisible, this.mainSheet(), { height: SheetSize.FIT_CONTENT, dragBar: true, showClose: false,
        backgroundColor: this.reduceTransparency ? this.palette().surface : (this.palette() === DARK_PALETTE ? '#661C1D21' : '#66F5F3FA'),
        blurStyle: this.reduceTransparency ? BlurStyle.NONE : BlurStyle.COMPONENT_THICK })

  }
}
