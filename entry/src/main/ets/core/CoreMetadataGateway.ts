import type { CoreInfo } from './CoreGateway'

// UI code reads build metadata only. Loading the N-API library or calling a
// c-shared Go export during component construction can block the first frame.
// The VPN extension owns VPN operation; an explicit worker initializes an
// outbound-only UI-process probe on demand.
export class CoreMetadataGateway {
  getInfo(): CoreInfo {
    return { available: true, version: '1.14.4', reason: '' }
  }

  getVersion(): string { return '1.14.4' }
}
