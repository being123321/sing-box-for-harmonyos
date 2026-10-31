export interface CoreInfo {
  available: boolean
  version: string
  reason: string
}

export interface ValidationResult {
  valid: boolean
  error: string
}

export interface CoreStatus {
  snapshotJson?: string
  running: boolean
  uploadBytes: number
  downloadBytes: number
  activeConnections: number
  selectedOutboundTag: string
  version: string
  lastError: string
}

export const initialize: (workingDirectory: string, temporaryDirectory: string) => Promise<CoreInfo>
export const validateConfig: (configJson: string) => Promise<ValidationResult>
export const start: (tunFd: number, configJson: string) => Promise<void>
export const reload: (configJson: string) => Promise<void>
export const stop: () => Promise<void>
export const urlTest: (nodeTag: string) => Promise<number>
export const testConfig: (configJson: string, nodeTag: string) => Promise<number>
export const selectOutbound: (nodeTag: string) => Promise<string>
export const getStatus: () => Promise<CoreStatus>
export const getStatusLite: () => Promise<CoreStatus>
export const version: () => string
export const lastError: () => string

export const control: (payload: string) => Promise<void>
// Tailscale operations
export const tailscaleStatus: () => Promise<string>
export const tailscaleSetExitNode: (endpointTag: string, stableID: string) => Promise<void>
export const tailscaleLogout: (endpointTag: string) => Promise<void>
export const tailscalePing: (endpointTag: string, peerIP: string) => Promise<string>
export const taildropSubscribe: (endpointTag: string) => Promise<void>
export const taildropInbox: (endpointTag: string) => Promise<string>
export const taildropDownload: (endpointTag: string, name: string, destinationPath: string) => Promise<void>
export const taildropDelete: (endpointTag: string, name: string) => Promise<void>
export const taildropMarkRead: (endpointTag: string) => Promise<void>
export const taildropCancelReceive: (endpointTag: string, senderID: string, name: string) => Promise<void>
