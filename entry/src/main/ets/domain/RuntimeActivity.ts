export interface UiActivityLease { foreground: boolean; updatedAt: number; snapshotDetails?: number }
export function isUiActive(lease: UiActivityLease | null, now: number): boolean {
  if (!lease || lease.foreground !== true || !Number.isFinite(lease.updatedAt)) return false
  const age: number = now - lease.updatedAt
  return age >= -2000 && age <= 15000
}
export function telemetryInterval(active: boolean): number { return active ? 1000 : 15000 }
export function heartbeatInterval(active: boolean): number { return active ? 1000 : 3000 }
