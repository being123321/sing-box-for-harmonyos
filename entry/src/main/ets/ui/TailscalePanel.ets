import { AppPalette, LIGHT_PALETTE } from './DesignSystem'
import { hilog } from '@kit.PerformanceAnalysisKit'
import type {
  TailscaleStatusUpdate,
  TailscaleEndpointStatus,
  TailscalePeer,
  TaildropInbox,
  TaildropFile,
  TaildropReceivingFile,
  TailscalePingResult,
  TailscaleCoordinator
} from '../domain/TailscaleTypes'

const TS_TAG: string = 'TailscalePanel'
const TS_DOMAIN: number = 0xA00000

@Component
export struct TailscalePanel {
  @Prop palette: AppPalette = LIGHT_PALETTE
  @Prop coordinator: TailscaleCoordinator | null = null
  @State tailscaleStatus: TailscaleStatusUpdate = { endpoints: [] }
  @State taildropInbox: TaildropInbox = { endpointTag: '', files: [], receiving: [] }
  @State pingResults: TailscalePingResult[] = []
  @State pingPeerIP: string = ''
  @State selectedEndpointTag: string = ''
  @State selectedEndpoint: TailscaleEndpointStatus = {
    endpointTag: '', backendState: '', stateText: '', authURL: '',
    networkName: '', magicDNSSuffix: '', self: null, exitNode: null,
    keyAuth: false, canShareFiles: false, waitingFileCount: 0,
    receivingFileCount: 0, unreadFileCount: 0, userGroups: []
  }
  @State showEndpointDetail: boolean = false
  @State showExitNodePicker: boolean = false
  @State showTaildropInbox: boolean = false
  @State showPingPanel: boolean = false
  @State tailscaleLoading: boolean = false
  @State tailscaleError: string = ''
  @State taildropLoading: boolean = false
  @State pingLoading: boolean = false
  private pollTimer: number = -1

  aboutToAppear() {
    this.pollTimer = setInterval(() => {
      this.refreshTailscaleStatus()
      if (this.selectedEndpointTag.length > 0 && this.showTaildropInbox) {
        this.refreshTaildropInbox()
      }
    }, 500)
  }

  aboutToDisappear() {
    if (this.pollTimer !== -1) {
      clearInterval(this.pollTimer)
      this.pollTimer = -1
    }
  }

  /**
   * Status comes exclusively from the VPN extension through the dedicated IPC
   * channel (ConnectionCoordinator). The UI process intentionally does not
   * create its own libbox/CommandClient: libbox.Setup mutates process-global
   * paths that the node-probe worker also writes, which would silently move
   * command.sock resolution out from under the subscription.
   */
  private async refreshTailscaleStatus(): Promise<void> {
    if (this.tailscaleLoading || this.coordinator === null) return
    this.tailscaleLoading = true
    try {
      this.tailscaleStatus = await this.coordinator.tailscaleStatus()
      this.tailscaleError = ''
      if (this.selectedEndpointTag.length === 0 && this.tailscaleStatus.endpoints.length > 0) {
        this.selectedEndpointTag = this.tailscaleStatus.endpoints[0].endpointTag
      }
      if (this.selectedEndpointTag.length > 0) {
        for (const ep of this.tailscaleStatus.endpoints) {
          if (ep.endpointTag === this.selectedEndpointTag) {
            this.selectedEndpoint = ep
            break
          }
        }
      }
    } catch (err) {
      this.tailscaleError = err instanceof Error ? err.message : '获取 Tailscale 状态失败'
      hilog.error(TS_DOMAIN, TS_TAG, 'refreshStatus error: %{public}s', this.tailscaleError)
    } finally {
      this.tailscaleLoading = false
    }
  }

  private async refreshTaildropInbox(): Promise<void> {
    if (this.taildropLoading || this.selectedEndpointTag.length === 0 || this.coordinator === null) return
    this.taildropLoading = true
    try {
      this.taildropInbox = await this.coordinator.taildropInbox(this.selectedEndpointTag)
    } catch (err) {
    } finally {
      this.taildropLoading = false
    }
  }

