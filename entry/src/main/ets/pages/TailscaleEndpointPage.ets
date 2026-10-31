import { router } from '@kit.ArkUI'
import { selectedTailscaleEndpoint, tailscaleEmptyHint, canOpenTailscaleAuthUrl, tailscaleStateLabel } from '../domain/TailscalePresentation'
import { TailscaleAuthDialog } from '../ui/TailscaleAuthDialog'
// router.pushUrl/getParams/back 虽被标记为 deprecated，但跨页面导航仍需使用。
// 页面内部导航采用 viewMode 模式，与既有架构决策一致。
import { AppPalette, DARK_PALETTE, LIGHT_PALETTE } from '../ui/DesignSystem'
import { hilog } from '@kit.PerformanceAnalysisKit'
import { pasteboard } from '@kit.BasicServicesKit'
import { picker } from '@kit.CoreFileKit'
import { common } from '@kit.AbilityKit'
import type {
  TailscaleStatusUpdate,
  TailscaleEndpointStatus,
  TailscalePeer,
  TailscaleUserGroup,
  TaildropInbox,
  TaildropFile,
  TaildropReceivingFile,
  TaildropSendFile,
  TailscalePingResult,
  TailscaleCoordinator
} from '../domain/TailscaleTypes'

const TS_TAG: string = 'TailscaleEndpointPage'
const TS_DOMAIN: number = 0xA00000

interface PeerBadge {
  text: string
  color: string
}

interface TaildropSendFileInfo {
  name: string
  size: number
  uri: string
}

// 视图模式：端点主页 / Peer详情 / Exit Node选择 / Taildrop收件箱
type ViewMode = 'endpoint' | 'peerDetail' | 'exitNodePicker' | 'taildropInbox'

@Entry
@Component
struct TailscaleEndpointPage {
  @StorageProp('topInsetPx') topInsetPx: number = 0
  @State palette: AppPalette = LIGHT_PALETTE
  @State coordinator: TailscaleCoordinator | null = null
  @State endpointTag: string = ''
  @State tailscaleStatus: TailscaleStatusUpdate = { endpoints: [] }
  @State taildropInbox: TaildropInbox = { endpointTag: '', files: [], receiving: [] }
  @State pingResults: TailscalePingResult[] = []
  @State selectedEndpoint: TailscaleEndpointStatus | null = null
  @State viewMode: ViewMode = 'endpoint'
  @State selectedPeer: TailscalePeer | null = null
  @State selectedPeerIsSelf: boolean = false
  @State exitNodeSearchText: string = ''
  @State tailscaleError: string = ''
  @State pingRunning: boolean = false
  @State pingHistory: number[] = []
  @State copiedAddress: string = ''
  @State taildropSelectedFiles: TaildropSendFileInfo[] = []
  @State taildropSending: boolean = false
  private pollTimer: number = -1
  private statusRefreshBusy: boolean = false
  private inboxRefreshBusy: boolean = false
  private authDialog: CustomDialogController | null = null
  private pingCancelled: boolean = false
  private pingPeerIP: string = ''

  aboutToAppear() {
    const params = router.getParams() as Record<string, Object>
    if (params) {
      this.endpointTag = (params['endpointTag'] as string) || ''
      const paletteKey = (params['paletteKey'] as string) || 'light'
      this.palette = paletteKey === 'dark' ? DARK_PALETTE : LIGHT_PALETTE
    }

    const coord = AppStorage.get<TailscaleCoordinator>('tailscaleCoordinator')
    if (coord) {
      this.coordinator = coord
    }

    // 立即执行一次刷新，不等定时器
    this.refreshTailscaleStatus()

    this.pollTimer = setInterval(() => {
      this.refreshTailscaleStatus()
      if (this.viewMode === 'taildropInbox') {
        this.refreshTaildropInbox()
      }
    }, 500)
  }

  aboutToDisappear() {
    this.authDialog?.close()
    if (this.pollTimer !== -1) {
      clearInterval(this.pollTimer)
      this.pollTimer = -1
    }
    this.stopPing()
  }

  private topInset(): number {
    return this.getUIContext().px2vp(this.topInsetPx)
  }

  private context(): common.UIAbilityContext {
    return this.getUIContext().getHostContext() as common.UIAbilityContext
  }

  private async openAuthUrl(value: string): Promise<void> {
    if (!canOpenTailscaleAuthUrl(value)) { this.tailscaleError = '认证链接无效'; return }
    try {
      await this.context().startAbility({ action: 'ohos.want.action.viewData', uri: value })
    } catch (_) { this.tailscaleError = '无法打开浏览器，请复制认证链接后打开' }
  }

  private showAuthQr(value: string): void {
    if (!canOpenTailscaleAuthUrl(value)) { this.tailscaleError = '认证链接无效'; return }
    if (value.length > 512) { this.tailscaleError = '认证链接过长，请使用浏览器打开'; return }
    this.authDialog?.close()
    this.authDialog = new CustomDialogController({
      builder: TailscaleAuthDialog({ uri: value, surface: this.palette.surface, textColor: this.palette.textPrimary }),
      autoCancel: true, customStyle: true
    })
    this.authDialog.open()
  }

