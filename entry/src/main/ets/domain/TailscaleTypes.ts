// ─────────────────────────────────────────────────────────────────────────────
// TailscaleTypes — 纯类型定义和接口，无任何模块副作用。
// TailscalePanel 只依赖此文件，避免加载 CoreGateway (libentry.so) 或
// ConnectionCoordinator (vpnExtension) 等在 UI 进程中不可用的模块。
// ─────────────────────────────────────────────────────────────────────────────

export interface TailscalePeer {
  stableID: string
  hostName: string
  dnsName: string
  os: string
  tailscaleIPs: string[]
  sshHostKeys: string[]
  online: boolean
  exitNode: boolean
  exitNodeOption: boolean
  shareeNode: boolean
  expired: boolean
  active: boolean
  canReceiveFiles: boolean
  rxBytes: number
  txBytes: number
  keyExpiry: number
  lastSeen: number
}

export interface TailscaleUserGroup {
  userID: number
  loginName: string
  displayName: string
  profilePicURL: string
  peers: TailscalePeer[]
}

export interface TailscaleEndpointStatus {
  endpointTag: string
  backendState: string
  stateText: string
  authURL: string
  networkName: string
  magicDNSSuffix: string
  self: TailscalePeer | null
  exitNode: TailscalePeer | null
  keyAuth: boolean
  canShareFiles: boolean
  waitingFileCount: number
  receivingFileCount: number
  unreadFileCount: number
  userGroups: TailscaleUserGroup[]
}

export interface TailscaleStatusUpdate {
  endpoints: TailscaleEndpointStatus[]
}

export interface TaildropFile {
  name: string
  size: number
  senderName: string
  modifiedAt: number
}

export interface TaildropReceivingFile {
  name: string
  size: number
  receivedBytes: number
  senderID: string
  senderName: string
}

export interface TaildropSendFile {
  name: string
  size: number
}

export interface TaildropInbox {
  endpointTag: string
  files: TaildropFile[]
  receiving: TaildropReceivingFile[]
}

export interface TailscalePingResult {
  latencyMs: number
  isDirect: boolean
  endpoint: string
  peerRelay: string
  derpRegionID: number
  derpRegionCode: string
  error: string
}

/**
 * Interface that ConnectionCoordinator implements. TailscalePanel depends on
 * this interface instead of the concrete ConnectionCoordinator class, so it
 * never needs to import the ConnectionCoordinator module (which depends on
 * vpnExtension from @kit.NetworkKit, unavailable in the UI process).
 */
export interface TailscaleCoordinator {
  tailscaleStatus(): Promise<TailscaleStatusUpdate>
  tailscaleSetExitNode(endpointTag: string, stableID: string): Promise<void>
  tailscaleLogout(endpointTag: string): Promise<void>
  tailscalePing(endpointTag: string, peerIP: string): Promise<TailscalePingResult[]>
  taildropSubscribe(endpointTag: string): Promise<void>
  taildropInbox(endpointTag: string): Promise<TaildropInbox>
  taildropDownload(endpointTag: string, name: string): Promise<void>
  taildropDelete(endpointTag: string, name: string): Promise<void>
  taildropMarkRead(endpointTag: string): Promise<void>
  taildropCancelReceive(endpointTag: string, senderID: string, name: string): Promise<void>
  taildropSend(endpointTag: string, peerStableID: string, files: TaildropSendFile[]): Promise<void>
}