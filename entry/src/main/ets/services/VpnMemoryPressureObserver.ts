import { AbilityConstant, common, Configuration, EnvironmentCallback } from '@kit.AbilityKit'

// Subscribe only inside the VPN process. No UI/native-core dependency and no
// polling timer: memory reclaim is requested solely by genuine OS pressure.
export class VpnMemoryPressureObserver {
  private context: common.ApplicationContext | null = null
  private callbackId: number = -1
  private generation: number = 0
  private pending: boolean = false
  private lastRequestAt: number = 0
  private reclaim: () => Promise<void>
  private report: (message: string) => void

  constructor(reclaim: () => Promise<void>, report: (message: string) => void) {
    this.reclaim = reclaim; this.report = report
  }

  start(context: common.ApplicationContext): void {
    this.stop()
    const generation: number = this.generation
    const callback: EnvironmentCallback = {
      onConfigurationUpdated: (_config: Configuration): void => {},
      onMemoryLevel: (level: AbilityConstant.MemoryLevel): void => {
        if (generation !== this.generation || this.callbackId < 0 || this.pending) return
        if (level !== AbilityConstant.MemoryLevel.MEMORY_LEVEL_LOW &&
          level !== AbilityConstant.MemoryLevel.MEMORY_LEVEL_CRITICAL &&
          level !== AbilityConstant.MemoryLevel.MEMORY_LEVEL_BACKGROUND_LOW &&
          level !== AbilityConstant.MemoryLevel.MEMORY_LEVEL_BACKGROUND_CRITICAL) return
        const now: number = Date.now()
        if (this.lastRequestAt > 0 && now - this.lastRequestAt < 30000) return
        this.lastRequestAt = now; this.pending = true
        // N-API control runs asynchronously; never perform GC on this callback.
        Promise.resolve().then(async (): Promise<void> => {
          if (generation === this.generation && this.callbackId >= 0) await this.reclaim()
        }).catch(() => { this.report('VPN memory-pressure reclaim failed') }).finally(() => {
          if (generation === this.generation) this.pending = false
        })
      }
    }
    try {
      this.context = context
      this.callbackId = context.on('environment', callback)
    } catch (_) {
      this.context = null; this.callbackId = -1
      this.report('VPN memory-pressure observer unavailable')
    }
  }

  stop(): void {
    this.generation++; this.pending = false
    const context: common.ApplicationContext | null = this.context
    const id: number = this.callbackId
    this.context = null; this.callbackId = -1
    if (context !== null && id >= 0) {
      try { context.off('environment',id).catch(() => {}) } catch (_) { }
    }
  }
}