  private async copyAuthUrl(value: string): Promise<void> {
    if (!canOpenTailscaleAuthUrl(value)) { this.tailscaleError = '认证链接无效'; return }
    try {
      await pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, value))
      this.getUIContext().getPromptAction().showToast({ message: '认证链接已复制' })
    } catch (_) { this.tailscaleError = '复制失败，请重试' }
  }

  // ─── 数据刷新（移除互斥锁，确保每次轮询都能执行） ───

  private async refreshTailscaleStatus(): Promise<void> {
    if (this.statusRefreshBusy || this.coordinator === null) return
    this.statusRefreshBusy = true
    try {
      const status: TailscaleStatusUpdate = await this.coordinator.tailscaleStatus()
      this.tailscaleStatus = status
      this.tailscaleError = ''
      // 更新当前选中的 endpoint
      this.selectedEndpoint = selectedTailscaleEndpoint(status.endpoints, this.endpointTag)
      if (this.selectedEndpoint !== null && this.endpointTag.length === 0) {
        this.endpointTag = this.selectedEndpoint!.endpointTag
      }
      // 如果在 Peer 详情页，更新选中的 Peer
      if (this.viewMode === 'peerDetail' && this.selectedPeer !== null) {
        this.updateSelectedPeer()
      }
    } catch (err) {
      this.tailscaleError = err instanceof Error ? err.message : '获取 Tailscale 状态失败'
      hilog.error(TS_DOMAIN, TS_TAG, 'refreshStatus error: %{public}s', this.tailscaleError)
    } finally {
      this.statusRefreshBusy = false
    }
  }

  private updateSelectedPeer(): void {
    if (this.selectedEndpoint === null || this.selectedPeer === null) return
    const allPeers = this.allPeers(this.selectedEndpoint!)
    for (const peer of allPeers) {
      if (peer.stableID === this.selectedPeer!.stableID) {
        this.selectedPeer = peer
        break
      }
    }
  }

  private async refreshTaildropInbox(): Promise<void> {
    if (this.inboxRefreshBusy || this.endpointTag.length === 0 || this.coordinator === null) return
    this.inboxRefreshBusy = true
    try {
      this.taildropInbox = await this.coordinator.taildropInbox(this.endpointTag)
    } catch (err) {
      hilog.error(TS_DOMAIN, TS_TAG, 'refreshTaildropInbox error: %{public}s',
        err instanceof Error ? err.message : String(err))
    } finally {
      this.inboxRefreshBusy = false
    }
  }

  private async subscribeTaildrop(): Promise<void> {
    if (this.endpointTag.length === 0 || this.coordinator === null) return
    try {
      await this.coordinator.taildropSubscribe(this.endpointTag)
      this.refreshTaildropInbox()
    } catch (err) {
      this.tailscaleError = err instanceof Error ? err.message : '订阅 Taildrop 失败'
    }
  }

  private async setExitNode(stableID: string): Promise<void> {
    if (this.endpointTag.length === 0 || this.coordinator === null) return
    try {
      await this.coordinator.tailscaleSetExitNode(this.endpointTag, stableID)
      this.viewMode = 'endpoint'
      this.refreshTailscaleStatus()
    } catch (err) {
      this.tailscaleError = err instanceof Error ? err.message : '设置 Exit Node 失败'
    }
  }

  private async logoutTailscale(): Promise<void> {
    if (this.endpointTag.length === 0 || this.coordinator === null) return
    try {
      await this.coordinator.tailscaleLogout(this.endpointTag)
      this.refreshTailscaleStatus()
    } catch (err) {
      this.tailscaleError = err instanceof Error ? err.message : '登出 Tailscale 失败'
    }
  }

  private startPing(peerIP: string): void {
    if (this.endpointTag.length === 0 || peerIP.length === 0 || this.coordinator === null) return
    this.pingCancelled = false
    this.pingRunning = true
    this.pingResults = []
    this.pingHistory = []
    this.pingPeerIP = peerIP
    this.executePing()
  }

  private stopPing(): void {
    this.pingCancelled = true
    this.pingRunning = false
  }

  private async executePing(): Promise<void> {
    if (this.pingCancelled || !this.pingRunning || this.coordinator === null) {
      this.pingRunning = false
      return
    }
    try {
      const results: TailscalePingResult[] =
        await this.coordinator.tailscalePing(this.endpointTag, this.pingPeerIP)
      if (this.pingCancelled) return
      if (results.length > 0) {
        this.pingResults = results
        const latest: TailscalePingResult = results[results.length - 1]
        if (latest.error.length === 0) {
          this.pingHistory.push(latest.latencyMs)
          if (this.pingHistory.length > 20) {
            this.pingHistory.shift()
          }
        }
      }
    } catch (err) {
      if (this.pingCancelled) return
      this.tailscaleError = err instanceof Error ? err.message : 'Ping 失败'
    }
    if (!this.pingCancelled && this.pingRunning) {
      setTimeout(() => this.executePing(), 1000)
    } else {
      this.pingRunning = false
    }
  }

  private async downloadTaildropFile(fileName: string): Promise<void> {
    if (this.endpointTag.length === 0 || this.coordinator === null) return
    try {
      await this.coordinator.taildropDownload(this.endpointTag, fileName)
      this.refreshTaildropInbox()
    } catch (err) {
      this.tailscaleError = err instanceof Error ? err.message : '下载文件失败'
    }
  }

  private async deleteTaildropFile(fileName: string): Promise<void> {
    if (this.endpointTag.length === 0 || this.coordinator === null) return
    try {
      await this.coordinator.taildropDelete(this.endpointTag, fileName)
      this.refreshTaildropInbox()
    } catch (err) {
      this.tailscaleError = err instanceof Error ? err.message : '删除文件失败'
    }
  }

  private async markTaildropRead(): Promise<void> {
    if (this.endpointTag.length === 0 || this.coordinator === null) return
    try {
      await this.coordinator.taildropMarkRead(this.endpointTag)
      this.refreshTaildropInbox()
    } catch (err) {
      hilog.error(TS_DOMAIN, TS_TAG, 'markTaildropRead error: %{public}s',
        err instanceof Error ? err.message : String(err))
    }
  }

  private async cancelTaildropReceive(senderID: string, name: string): Promise<void> {
    if (this.endpointTag.length === 0 || this.coordinator === null) return
    try {
      await this.coordinator.taildropCancelReceive(this.endpointTag, senderID, name)
      this.refreshTaildropInbox()
    } catch (err) {
      hilog.error(TS_DOMAIN, TS_TAG, 'cancelTaildropReceive error: %{public}s',
        err instanceof Error ? err.message : String(err))
    }
  }

  private async selectFilesForTaildrop(): Promise<void> {
    try {
      const documentViewPicker: picker.DocumentViewPicker = new picker.DocumentViewPicker(this.context())
      const uris: string[] = await documentViewPicker.select({
        maxSelectNumber: 10,
        fileSuffixFilters: ['*']
      })
      if (uris.length === 0) return
      const files: TaildropSendFileInfo[] = []
      for (const uri of uris) {
        files.push({ name: this.extractFileName(uri), size: 0, uri: uri })
      }
      this.taildropSelectedFiles = files
    } catch (err) {
      this.tailscaleError = err instanceof Error ? err.message : '选择文件失败'
    }
  }

  private extractFileName(uri: string): string {
    const lastSlash: number = uri.lastIndexOf('/')
    if (lastSlash >= 0 && lastSlash < uri.length - 1) {
      return uri.substring(lastSlash + 1)
    }
    return 'file'
  }

  private async sendTaildropFiles(): Promise<void> {
    if (this.taildropSelectedFiles.length === 0 || this.coordinator === null) return
    if (this.selectedPeer === null) return
    this.taildropSending = true
    try {
      const filesInfo: TaildropSendFile[] = this.taildropSelectedFiles.map((f: TaildropSendFileInfo): TaildropSendFile =>
        ({ name: f.name, size: f.size }))
      await this.coordinator.taildropSend(this.endpointTag, this.selectedPeer!.stableID, filesInfo)
      this.taildropSelectedFiles = []
      this.tailscaleError = ''
    } catch (err) {
      this.tailscaleError = err instanceof Error ? err.message : '文件发送失败'
    } finally {
      this.taildropSending = false
    }
  }

  private clearTaildropSelectedFiles(): void {
    this.taildropSelectedFiles = []
  }

  // ─── 工具方法 ───

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }

  private peerDisplayName(peer: TailscalePeer): string {
    if (peer.dnsName && peer.dnsName.length > 0) {
      const dotIndex = peer.dnsName.indexOf('.')
      if (dotIndex > 0) {
        return peer.dnsName.substring(0, dotIndex)
      }
      return peer.dnsName
    }
    return peer.hostName || ''
  }

  private allPeers(endpoint: TailscaleEndpointStatus): TailscalePeer[] {
    let peers: TailscalePeer[] = []
    if (endpoint.userGroups === null || endpoint.userGroups === undefined) return peers
    for (const group of endpoint.userGroups) {
      if (group.peers === null || group.peers === undefined) continue
      peers = peers.concat(group.peers)
    }
    return peers
  }

  private exitNodeCandidates(endpoint: TailscaleEndpointStatus): TailscalePeer[] {
    const selfID = endpoint.self !== null ? endpoint.self!.stableID : ''
    return this.allPeers(endpoint).filter((peer: TailscalePeer) =>
      peer.exitNodeOption && peer.stableID !== selfID)
  }

  private hasExitNodeCandidates(endpoint: TailscaleEndpointStatus): boolean {
    return this.exitNodeCandidates(endpoint).length > 0
  }

  private filteredExitNodeCandidates(endpoint: TailscaleEndpointStatus): TailscalePeer[] {
    const candidates = this.exitNodeCandidates(endpoint)
    if (this.exitNodeSearchText.length === 0) return candidates
    return candidates.filter((peer: TailscalePeer) =>
      this.peerDisplayName(peer).toLowerCase().includes(this.exitNodeSearchText.toLowerCase()) ||
      peer.hostName.toLowerCase().includes(this.exitNodeSearchText.toLowerCase()))
  }

  private statusColor(state: string): string {
    if (state === 'Running') return this.palette.online
    if (state === 'NeedsLogin' || state === 'NeedsMachineAuth') return this.palette.warning
    if (state === 'Starting') return this.palette.starting
    return this.palette.offline
  }

  private peerBadges(peer: TailscalePeer): PeerBadge[] {
    if (!peer.online) return []
    const badges: PeerBadge[] = []
    if (peer.shareeNode) {
      badges.push({ text: 'Shared in', color: this.palette.danger })
    }
    if (peer.exitNodeOption) {
      badges.push({ text: 'Exit Node', color: this.palette.blue })
    }
    if (peer.expired) {
      badges.push({ text: 'Expired', color: this.palette.danger })
    } else if (peer.keyExpiry > 0) {
      const expiryMs = peer.keyExpiry * 1000
      const now = Date.now()
      const oneMonthMs = 30 * 24 * 60 * 60 * 1000
      if (expiryMs - now <= oneMonthMs) {
        const diff = expiryMs - now
        if (diff < 60 * 60 * 1000) {
          badges.push({ text: `Expires ${Math.floor(diff / (60 * 1000))}m`, color: this.palette.offline })
        } else if (diff < 24 * 60 * 60 * 1000) {
          badges.push({ text: `Expires ${Math.floor(diff / (60 * 60 * 1000))}h`, color: this.palette.offline })
        } else {
          badges.push({ text: `Expires ${Math.floor(diff / (24 * 60 * 60 * 1000))}d`, color: this.palette.offline })
        }
      }
    } else {
      badges.push({ text: 'Key expiry disabled', color: this.palette.offline })
    }
    if (peer.sshHostKeys !== null && peer.sshHostKeys !== undefined && peer.sshHostKeys.length > 0) {
      badges.push({ text: 'SSH', color: this.palette.online })
    }
    return badges
  }

  private relativeTime(timestamp: number): string {
    if (timestamp <= 0) return ''
    const now = Date.now()
    const diff = now - timestamp * 1000
    if (diff < 60 * 1000) return '刚刚'
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))}分钟前`
    if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / (60 * 60 * 1000))}小时前`
    return `${Math.floor(diff / (24 * 60 * 60 * 1000))}天前`
  }

  private keyExpiryText(peer: TailscalePeer): string {
    if (peer.expired) return 'Expired'
    if (peer.keyExpiry > 0) {
      return this.relativeTime(peer.keyExpiry)
    }
    return 'Disabled'
  }

  private maxPingLatency(): number {
    if (this.pingHistory.length === 0) return 0
    let max: number = 0
    for (const latency of this.pingHistory) {
      if (latency > max) max = latency
    }
    return max * 1.2
  }

  // ─── 主构建 ───

  build() {
    Column() {
      // 顶栏（留出顶部安全区域）
      Column() {
        Blank().height(this.topInset())
        this.topBar()
      }.width('100%').backgroundColor(this.palette.surface)

      // 错误提示
      if (this.tailscaleError.length > 0) {
        Row() {
          Text(this.tailscaleError).fontSize(13).fontColor(this.palette.danger).layoutWeight(1)
          Button('清除').fontSize(12).height(28).backgroundColor(this.palette.dangerSoft)
            .fontColor(this.palette.danger).onClick(() => { this.tailscaleError = '' })
        }.width('100%').padding(12).margin({ left: 16, right: 16, top: 8 })
        .borderRadius(8).backgroundColor(this.palette.dangerSoft)
      }

      // 根据视图模式渲染不同页面
      if (this.viewMode === 'endpoint') {
        this.endpointView()
      } else if (this.viewMode === 'peerDetail') {
        this.peerDetailView()
      } else if (this.viewMode === 'exitNodePicker') {
        this.exitNodePickerView()
      } else if (this.viewMode === 'taildropInbox') {
        this.taildropInboxView()
      }
    }.width('100%').height('100%').backgroundColor(this.palette.background)
  }

  // ─── 顶栏（根据视图模式变化） ───

  @Builder
  topBar() {
    Row({ space: 8 }) {
      Button() {
        Text('‹').fontSize(18).fontColor(this.palette.textPrimary)
      }.width(40).height(40).backgroundColor(Color.Transparent)
        .onClick(() => {
          if (this.viewMode === 'endpoint') {
            router.back()
          } else {
            this.stopPing()
            this.taildropSelectedFiles = []
            this.viewMode = 'endpoint'
            this.selectedPeer = null
          }
        })

      if (this.viewMode === 'endpoint') {
        Text(this.endpointTag === 'default' || this.endpointTag.length === 0
          ? 'Tailscale' : `Tailscale (${this.endpointTag})`)
          .fontSize(20).fontColor(this.palette.textPrimary).layoutWeight(1)
      } else if (this.viewMode === 'peerDetail') {
        Column() {
          Text(this.selectedPeer !== null ? this.peerDisplayName(this.selectedPeer!) : '')
            .fontSize(18).fontColor(this.palette.textPrimary)
          Row({ space: 4 }) {
            Circle({ width: 6, height: 6 })
              .fill(this.selectedPeer !== null && this.selectedPeer!.online ? this.palette.online : this.palette.offline)
            Text(this.selectedPeer !== null && this.selectedPeer!.online ? '已连接' : '未连接')
              .fontSize(12).fontColor(this.palette.textSecondary)
          }
        }.layoutWeight(1).alignItems(HorizontalAlign.Start)
      } else if (this.viewMode === 'exitNodePicker') {
        Text('出口节点').fontSize(20).fontColor(this.palette.textPrimary).layoutWeight(1)
      } else if (this.viewMode === 'taildropInbox') {
        Text('Taildrop').fontSize(20).fontColor(this.palette.textPrimary).layoutWeight(1)
      }
    }.width('100%').height(56).padding({ left: 12, right: 16 })
  }

  // ═══════════════════════════════════════════════════════════════
  // 视图1：端点主页（Status + Peer 列表）
  // ═══════════════════════════════════════════════════════════════

  @Builder
  endpointView() {
    if (this.selectedEndpoint !== null) {
      Scroll() {
        Column({ space: 16 }) {
          this.statusSection(this.selectedEndpoint!)
          if (this.selectedEndpoint!.userGroups !== null &&
              this.selectedEndpoint!.userGroups !== undefined) {
            ForEach(this.selectedEndpoint!.userGroups,
              (group: TailscaleUserGroup) => {
                this.userGroupSection(group)
              },
              (group: TailscaleUserGroup) => `${group.userID}`)
          }
        }.width('100%').padding({ left: 16, right: 16, top: 8, bottom: 32 })
      }.layoutWeight(1)
    } else {
      Column({ space: 16 }) {
        Text('尚未发现 Tailscale 端点').fontSize(18).fontColor(this.palette.textPrimary)
        Text(tailscaleEmptyHint()).fontSize(14).fontColor(this.palette.textSecondary)
          .textAlign(TextAlign.Center)
        Button('刷新').onClick(() => { this.refreshTailscaleStatus() })
      }.width('100%').layoutWeight(1).padding(24).justifyContent(FlexAlign.Center)
    }
  }

  @Builder
  statusSection(endpoint: TailscaleEndpointStatus) {
    Column() {
      Text('状态').fontSize(14).fontColor(this.palette.accent)
        .margin({ bottom: 8, left: 16 })

      Column() {
        // State 行
        Row({ space: 12 }) {
          Column({ space: 2 }) {
            Text('连接状态').fontSize(15).fontColor(this.palette.textPrimary)
            Row({ space: 6 }) {
              Circle({ width: 8, height: 8 }).fill(this.statusColor(endpoint.backendState))
              Text(tailscaleStateLabel(endpoint.backendState, endpoint.stateText))
                .fontSize(13).fontColor(this.statusColor(endpoint.backendState))
            }
          }.layoutWeight(1).alignItems(HorizontalAlign.Start)
        }.width('100%').padding({ left: 16, right: 16, top: 14, bottom: 14 })

        // This Device 行（点击进入 Peer 详情）
        if (endpoint.backendState === 'Running' && endpoint.self !== null) {
          Divider().color(this.palette.border).margin({ left: 16, right: 16 })
          Row({ space: 12 }) {
            Column({ space: 2 }) {
              Text('本机').fontSize(15).fontColor(this.palette.textPrimary)
              Text(this.peerDisplayName(endpoint.self!))
                .fontSize(13).fontColor(this.palette.textSecondary)
            }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            Text('›').fontSize(14).fontColor(this.palette.textTertiary)
          }.width('100%').padding({ left: 16, right: 16, top: 14, bottom: 14 })
          .onClick(() => {
            this.selectedPeer = endpoint.self
            this.selectedPeerIsSelf = true
            this.viewMode = 'peerDetail'
          })
        }

        // Exit Node 行（点击进入 Exit Node 选择页）
        if (endpoint.backendState === 'Running' && this.hasExitNodeCandidates(endpoint)) {
          Divider().color(this.palette.border).margin({ left: 16, right: 16 })
          Row({ space: 12 }) {
            Column({ space: 2 }) {
              Text('出口节点').fontSize(15).fontColor(this.palette.textPrimary)
              Text(endpoint.exitNode !== null ? this.peerDisplayName(endpoint.exitNode!) : 'Disabled')
                .fontSize(13).fontColor(this.palette.textSecondary)
            }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            Text('›').fontSize(14).fontColor(this.palette.textTertiary)
          }.width('100%').padding({ left: 16, right: 16, top: 14, bottom: 14 })
          .onClick(() => {
            this.exitNodeSearchText = ''
            this.viewMode = 'exitNodePicker'
          })
        }

        // Taildrop 行（点击进入 Taildrop 收件箱页）
        if (endpoint.backendState === 'Running' &&
            (endpoint.waitingFileCount > 0 || endpoint.receivingFileCount > 0)) {
          Divider().color(this.palette.border).margin({ left: 16, right: 16 })
          Row({ space: 12 }) {
            Column({ space: 2 }) {
              Text('Taildrop').fontSize(15).fontColor(this.palette.textPrimary)
              Text(endpoint.waitingFileCount > 0 ? `${endpoint.waitingFileCount} 个文件` : '正在接收')
                .fontSize(13).fontColor(this.palette.textSecondary)
            }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            Text('›').fontSize(14).fontColor(this.palette.textTertiary)
          }.width('100%').padding({ left: 16, right: 16, top: 14, bottom: 14 })
          .onClick(() => {
            this.viewMode = 'taildropInbox'
            this.subscribeTaildrop()
          })
        }

        // Auth URL 行
        if (endpoint.authURL.length > 0) {
          Divider().color(this.palette.border).margin({ left: 16, right: 16 })
          Row({ space: 12 }) {
            Text('🔗').fontSize(16)
            Text('打开认证链接').fontSize(15).fontColor(this.palette.textPrimary).layoutWeight(1)
          }.width('100%').padding({ left: 16, right: 16, top: 14, bottom: 14 })
          .onClick(() => {
            this.openAuthUrl(endpoint.authURL)
          })
          Divider().color(this.palette.border).margin({ left: 16, right: 16 })
          Row() {
            Text('显示认证二维码').fontSize(15).fontColor(this.palette.textPrimary).layoutWeight(1)
            Text('›').fontColor(this.palette.textTertiary)
          }.width('100%').padding({ left: 16, right: 16, top: 14, bottom: 14 })
          .onClick(() => { this.showAuthQr(endpoint.authURL) })
          Divider().color(this.palette.border).margin({ left: 16, right: 16 })
          Row() {
            Text('复制认证链接').fontSize(15).fontColor(this.palette.textPrimary)
          }.width('100%').padding({ left: 16, right: 16, top: 14, bottom: 14 })
          .onClick(() => { this.copyAuthUrl(endpoint.authURL) })
        }
      }.width('100%').borderRadius(12).backgroundColor(this.palette.surfaceElevated)
    }.width('100%')
  }

  @Builder
  userGroupSection(group: TailscaleUserGroup) {
    Column() {
      Text(group.displayName && group.displayName.length > 0
        ? group.displayName : group.loginName)
        .fontSize(14).fontColor(this.palette.accent)
        .margin({ bottom: 8, left: 16 })

      if (group.peers !== null && group.peers !== undefined && group.peers.length > 0) {
        Column() {
          ForEach(group.peers, (peer: TailscalePeer, index: number) => {
            if (index > 0) {
              Divider().color(this.palette.border).margin({ left: 16, right: 16 })
            }
            this.peerItem(peer)
          }, (peer: TailscalePeer) => peer.stableID)
        }.width('100%').borderRadius(12).backgroundColor(this.palette.surfaceElevated)
      }
    }.width('100%')
  }

  @Builder
  peerItem(peer: TailscalePeer) {
    Row({ space: 12 }) {
      Circle({ width: 8, height: 8 })
        .fill(peer.online ? this.palette.online : this.palette.offline)
        .margin({ top: 6 })

      Column({ space: 4 }) {
        Text(this.peerDisplayName(peer)).fontSize(15).fontColor(this.palette.textPrimary)

        if (peer.tailscaleIPs !== null && peer.tailscaleIPs !== undefined &&
            peer.tailscaleIPs.length > 0) {
          Text(peer.tailscaleIPs[0]).fontSize(13).fontColor(this.palette.textSecondary)
        }

        if (this.peerBadges(peer).length > 0) {
          Row({ space: 4 }) {
            ForEach(this.peerBadges(peer), (badge: PeerBadge) => {
              Text(badge.text)
                .fontSize(10).fontColor(this.palette.badgeText)
                .padding({ left: 6, right: 6, top: 2, bottom: 2 })
                .borderRadius(10).backgroundColor(badge.color)
            }, (badge: PeerBadge) => badge.text)
          }
        }
      }.layoutWeight(1).alignItems(HorizontalAlign.Start)

      Text('›').fontSize(14).fontColor(this.palette.textTertiary).margin({ top: 4 })
    }.width('100%').padding({ left: 16, right: 16, top: 12, bottom: 12 })
    .onClick(() => {
      this.selectedPeer = peer
      this.selectedPeerIsSelf = this.selectedEndpoint !== null &&
        this.selectedEndpoint!.self !== null &&
        peer.stableID === this.selectedEndpoint!.self!.stableID
      this.viewMode = 'peerDetail'
    })
  }

  // ═══════════════════════════════════════════════════════════════
  // 视图2：Peer 详情页（对齐 Android TailscalePeerScreen）
  // ═══════════════════════════════════════════════════════════════

  @Builder
  peerDetailView() {
    if (this.selectedPeer !== null && this.selectedEndpoint !== null) {
      Scroll() {
        Column({ space: 16 }) {
          // Network 部分（仅本设备）：网络名称 + 登出
          if (this.selectedPeerIsSelf) {
            this.networkSection()
          }

          // Tailscale Addresses 部分
          this.addressesSection(this.selectedPeer!)

          // Ping 部分（非本设备 && 在线 && 有 IP）
          if (!this.selectedPeerIsSelf && this.selectedPeer!.online &&
              this.selectedPeer!.tailscaleIPs !== null &&
              this.selectedPeer!.tailscaleIPs !== undefined &&
              this.selectedPeer!.tailscaleIPs.length > 0) {
            this.pingSection(this.selectedPeer!)
          }

          // Taildrop 发送区域（非本设备 && 在线 && 可接收文件 && 可分享）
          if (!this.selectedPeerIsSelf && this.selectedPeer!.online &&
              this.selectedPeer!.canReceiveFiles &&
              this.selectedEndpoint!.canShareFiles) {
            this.taildropSendSection()
          }

          // Details 部分
          this.detailsSection(this.selectedPeer!)

          // SSH 连接按钮暂未实现，隐藏入口（需要终端模拟器组件支持）
        }.width('100%').padding({ left: 16, right: 16, top: 8, bottom: 32 })
      }.layoutWeight(1)
    } else {
      Column() {
        Text('加载中…').fontSize(14).fontColor(this.palette.textSecondary)
      }.layoutWeight(1).justifyContent(FlexAlign.Center)
    }
  }

  @Builder
  networkSection() {
    Column() {
      Text('Network').fontSize(14).fontColor(this.palette.accent)
        .margin({ bottom: 8, left: 16 })

      Column() {
        if (this.selectedEndpoint!.networkName.length > 0) {
          Row() {
            Column({ space: 2 }) {
              Text(this.selectedEndpoint!.networkName).fontSize(14).fontColor(this.palette.textPrimary)
              Text('Network').fontSize(12).fontColor(this.palette.textSecondary)
            }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            this.copyButton(this.selectedEndpoint!.networkName)
          }.width('100%').padding(16)
        }

        if (this.selectedEndpoint!.backendState === 'Running' && !this.selectedEndpoint!.keyAuth) {
          Divider().color(this.palette.border).margin({ left: 16, right: 16 })
          Row({ space: 12 }) {
            Text('⏻').fontSize(16).fontColor(this.palette.danger)
            Text('Logout').fontSize(15).fontColor(this.palette.danger).layoutWeight(1)
          }.width('100%').padding({ left: 16, right: 16, top: 14, bottom: 14 })
          .onClick(() => this.logoutTailscale())
        }
      }.width('100%').borderRadius(12).backgroundColor(this.palette.surfaceElevated)
    }.width('100%')
  }

  @Builder
  addressesSection(peer: TailscalePeer) {
    Column() {
      Text('Tailscale Addresses').fontSize(14).fontColor(this.palette.accent)
        .margin({ bottom: 8, left: 16 })

      Column({ space: 12 }) {
        // Magic DNS
        if (peer.dnsName.length > 0) {
          Row() {
            Column({ space: 2 }) {
              Text(peer.dnsName).fontSize(14).fontColor(this.palette.textPrimary)
              Text('Magic DNS').fontSize(12).fontColor(this.palette.textSecondary)
            }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            this.copyButton(peer.dnsName)
          }.width('100%')
        }

        // Hostname
        if (peer.hostName.length > 0) {
          Row() {
            Column({ space: 2 }) {
              Text(peer.hostName).fontSize(14).fontColor(this.palette.textPrimary)
              Text('Hostname').fontSize(12).fontColor(this.palette.textSecondary)
            }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            this.copyButton(peer.hostName)
          }.width('100%')
        }

        // Tailscale IPs
        if (peer.tailscaleIPs !== null && peer.tailscaleIPs !== undefined) {
          ForEach(peer.tailscaleIPs, (ip: string) => {
            Row() {
              Column({ space: 2 }) {
                Text(ip).fontSize(14).fontColor(this.palette.textPrimary)
                Text(ip.includes(':') ? 'IPv6' : 'IPv4')
                  .fontSize(12).fontColor(this.palette.textSecondary)
              }.layoutWeight(1).alignItems(HorizontalAlign.Start)
              this.copyButton(ip)
            }.width('100%')
          }, (ip: string) => ip)
        }
      }.width('100%').padding(16).borderRadius(12).backgroundColor(this.palette.surfaceElevated)
    }.width('100%')
  }

  @Builder
  copyButton(address: string) {
    Button() {
      if (this.copiedAddress === address) {
        Text('✓').fontSize(14).fontColor(this.palette.accent)
      } else {
        Text('⎘').fontSize(14).fontColor(this.palette.accent)
      }
    }.width(36).height(36).backgroundColor(Color.Transparent)
    .onClick(() => {
      try {
        const pasteboardData = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, address)
        const systemPasteboard = pasteboard.getSystemPasteboard()
        systemPasteboard.setData(pasteboardData)
        this.copiedAddress = address
        // 2秒后恢复
        setTimeout(() => { this.copiedAddress = '' }, 2000)
      } catch (_) {
        this.tailscaleError = '复制失败'
      }
    })
  }

  @Builder
  pingSection(peer: TailscalePeer) {
    Column() {
      Row() {
        Text('Ping').fontSize(14).fontColor(this.palette.accent).layoutWeight(1)
        Button() {
          Text(this.pingRunning ? '⏹' : '▶').fontSize(14).fontColor(this.palette.textPrimary)
        }.width(44).height(32).backgroundColor(this.palette.surfaceMuted)
        .onClick(() => {
          if (this.pingRunning) {
            this.stopPing()
          } else {
            this.startPing(peer.tailscaleIPs[0])
          }
        })
      }.width('100%').margin({ bottom: 8, left: 16, right: 16 })

      Column({ space: 8 }) {
        // 最新 Ping 结果
        if (this.pingResults.length > 0) {
          // 最新结果行：Direct / Peer relay / DERP + 延迟
          Row({ space: 8 }) {
            if (this.pingResults[this.pingResults.length - 1].error.length > 0) {
              Text(this.pingResults[this.pingResults.length - 1].error)
                .fontSize(13).fontColor(this.palette.danger).layoutWeight(1)
            } else {
              if (this.pingResults[this.pingResults.length - 1].isDirect) {
                Text('→').fontSize(14).fontColor(this.palette.online)
                Text('Direct').fontSize(13).fontColor(this.palette.online)
              } else if (this.pingResults[this.pingResults.length - 1].peerRelay.length > 0) {
                Text('↻').fontSize(14).fontColor(this.palette.blue)
                Text('Peer relay').fontSize(13).fontColor(this.palette.blue)
              } else {
                Text('↻').fontSize(14).fontColor(this.palette.warning)
                Text('DERP').fontSize(13).fontColor(this.palette.warning)
              }
              Blank()
              Text(`${this.pingResults[this.pingResults.length - 1].latencyMs.toFixed(0)} ms`)
                .fontSize(16).fontWeight(FontWeight.Bold).fontColor(this.palette.textPrimary)
            }
          }.width('100%')

          // Endpoint 详情（Direct 时）
          if (this.pingResults[this.pingResults.length - 1].error.length === 0 &&
              this.pingResults[this.pingResults.length - 1].isDirect &&
              this.pingResults[this.pingResults.length - 1].endpoint.length > 0) {
            Row() {
              Text('Endpoint').fontSize(12).fontColor(this.palette.textSecondary).width(80)
              Text(this.pingResults[this.pingResults.length - 1].endpoint)
                .fontSize(12).fontColor(this.palette.textPrimary).layoutWeight(1)
            }.width('100%')
          }

          // Peer relay 详情
          if (this.pingResults[this.pingResults.length - 1].error.length === 0 &&
              !this.pingResults[this.pingResults.length - 1].isDirect &&
              this.pingResults[this.pingResults.length - 1].peerRelay.length > 0) {
            Row() {
              Text('Peer relay').fontSize(12).fontColor(this.palette.textSecondary).width(80)
              Text(this.pingResults[this.pingResults.length - 1].peerRelay)
                .fontSize(12).fontColor(this.palette.textPrimary).layoutWeight(1)
            }.width('100%')
          }

          // DERP region 详情
          if (this.pingResults[this.pingResults.length - 1].error.length === 0 &&
              !this.pingResults[this.pingResults.length - 1].isDirect &&
              this.pingResults[this.pingResults.length - 1].peerRelay.length === 0 &&
              this.pingResults[this.pingResults.length - 1].derpRegionCode.length > 0) {
            Row() {
              Text('DERP region').fontSize(12).fontColor(this.palette.textSecondary).width(80)
              Text(this.pingResults[this.pingResults.length - 1].derpRegionCode)
                .fontSize(12).fontColor(this.palette.textPrimary).layoutWeight(1)
            }.width('100%')
          }

          // 延迟历史柱状图（运行中且有 2+ 条记录时显示）
          if (this.pingRunning && this.pingHistory.length > 1) {
            Row() {
              Row({ space: 2 }) {
                ForEach(this.pingHistory, (latency: number, index: number) => {
                  Column() {
                    Column() {
                      Blank()
                    }.width(4)
                    .height(Math.max(2, Math.min(60, latency * 0.3)))
                    .backgroundColor(this.pingResults[this.pingResults.length - 1].isDirect ? this.palette.online : this.palette.blue)
                    .borderRadius(2)
                  }.height(60).justifyContent(FlexAlign.End)
                }, (latency: number, index: number) => `${index}-${latency}`)
              }.layoutWeight(1).height(60).alignItems(VerticalAlign.Bottom)

              // 延迟刻度
              Column() {
                Text(`${this.maxPingLatency().toFixed(0)}ms`).fontSize(10).fontColor(this.palette.textSecondary)
                Text(`${(this.maxPingLatency() * 2 / 3).toFixed(0)}ms`).fontSize(10).fontColor(this.palette.textSecondary)
                Text(`${(this.maxPingLatency() / 3).toFixed(0)}ms`).fontSize(10).fontColor(this.palette.textSecondary)
                Text('0ms').fontSize(10).fontColor(this.palette.textSecondary)
              }.height(60).justifyContent(FlexAlign.SpaceBetween).margin({ left: 8 })
            }.width('100%')
          }
        } else if (this.pingRunning) {
          Row({ space: 8 }) {
            LoadingProgress().width(16).height(16).color(this.palette.accent)
            Text('正在连接…').fontSize(13).fontColor(this.palette.textSecondary)
          }.width('100%')
        } else {
          Text('点击 ▶ 开始 Ping 测试')
            .fontSize(13).fontColor(this.palette.textSecondary).width('100%')
        }
      }.width('100%').padding(16).borderRadius(12).backgroundColor(this.palette.surfaceElevated)
    }.width('100%')
  }

  @Builder
  taildropSendSection() {
    Column() {
      Text('Taildrop').fontSize(14).fontColor(this.palette.accent)
        .margin({ bottom: 8, left: 16 })

      // 发送区域：点击选择文件
      Column() {
        Text('📤').fontSize(24).fontColor(this.palette.textSecondary)
        Text('点击选择文件发送')
          .fontSize(14).fontColor(this.palette.textSecondary)
          .textAlign(TextAlign.Center)
      }.width('100%').padding({ left: 16, right: 16, top: 24, bottom: 24 })
      .borderRadius(12).backgroundColor(this.palette.surfaceElevated)
      .onClick(() => this.selectFilesForTaildrop())

      // 已选择的文件列表
      if (this.taildropSelectedFiles.length > 0) {
        Column({ space: 8 }) {
          ForEach(this.taildropSelectedFiles, (file: TaildropSendFileInfo, index: number) => {
            Row({ space: 8 }) {
              Column({ space: 2 }) {
                Text(file.name).fontSize(14).fontColor(this.palette.textPrimary).maxLines(1)
                if (file.size > 0) {
                  Text(this.formatBytes(file.size)).fontSize(12).fontColor(this.palette.textSecondary)
                }
              }.layoutWeight(1).alignItems(HorizontalAlign.Start)
              Button('×').fontSize(14).width(28).height(28)
                .backgroundColor(Color.Transparent).fontColor(this.palette.danger)
                .onClick(() => {
                  this.taildropSelectedFiles =
                    this.taildropSelectedFiles.filter((f: TaildropSendFileInfo) => f.uri !== file.uri)
                })
            }.width('100%').padding({ left: 16, right: 16, top: 10, bottom: 10 })
            if (index < this.taildropSelectedFiles.length - 1) {
              Divider().color(this.palette.border).margin({ left: 16, right: 16 })
            }
          }, (file: TaildropSendFileInfo) => file.uri)

          // 发送 / 清除按钮
          Row({ space: 12 }) {
            Button('发送').fontSize(14).height(36).backgroundColor(this.palette.accent)
              .fontColor(this.palette.badgeText).layoutWeight(1)
              .enabled(!this.taildropSending)
              .onClick(() => this.sendTaildropFiles())
            Button('清除').fontSize(14).height(36).backgroundColor(this.palette.surfaceMuted)
              .fontColor(this.palette.textPrimary).layoutWeight(1)
              .onClick(() => this.clearTaildropSelectedFiles())
          }.width('100%').margin({ top: 8 })
        }.width('100%').borderRadius(12).backgroundColor(this.palette.surfaceElevated)
        .margin({ top: 8 })
      }
    }.width('100%')
  }

  @Builder
  detailsSection(peer: TailscalePeer) {
    Column() {
      Text('Details').fontSize(14).fontColor(this.palette.accent)
        .margin({ bottom: 8, left: 16 })

      Column({ space: 12 }) {
        // Key Expiry
        Row() {
          Text('密钥有效期').fontSize(14).fontColor(this.palette.textSecondary).width(100)
          Text(this.keyExpiryText(peer))
            .fontSize(14).fontColor(peer.expired ? this.palette.danger : this.palette.textPrimary)
            .layoutWeight(1).textAlign(TextAlign.End)
        }.width('100%')

        // OS
        if (peer.os.length > 0) {
          Row() {
            Text('OS').fontSize(14).fontColor(this.palette.textSecondary).width(100)
            Text(peer.os).fontSize(14).fontColor(this.palette.textPrimary)
              .layoutWeight(1).textAlign(TextAlign.End)
          }.width('100%')
        }

        // Last Seen（离线时显示）
        if (!peer.online && peer.lastSeen > 0) {
          Row() {
            Text('上次在线').fontSize(14).fontColor(this.palette.textSecondary).width(100)
            Text(this.relativeTime(peer.lastSeen))
              .fontSize(14).fontColor(this.palette.textPrimary)
              .layoutWeight(1).textAlign(TextAlign.End)
          }.width('100%')
        }

        // Exit Node
        if (peer.exitNode) {
          Row() {
            Text('Exit node').fontSize(14).fontColor(this.palette.textSecondary).width(100)
            Text('Active').fontSize(14).fontColor(this.palette.textPrimary)
              .layoutWeight(1).textAlign(TextAlign.End)
          }.width('100%')
        } else if (peer.exitNodeOption) {
          Row() {
            Text('Exit node').fontSize(14).fontColor(this.palette.textSecondary).width(100)
            Text('Available').fontSize(14).fontColor(this.palette.textPrimary)
              .layoutWeight(1).textAlign(TextAlign.End)
          }.width('100%')
        }

        // Shared in
        if (peer.shareeNode) {
          Row() {
            Text('Shared in').fontSize(14).fontColor(this.palette.textSecondary).width(100)
            Text('Yes').fontSize(14).fontColor(this.palette.textPrimary)
              .layoutWeight(1).textAlign(TextAlign.End)
          }.width('100%')
        }

        // SSH
        if (peer.sshHostKeys !== null && peer.sshHostKeys !== undefined &&
            peer.sshHostKeys.length > 0) {
          if (!peer.online || this.selectedPeerIsSelf ||
              peer.tailscaleIPs === null || peer.tailscaleIPs === undefined ||
              peer.tailscaleIPs.length === 0) {
            Row() {
              Text('SSH').fontSize(14).fontColor(this.palette.textSecondary).width(100)
              Text('Available').fontSize(14).fontColor(this.palette.textPrimary)
                .layoutWeight(1).textAlign(TextAlign.End)
            }.width('100%')
          }
        }
      }.width('100%').padding(16).borderRadius(12).backgroundColor(this.palette.surfaceElevated)
    }.width('100%')
  }

  // SSH 连接功能暂未实现（需要终端模拟器组件支持），入口已隐藏
  // @Builder
  // sshConnectSection() { ... }

  // ═══════════════════════════════════════════════════════════════
  // 视图3：Exit Node 选择页（对齐 Android TailscaleExitNodePickerScreen）
  // ═══════════════════════════════════════════════════════════════

  @Builder
  exitNodePickerView() {
    if (this.selectedEndpoint !== null) {
      Column() {
        // 搜索框
        TextInput({ text: this.exitNodeSearchText, placeholder: '搜索' })
          .width('100%').margin({ left: 16, right: 16, top: 8, bottom: 8 })
          .onChange((value: string) => { this.exitNodeSearchText = value })

        Scroll() {
          Column() {
            // Disabled 选项
            Row() {
              Text('不使用出口节点').fontSize(15).fontColor(this.palette.textPrimary).layoutWeight(1)
              if (this.selectedEndpoint!.exitNode === null) {
                Text('✓').fontSize(16).fontColor(this.palette.accent)
              }
            }.width('100%').padding({ left: 16, right: 16, top: 14, bottom: 14 })
            .onClick(() => this.setExitNode(''))

            Divider().color(this.palette.border).margin({ left: 16, right: 16 })

            // 候选 Peer 列表
            ForEach(this.filteredExitNodeCandidates(this.selectedEndpoint!),
              (peer: TailscalePeer) => {
                Row({ space: 12 }) {
                  Circle({ width: 8, height: 8 })
                    .fill(peer.online ? this.palette.online : this.palette.offline)
                  Column({ space: 2 }) {
                    Text(this.peerDisplayName(peer)).fontSize(15).fontColor(this.palette.textPrimary)
                    if (peer.tailscaleIPs !== null && peer.tailscaleIPs !== undefined &&
                        peer.tailscaleIPs.length > 0) {
                      Text(peer.tailscaleIPs[0]).fontSize(13).fontColor(this.palette.textSecondary)
                    }
                  }.layoutWeight(1).alignItems(HorizontalAlign.Start)
                  if (this.selectedEndpoint!.exitNode !== null &&
                      this.selectedEndpoint!.exitNode!.stableID === peer.stableID) {
                    Text('✓').fontSize(16).fontColor(this.palette.accent)
                  }
                }.width('100%').padding({ left: 16, right: 16, top: 12, bottom: 12 })
                .onClick(() => this.setExitNode(peer.stableID))
              }, (peer: TailscalePeer) => peer.stableID)
          }.width('100%')
        }.layoutWeight(1)
      }.width('100%').layoutWeight(1)
    } else {
      Column() {
        Text('加载中…').fontSize(14).fontColor(this.palette.textSecondary)
      }.layoutWeight(1).justifyContent(FlexAlign.Center)
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 视图4：Taildrop 收件箱页（对齐 Android TaildropInboxScreen）
  // ═══════════════════════════════════════════════════════════════

  @Builder
  taildropInboxView() {
    Scroll() {
      Column({ space: 16 }) {
        // 正在接收的文件
        if (this.taildropInbox.receiving.length > 0) {
          Column() {
            Text('正在接收').fontSize(14).fontColor(this.palette.accent)
              .margin({ bottom: 8, left: 16 })
            Column() {
              ForEach(this.taildropInbox.receiving, (file: TaildropReceivingFile, index: number) => {
                if (index > 0) {
                  Divider().color(this.palette.border).margin({ left: 16, right: 16 })
                }
                Row({ space: 8 }) {
                  Column({ space: 2 }) {
                    Text(file.name).fontSize(14).fontColor(this.palette.textPrimary)
                    Text(`${this.formatBytes(file.receivedBytes)} / ${this.formatBytes(file.size)}`)
                      .fontSize(12).fontColor(this.palette.textSecondary)
                  }.layoutWeight(1).alignItems(HorizontalAlign.Start)
                  Progress({ value: file.receivedBytes, total: file.size, type: ProgressType.Linear })
                    .width(60).color(this.palette.blue)
                  Button('取消').fontSize(12).height(28).backgroundColor(this.palette.dangerSoft)
                    .fontColor(this.palette.danger)
                    .onClick(() => this.cancelTaildropReceive(file.senderID, file.name))
                }.width('100%').padding({ left: 16, right: 16, top: 12, bottom: 12 })
              }, (file: TaildropReceivingFile) => file.name)
            }.width('100%').borderRadius(12).backgroundColor(this.palette.surfaceElevated)
          }.width('100%')
        }

        // 已接收的文件
        if (this.taildropInbox.files.length > 0) {
          Column() {
            Row() {
              Text('已接收文件').fontSize(14).fontColor(this.palette.accent).layoutWeight(1)
              Button('全部已读').fontSize(12).height(28).backgroundColor(this.palette.surfaceMuted)
                .fontColor(this.palette.textPrimary).onClick(() => this.markTaildropRead())
            }.width('100%').margin({ bottom: 8, left: 16, right: 16 })

            Column() {
              ForEach(this.taildropInbox.files, (file: TaildropFile, index: number) => {
                if (index > 0) {
                  Divider().color(this.palette.border).margin({ left: 16, right: 16 })
                }
                Row({ space: 8 }) {
                  Column({ space: 4 }) {
                    Text(file.name).fontSize(14).fontColor(this.palette.textPrimary).maxLines(2)
                    Row({ space: 4 }) {
                      Text(this.formatBytes(file.size)).fontSize(12).fontColor(this.palette.textSecondary)
                      if (file.senderName.length > 0) {
                        Text('来自 ' + file.senderName).fontSize(12).fontColor(this.palette.textSecondary)
                      }
                      if (file.modifiedAt > 0) {
                        Text(this.relativeTime(file.modifiedAt)).fontSize(12).fontColor(this.palette.textSecondary)
                      }
                    }
                  }.layoutWeight(1).alignItems(HorizontalAlign.Start)
                  Button('下载').fontSize(12).height(28).backgroundColor(this.palette.accentSoft)
                    .fontColor(this.palette.textPrimary)
                    .onClick(() => this.downloadTaildropFile(file.name))
                  Button('删除').fontSize(12).height(28).backgroundColor(this.palette.dangerSoft)
                    .fontColor(this.palette.danger)
                    .onClick(() => this.deleteTaildropFile(file.name))
                }.width('100%').padding({ left: 16, right: 16, top: 12, bottom: 12 })
              }, (file: TaildropFile) => file.name)
            }.width('100%').borderRadius(12).backgroundColor(this.palette.surfaceElevated)
          }.width('100%')
        }

        // 空状态
        if (this.taildropInbox.files.length === 0 && this.taildropInbox.receiving.length === 0) {
          Column() {
            Text('没有收到文件').fontSize(14).fontColor(this.palette.textSecondary)
          }.width('100%').padding(32).justifyContent(FlexAlign.Center)
          .alignItems(HorizontalAlign.Center)
        }
      }.width('100%').padding({ left: 16, right: 16, top: 8, bottom: 32 })
    }.layoutWeight(1)
  }
}
