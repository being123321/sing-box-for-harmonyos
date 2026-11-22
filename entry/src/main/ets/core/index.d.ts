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

/** N-API contract implemented by libentry.so. */
export function initialize(workingDirectory: string, temporaryDirectory: string): Promise<CoreInfo>
export function validateConfig(configJson: string): Promise<ValidationResult>
export function start(tunFd: number, configJson: string): Promise<void>
export function reload(configJson: string): Promise<void>
export function stop(): Promise<void>
export function urlTest(nodeTag: string): Promise<number>
export function testConfig(configJson: string, nodeTag: string): Promise<number>
export function selectOutbound(nodeTag: string): Promise<string>
export function getStatus(snapshotDetails?: number): Promise<CoreStatus>

export const control: (payload: string) => Promise<void>