  private async subscribeTaildrop(): Promise<void> {
    if (this.selectedEndpointTag.length === 0 || this.coordinator === null) return
    try {
      await this.coordinator.taildropSubscribe(this.selectedEndpointTag)
      this.refreshTaildropInbox()
    } catch (err) {
      this.tailscaleError = err instanceof Error ? err.message : '订阅 Taildrop 失败'
    }
  }

  private async setExitNode(stableID: string): Promise<void> {
    if (this.selectedEndpointTag.length === 0 || this.coordinator === null) return
    try {
      await this.coordinator.tailscaleSetExitNode(this.selectedEndpointTag, stableID)
      this.showExitNodePicker = false
      this.refreshTailscaleStatus()
    } catch (err) {
      this.tailscaleError = err instanceof Error ? err.message : '设置 Exit Node 失败'
    }
  }

  private async logoutTailscale(): Promise<void> {
    if (this.selectedEndpointTag.length === 0 || this.coordinator === null) return
    try {
      await this.coordinator.tailscaleLogout(this.selectedEndpointTag)
      this.refreshTailscaleStatus()
    } catch (err) {
      this.tailscaleError = err instanceof Error ? err.message : '登出 Tailscale 失败'
    }
  }

  private async runPing(): Promise<void> {
    if (this.selectedEndpointTag.length === 0 || this.pingPeerIP.length === 0 || this.coordinator === null) return
    this.pingLoading = true
    this.pingResults = []
    try {
      this.pingResults = await this.coordinator.tailscalePing(this.selectedEndpointTag, this.pingPeerIP)
    } catch (err) {
      this.tailscaleError = err instanceof Error ? err.message : 'Ping 失败'
    } finally {
      this.pingLoading = false
    }
  }

  private async downloadTaildropFile(fileName: string): Promise<void> {
    if (this.selectedEndpointTag.length === 0 || this.coordinator === null) return
    try {
      await this.coordinator.taildropDownload(this.selectedEndpointTag, fileName)
      this.refreshTaildropInbox()
    } catch (err) {
      this.tailscaleError = err instanceof Error ? err.message : '下载文件失败'
    }
  }

  private async deleteTaildropFile(fileName: string): Promise<void> {
    if (this.selectedEndpointTag.length === 0 || this.coordinator === null) return
    try {
      await this.coordinator.taildropDelete(this.selectedEndpointTag, fileName)
      this.refreshTaildropInbox()
    } catch (err) {
      this.tailscaleError = err instanceof Error ? err.message : '删除文件失败'
    }
  }

