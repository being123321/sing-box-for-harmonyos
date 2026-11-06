interface ChoiceRequest { value: string; revision: number; acknowledgedAt: number }

// Presentation follows the user's latest tap. Commands remain serialized and
// coalesce per selector; delayed snapshots cannot undo an outstanding choice.
export class OptimisticChoices {
  private pending: Map<string, ChoiceRequest> = new Map()
  private queued: Map<string, ChoiceRequest> = new Map()
  private confirmed: Map<string, string> = new Map()
  private revision: number = 0
  private generation: number = 0
  private draining: boolean = false

  private send: (key: string, value: string) => Promise<void>
  private display: (key: string, value: string) => void
  private failed: (message: string) => void
  constructor(send: (key: string, value: string) => Promise<void>,
    display: (key: string, value: string) => void,
    failed: (message: string) => void) {
    this.send = send; this.display = display; this.failed = failed
  }

  choose(key: string, value: string, previous: string): void {
    if (!this.pending.has(key)) this.confirmed.set(key, previous)
    const request: ChoiceRequest = { value: value, revision: ++this.revision, acknowledgedAt: 0 }
    this.pending.set(key, request)
    this.queued.set(key, request)
    this.display(key, value)
    if (!this.draining) {
      this.draining = true
      const generation: number = this.generation
      // Yield the event handler so ArkUI can present the selection first.
      setTimeout(() => { this.drain(generation) }, 0)
    }
  }

  reconcile(key: string, value: string, sampledAt: number): string {
    const request: ChoiceRequest | undefined = this.pending.get(key)
    if (request && (request.acknowledgedAt === 0 || sampledAt < request.acknowledgedAt)) return request.value
    this.pending.delete(key)
    this.confirmed.set(key, value)
    return value
  }

  reset(): void {
    this.generation++
    this.pending.clear(); this.queued.clear(); this.confirmed.clear()
    this.draining = false
  }

  private async drain(generation: number): Promise<void> {
    try {
      while (generation === this.generation && this.queued.size > 0) {
        const key: string = this.queued.keys().next().value as string
        const request: ChoiceRequest = this.queued.get(key) as ChoiceRequest
        this.queued.delete(key)
        try {
          await this.send(key, request.value)
          if (generation !== this.generation) return
          this.confirmed.set(key, request.value)
          if (this.pending.get(key)?.revision === request.revision) request.acknowledgedAt = Date.now()
        } catch (error) {
          if (generation !== this.generation) return
          if (this.pending.get(key)?.revision === request.revision) {
            this.pending.delete(key)
            this.display(key, this.confirmed.get(key) || '')
            this.failed(error instanceof Error ? error.message : '切换失败，已恢复原选择')
          }
        }
      }
    } finally { if (generation === this.generation) this.draining = false }
  }
}
