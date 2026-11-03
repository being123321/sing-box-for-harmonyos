import { hiAppEvent } from '@kit.PerformanceAnalysisKit'
import { process } from '@kit.ArkTS'
import { VpnMonitorStore } from './VpnMonitorStore'
import { VpnMonitorEvent } from '../domain/VpnMonitor'

// These are app-level system observations; APP_KILLED does not always identify
// the particular extension process, and delivery may wait until next launch.
export class VpnSystemEvents {
  private static watcher: hiAppEvent.Watcher | null = null
  static start(filesDir: string, exitReason: number): void {
    if (this.watcher) return
    const store: VpnMonitorStore = VpnMonitorStore.get(filesDir, 'ui')
    const launch: VpnMonitorEvent = {at: Date.now(), eventAt: Date.now(), event: 'ui-launch',
      state: '', stage: '', pid: process.pid, session: '', code: exitReason, reason: '', runId: ''}
    store.record(launch)
    const watcher: hiAppEvent.Watcher = {
      name: 'vpn_lifecycle_monitor',
      appEventFilters: [{domain: hiAppEvent.domain.OS, names: [hiAppEvent.event.APP_KILLED,
        hiAppEvent.event.APP_CRASH, hiAppEvent.event.APP_FREEZE, hiAppEvent.event.RESOURCE_OVERLIMIT]}],
      onReceive: (_domain: string, groups: hiAppEvent.AppEventGroup[]): void => {
        for (const group of groups.slice(-8)) {
          for (const info of group.appEventInfos.slice(-128)) {
            const params: Record<string, Object> = info.params as Record<string, Object>
            const sample: VpnMonitorEvent = {at: Date.now(), eventAt: typeof params.time === 'number' ? params.time as number : 0,
              event: info.name, state: '', stage: '', pid: typeof params.pid === 'number' ? params.pid as number : -1,
              session: '', code: -1, reason: typeof params.reason === 'string' ? params.reason as string : '',
              runId: typeof params.app_running_unique_id === 'string' || typeof params.app_running_unique_id === 'number' ? String(params.app_running_unique_id) : ''}
            store.record(sample)
          }
        }
      }
    }
    try {
      const holder: hiAppEvent.AppEventPackageHolder = hiAppEvent.addWatcher(watcher)
      if (holder) { this.watcher = watcher; store.record({...launch, event: 'watcher-active', code: 0}) }
      else store.record({...launch, event: 'watcher-unavailable', code: -1})
    } catch (_) { store.record({...launch, event: 'watcher-unavailable', code: -1}) }
  }

  static stop(): void {
    if (this.watcher) { try { hiAppEvent.removeWatcher(this.watcher) } catch (_) { } }
    this.watcher = null
  }
}
