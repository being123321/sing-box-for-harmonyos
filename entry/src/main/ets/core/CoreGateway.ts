import * as nativeCore from 'libentry.so'

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
  stage?: string
  sessionId?: string
  snapshotJson?: string
  running: boolean
  uploadBytes: number
  downloadBytes: number
  activeConnections: number
  selectedOutboundTag: string
  version: string
  lastError: string
}

export class CoreGateway {
  getInfo(): CoreInfo {
    return {
      available: true,
      version: nativeCore.version(),
      reason: ''
    }
  }

  initialize(workingDirectory: string, temporaryDirectory: string): Promise<CoreInfo> {
    return nativeCore.initialize(workingDirectory, temporaryDirectory)
  }

  validateConfig(configJson: string): Promise<ValidationResult> {
    return nativeCore.validateConfig(configJson)
  }

  start(tunFd: number, configJson: string): Promise<void> {
    return nativeCore.start(tunFd, configJson)
  }

  reload(configJson: string): Promise<void> {
    return nativeCore.reload(configJson)
  }

  stop(): Promise<void> {
    return nativeCore.stop()
  }

  urlTest(nodeTag: string): Promise<number> {
    return nativeCore.urlTest(nodeTag)
  }

  selectOutbound(nodeTag: string): Promise<string> {
    return nativeCore.selectOutbound(nodeTag)
  }

  control(payload: string): Promise<void> { return nativeCore.control(payload) }

  getStatus(snapshotDetails: number = 3): Promise<CoreStatus> {
    return nativeCore.getStatus(snapshotDetails)
  }

  getStatusLite(): Promise<CoreStatus> {
    return nativeCore.getStatusLite()
  }

  getVersion(): string {
    return nativeCore.version()
  }

  getLastError(): string {
    return nativeCore.lastError()
  }
}