  private async markTaildropRead(): Promise<void> {
    if (this.selectedEndpointTag.length === 0 || this.coordinator === null) return
    try {
      await this.coordinator.taildropMarkRead(this.selectedEndpointTag)
      this.refreshTaildropInbox()
    } catch (err) {
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
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
    return this.allPeers(endpoint).filter((peer: TailscalePeer) => peer.exitNodeOption && peer.online)
  }

  private statusColor(state: string): string {
    if (state === 'Running') return '#4CAF50'
    if (state === 'NeedsLogin' || state === 'NeedsMachineAuth') return '#FF9800'
    if (state === 'Starting') return '#FFEB3B'
    return '#9E9E9E'
  }

  build() {
    Column({ space: 12 }) {
      if (this.tailscaleError.length > 0) {
        Row() {
          Text(this.tailscaleError).fontSize(13).fontColor(this.palette.danger).layoutWeight(1)
          Button('清除').fontSize(12).height(28).backgroundColor(this.palette.dangerSoft)
            .fontColor(this.palette.danger).onClick(() => { this.tailscaleError = '' })
        }.width('100%').padding(12).borderRadius(8).backgroundColor(this.palette.dangerSoft)
      }

      if (this.tailscaleStatus.endpoints.length === 0) {
        Column({ space: 8 }) {
          Text('Tailscale 未配置').fontSize(16).fontColor(this.palette.textPrimary)
          Text('在 sing-box 配置中添加 Tailscale endpoint 后，此处将显示网络状态。')
            .fontSize(13).fontColor(this.palette.textSecondary)
        }.width('100%').padding(24).alignItems(HorizontalAlign.Center)
        .backgroundColor(this.palette.surfaceElevated).borderRadius(12)
      }

      if (!this.showEndpointDetail) {
        ForEach(this.tailscaleStatus.endpoints, (endpoint: TailscaleEndpointStatus) => {
          this.endpointListItem(endpoint)
        }, (endpoint: TailscaleEndpointStatus) => endpoint.endpointTag)
      } else {
        this.endpointDetailView()
      }
    }.width('100%')
  }

  @Builder
  endpointListItem(endpoint: TailscaleEndpointStatus) {
    Row({ space: 12 }) {
      // Status indicator dot
      Circle({ width: 10, height: 10 })
        .fill(this.statusColor(endpoint.backendState))

      Column({ space: 4 }) {
        Text(endpoint.endpointTag === 'default' ? 'Tailscale' : `Tailscale (${endpoint.endpointTag})`)
          .fontSize(16).fontColor(this.palette.textPrimary)
        if (endpoint.backendState === 'Running' && endpoint.self !== null) {
          Text(endpoint.self.hostName).fontSize(13).fontColor(this.palette.textSecondary)
        } else {
          Text(endpoint.stateText || endpoint.backendState).fontSize(13).fontColor(this.palette.textSecondary)
        }
      }.layoutWeight(1).alignItems(HorizontalAlign.Start)

      // Unread file badge
      if (endpoint.unreadFileCount > 0) {
        Text(`${endpoint.unreadFileCount}`)
          .fontSize(11).fontColor('#FFFFFF')
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
          .borderRadius(10).backgroundColor(this.palette.accent)
      }

      // Right arrow
      Text('>').fontSize(14).fontColor(this.palette.textTertiary)
    }.width('100%').padding(16).borderRadius(12).backgroundColor(this.palette.surfaceElevated)
    .onClick(() => {
      hilog.info(TS_DOMAIN, TS_TAG, 'onClick endpoint: tag=%{public}s state=%{public}s', endpoint.endpointTag, endpoint.backendState)
      this.selectedEndpointTag = endpoint.endpointTag
      this.selectedEndpoint = endpoint
      this.showEndpointDetail = true
      hilog.info(TS_DOMAIN, TS_TAG, 'onClick: showEndpointDetail set to true')
    })
  }

  @Builder
  endpointDetailView() {
    Column({ space: 12 }) {
      // Back button + title
      Row({ space: 8 }) {
        Button('< 返回').fontSize(14).height(32).backgroundColor(this.palette.surfaceMuted)
          .fontColor(this.palette.textPrimary).onClick(() => {
            hilog.info(TS_DOMAIN, TS_TAG, 'back button clicked')
            this.showEndpointDetail = false
            this.showExitNodePicker = false
            this.showTaildropInbox = false
            this.showPingPanel = false
          })
        Text(this.selectedEndpointTag === 'default' ? 'Tailscale' : `Tailscale (${this.selectedEndpointTag})`)
          .fontSize(18).fontColor(this.palette.textPrimary).layoutWeight(1)
      }.width('100%')

      // Render the selected endpoint directly — no ForEach+if
      if (this.selectedEndpoint.endpointTag.length > 0) {
        this.statusCard(this.selectedEndpoint)
        this.actionButtons()
        if (this.showExitNodePicker) {
          this.exitNodePickerSection(this.selectedEndpoint)
        }
        if (this.showTaildropInbox) {
          this.taildropInboxSection()
        }
        if (this.showPingPanel) {
          this.pingPanelSection()
        }
        this.peerListSection(this.selectedEndpoint)
      }
    }.width('100%')
  }

  @Builder
  statusCard(endpoint: TailscaleEndpointStatus) {
    Column({ space: 10 }) {
      // State row
      Row({ space: 8 }) {
        Circle({ width: 10, height: 10 }).fill(this.statusColor(endpoint.backendState))
        Text(endpoint.stateText || endpoint.backendState).fontSize(15).fontColor(this.palette.textPrimary)
          .layoutWeight(1)
      }.width('100%')

      // Self device info
      if (endpoint.self !== null && endpoint.backendState === 'Running') {
        Row({ space: 8 }) {
          Text('本机').fontSize(13).fontColor(this.palette.textSecondary).width(60)
          Text(endpoint.self.hostName || '').fontSize(13).fontColor(this.palette.textPrimary).layoutWeight(1)
          if (endpoint.self.tailscaleIPs !== null && endpoint.self.tailscaleIPs !== undefined &&
            endpoint.self.tailscaleIPs.length > 0) {
            Text(endpoint.self.tailscaleIPs[0]).fontSize(12).fontColor(this.palette.textTertiary)
          }
        }.width('100%')
      }

      // Network info
      if (endpoint.networkName.length > 0) {
        Row({ space: 8 }) {
          Text('网络').fontSize(13).fontColor(this.palette.textSecondary).width(60)
          Text(endpoint.networkName).fontSize(13).fontColor(this.palette.textPrimary).layoutWeight(1)
        }.width('100%')
      }

      // MagicDNS
      if (endpoint.magicDNSSuffix.length > 0) {
        Row({ space: 8 }) {
          Text('MagicDNS').fontSize(13).fontColor(this.palette.textSecondary).width(60)
          Text(endpoint.magicDNSSuffix).fontSize(13).fontColor(this.palette.textPrimary).layoutWeight(1)
        }.width('100%')
      }

      // Exit node info
      if (endpoint.exitNode !== null) {
        Row({ space: 8 }) {
          Text('Exit Node').fontSize(13).fontColor(this.palette.textSecondary).width(60)
          Text(endpoint.exitNode.hostName || '').fontSize(13).fontColor(this.palette.textPrimary).layoutWeight(1)
        }.width('100%')
      }

      // Taildrop info
      if (endpoint.waitingFileCount > 0 || endpoint.receivingFileCount > 0) {
        Row({ space: 8 }) {
          Text('Taildrop').fontSize(13).fontColor(this.palette.textSecondary).width(60)
          Text(`${endpoint.waitingFileCount} 个文件`).fontSize(13).fontColor(this.palette.textPrimary).layoutWeight(1)
        }.width('100%')
      }

      // Auth URL
      if (endpoint.authURL.length > 0) {
        Column({ space: 4 }) {
          Text('需要登录 — 在浏览器中打开以下链接完成认证：').fontSize(13).fontColor(this.palette.warning)
          Text(endpoint.authURL).fontSize(12).fontColor(this.palette.blue).copyOption(CopyOptions.InApp)
        }.width('100%').padding(8).borderRadius(8).backgroundColor(this.palette.warningSoft)
      }

      // Logout button
      Row() {
        Blank()
        Button('登出').fontSize(12).height(28).backgroundColor(this.palette.dangerSoft)
          .fontColor(this.palette.danger).onClick(() => this.logoutTailscale())
      }.width('100%')
    }.width('100%').padding(16).borderRadius(12).backgroundColor(this.palette.surfaceElevated)
  }

  @Builder
  actionButtons() {
    Row({ space: 8 }) {
      Button('Exit Node').fontSize(13).height(36).backgroundColor(this.palette.accentSoft)
        .fontColor(this.palette.textPrimary).onClick(() => {
          this.showExitNodePicker = !this.showExitNodePicker
          this.showTaildropInbox = false
          this.showPingPanel = false
        })
      Button('Taildrop').fontSize(13).height(36).backgroundColor(this.palette.accentSoft)
        .fontColor(this.palette.textPrimary).onClick(() => {
          this.showTaildropInbox = !this.showTaildropInbox
          this.showExitNodePicker = false
          this.showPingPanel = false
          if (this.showTaildropInbox) { this.subscribeTaildrop() }
        })
      Button('Ping').fontSize(13).height(36).backgroundColor(this.palette.accentSoft)
        .fontColor(this.palette.textPrimary).onClick(() => {
          this.showPingPanel = !this.showPingPanel
          this.showExitNodePicker = false
          this.showTaildropInbox = false
        })
    }.width('100%')
  }

  @Builder
  exitNodePickerSection(endpoint: TailscaleEndpointStatus) {
    Column({ space: 8 }) {
      Text('选择 Exit Node').fontSize(16).fontColor(this.palette.textPrimary).width('100%')

      // Clear option
      Row({ space: 8 }) {
        Circle({ width: 8, height: 8 }).fill('#9E9E9E')
        Text('无 Exit Node').fontSize(14).fontColor(this.palette.textPrimary).layoutWeight(1)
        Button('清除').fontSize(12).height(28).backgroundColor(this.palette.surfaceMuted)
          .fontColor(this.palette.textPrimary).onClick(() => this.setExitNode(''))
      }.width('100%').padding({ top: 8, bottom: 8 })

      ForEach(this.exitNodeCandidates(endpoint), (peer: TailscalePeer) => {
        Row({ space: 8 }) {
          Circle({ width: 8, height: 8 }).fill(peer.online ? '#4CAF50' : '#9E9E9E')
          Column({ space: 2 }) {
            Text(peer.hostName || '').fontSize(14).fontColor(this.palette.textPrimary)
            if (peer.tailscaleIPs !== null && peer.tailscaleIPs !== undefined &&
              peer.tailscaleIPs.length > 0) {
              Text(peer.tailscaleIPs[0]).fontSize(11).fontColor(this.palette.textTertiary)
            }
          }.layoutWeight(1).alignItems(HorizontalAlign.Start)
          Button('选择').fontSize(12).height(28).backgroundColor(this.palette.accentSoft)
            .fontColor(this.palette.textPrimary).onClick(() => this.setExitNode(peer.stableID))
        }.width('100%').padding({ top: 8, bottom: 8 })
      }, (peer: TailscalePeer) => peer.stableID)
    }.width('100%').padding(16).borderRadius(12).backgroundColor(this.palette.surfaceElevated)
  }

  @Builder
  taildropInboxSection() {
    Column({ space: 8 }) {
      Row() {
        Text('Taildrop 收件箱').fontSize(16).fontColor(this.palette.textPrimary).layoutWeight(1)
        if (this.taildropInbox.files.length > 0) {
          Button('全部已读').fontSize(12).height(28).backgroundColor(this.palette.surfaceMuted)
            .fontColor(this.palette.textPrimary).onClick(() => this.markTaildropRead())
        }
      }.width('100%')

      if (this.taildropInbox.files.length === 0 && this.taildropInbox.receiving.length === 0) {
        Text('没有收到文件').fontSize(13).fontColor(this.palette.textTertiary).width('100%')
          .textAlign(TextAlign.Center).padding(16)
      }

      ForEach(this.taildropInbox.files, (file: TaildropFile) => {
        Row({ space: 8 }) {
          Column({ space: 2 }) {
            Text(file.name).fontSize(14).fontColor(this.palette.textPrimary)
            Row({ space: 4 }) {
              Text(this.formatBytes(file.size)).fontSize(11).fontColor(this.palette.textTertiary)
              Text('来自 ' + file.senderName).fontSize(11).fontColor(this.palette.textTertiary)
            }
          }.layoutWeight(1).alignItems(HorizontalAlign.Start)
          Button('下载').fontSize(12).height(28).backgroundColor(this.palette.accentSoft)
            .fontColor(this.palette.textPrimary).onClick(() => this.downloadTaildropFile(file.name))
          Button('删除').fontSize(12).height(28).backgroundColor(this.palette.dangerSoft)
            .fontColor(this.palette.danger).onClick(() => this.deleteTaildropFile(file.name))
        }.width('100%').padding({ top: 8, bottom: 8 })
      }, (file: TaildropFile) => file.name)

      ForEach(this.taildropInbox.receiving, (file: TaildropReceivingFile) => {
        Row({ space: 8 }) {
          Column({ space: 2 }) {
            Text(file.name).fontSize(14).fontColor(this.palette.textPrimary)
            Text(`${this.formatBytes(file.receivedBytes)} / ${this.formatBytes(file.size)}`)
              .fontSize(11).fontColor(this.palette.textTertiary)
          }.layoutWeight(1).alignItems(HorizontalAlign.Start)
          Progress({ value: file.receivedBytes, total: file.size, type: ProgressType.Linear })
            .width(60).color(this.palette.blue)
        }.width('100%').padding({ top: 8, bottom: 8 })
      }, (file: TaildropReceivingFile) => file.name)
    }.width('100%').padding(16).borderRadius(12).backgroundColor(this.palette.surfaceElevated)
  }

  @Builder
  pingPanelSection() {
    Column({ space: 8 }) {
      Text('Ping 测试').fontSize(16).fontColor(this.palette.textPrimary).width('100%')

      Row({ space: 8 }) {
        TextInput({ text: this.pingPeerIP, placeholder: 'Peer IP 地址' })
          .layoutWeight(1).onChange((value: string) => { this.pingPeerIP = value })
        Button('Ping').fontSize(13).height(36).backgroundColor(this.palette.accentSoft)
          .fontColor(this.palette.textPrimary).enabled(!this.pingLoading)
          .onClick(() => this.runPing())
      }.width('100%')

      ForEach(this.pingResults, (result: TailscalePingResult, index: number) => {
        Row({ space: 8 }) {
          Text(`#${index + 1}`).fontSize(12).fontColor(this.palette.textTertiary).width(30)
          if (result.error.length > 0) {
            Text(result.error).fontSize(13).fontColor(this.palette.danger).layoutWeight(1)
          } else {
            Column({ space: 2 }) {
              Text(`${result.latencyMs.toFixed(1)} ms`).fontSize(13).fontColor(this.palette.textPrimary)
              Text(result.isDirect ? '直连' : `经 ${result.peerRelay || result.derpRegionCode}`)
                .fontSize(11).fontColor(result.isDirect ? this.palette.blue : this.palette.textTertiary)
            }.layoutWeight(1).alignItems(HorizontalAlign.Start)
          }
        }.width('100%').padding({ top: 6, bottom: 6 })
      }, (result: TailscalePingResult, index: number) => `${index}-${result.endpoint}`)
    }.width('100%').padding(16).borderRadius(12).backgroundColor(this.palette.surfaceElevated)
  }

  @Builder
  peerListSection(endpoint: TailscaleEndpointStatus) {
    Column({ space: 8 }) {
      Text('Peer 列表').fontSize(16).fontColor(this.palette.textPrimary).width('100%')

      ForEach(this.allPeers(endpoint), (peer: TailscalePeer) => {
        Row({ space: 8 }) {
          Circle({ width: 8, height: 8 })
            .fill(peer.online ? '#4CAF50' : '#9E9E9E')

          Column({ space: 2 }) {
            Text(peer.hostName || '').fontSize(14).fontColor(this.palette.textPrimary)
            if (peer.dnsName !== null && peer.dnsName !== undefined && peer.dnsName.length > 0) {
              Text(peer.dnsName).fontSize(11).fontColor(this.palette.textTertiary)
            }
            if (peer.tailscaleIPs !== null && peer.tailscaleIPs !== undefined &&
              peer.tailscaleIPs.length > 0) {
              Text(peer.tailscaleIPs[0]).fontSize(11).fontColor(this.palette.textTertiary)
            }
          }.layoutWeight(1).alignItems(HorizontalAlign.Start)

          if (peer.exitNode) {
            Text('Exit').fontSize(10).fontColor(this.palette.blue)
              .padding({ left: 6, right: 6, top: 2, bottom: 2 }).borderRadius(4)
              .backgroundColor(this.palette.blueSoft)
          }

          if (peer.os !== null && peer.os !== undefined && peer.os.length > 0) {
            Text(peer.os).fontSize(10).fontColor(this.palette.textTertiary)
          }

        }.width('100%').padding({ top: 8, bottom: 8 })
      }, (peer: TailscalePeer) => peer.stableID)
    }.width('100%').padding(16).borderRadius(12).backgroundColor(this.palette.surfaceElevated)
  }
}