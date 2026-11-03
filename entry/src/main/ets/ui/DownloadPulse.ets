interface GlassCrawler { x: number; y: number; vx: number; vy: number; r: number }

// A few faint dark wisps that wander inside the running-bar glass. They are not
// a data readout: no rate mapping, no red trace, just slow random crawling so the
// bar reads as a lit surface rather than a flat panel.
@Component
export struct DownloadPulse {
  @Prop rate: number = 0
  @Prop @Watch('syncAnimation') active: boolean = false
  @Prop @Watch('syncAnimation') foreground: boolean = true
  private context: CanvasRenderingContext2D = new CanvasRenderingContext2D(new RenderingContextSettings(true))
  private pulseWidth: number = 280
  private pulseHeight: number = 44
  private timer: number = 0
  private ready: boolean = false
  private crawlers: GlassCrawler[] = []

  aboutToDisappear(): void { this.ready = false; this.stop() }
  private stop(): void { if (this.timer !== 0) clearInterval(this.timer); this.timer = 0 }

  private seed(): void {
    if (this.crawlers.length > 0) return
    for (let index: number = 0; index < 3; index++) {
      this.crawlers.push({
        x: this.pulseWidth * (0.16 + index * 0.33),
        y: this.pulseHeight * (0.34 + index * 0.16),
        vx: index % 2 === 0 ? 7 : -5,
        vy: index % 2 === 0 ? 4 : -6,
        r: 6.5 + index * 2.5
      })
    }
  }

  private syncAnimation(): void {
    this.stop()
    if (!this.ready || !this.active || !this.foreground) {
      if (this.ready) this.context.clearRect(0, 0, this.pulseWidth, this.pulseHeight)
      return
    }
    this.seed()
    this.timer = setInterval(() => this.draw(), 45)
    this.draw()
  }

  private step(): void {
    const w: number = this.pulseWidth
    const h: number = this.pulseHeight
    for (const crawler of this.crawlers) {
      // Random walk: nudge the heading every tick, then clamp to a slow crawl.
      crawler.vx += (Math.random() - 0.5) * 5
      crawler.vy += (Math.random() - 0.5) * 5
      const speed: number = Math.sqrt(crawler.vx * crawler.vx + crawler.vy * crawler.vy)
      const min: number = 3
      const max: number = 14
      if (speed < min || speed > max) {
        const target: number = speed < min ? min : max
        crawler.vx = crawler.vx / (speed || 1) * target
        crawler.vy = crawler.vy / (speed || 1) * target
      }
      crawler.x += crawler.vx * 0.045
      crawler.y += crawler.vy * 0.045
      const pad: number = crawler.r * 1.6
      if (crawler.x < pad) { crawler.x = pad; crawler.vx = Math.abs(crawler.vx) }
      if (crawler.x > w - pad) { crawler.x = w - pad; crawler.vx = -Math.abs(crawler.vx) }
      if (crawler.y < pad) { crawler.y = pad; crawler.vy = Math.abs(crawler.vy) }
      if (crawler.y > h - pad) { crawler.y = h - pad; crawler.vy = -Math.abs(crawler.vy) }
    }
  }

  private wisp(x: number, y: number, radius: number, alpha: number): void {
    const gradient: CanvasGradient = this.context.createRadialGradient(x, y, 0, x, y, radius)
    gradient.addColorStop(0, 'rgba(16,16,20,' + alpha.toFixed(3) + ')')
    gradient.addColorStop(0.55, 'rgba(16,16,20,' + (alpha * 0.45).toFixed(3) + ')')
    gradient.addColorStop(1, 'rgba(16,16,20,0)')
    this.context.fillStyle = gradient
    this.context.beginPath()
    this.context.arc(x, y, radius, 0, Math.PI * 2)
    this.context.fill()
  }

  private draw(): void {
    if (this.pulseHeight <= 0) return
    this.context.clearRect(0, 0, this.pulseWidth, this.pulseHeight)
    this.step()
    for (const crawler of this.crawlers) {
      // Soft body plus a few uneven satellites so the edge looks fuzzy, like a
      // hair shadow rather than a solid dot.
      this.wisp(crawler.x, crawler.y, crawler.r * 1.9, 0.085)
      const offsets: number[] = [0.7, 2.4, 4.1, 5.5]
      for (let index: number = 0; index < offsets.length; index++) {
        const angle: number = offsets[index]
        this.wisp(crawler.x + Math.cos(angle) * crawler.r * 0.55, crawler.y + Math.sin(angle) * crawler.r * 0.45,
          crawler.r * (0.5 - index * 0.07), 0.05 - index * 0.008)
      }
    }
  }

  build() {
    Canvas(this.context).width('100%').height('100%')
      .onAreaChange((_old: Area, area: Area) => {
        this.pulseWidth = Number(area.width)
        this.pulseHeight = Number(area.height)
        this.crawlers = []
        this.seed()
      })
      .onReady(() => { this.ready = true; this.syncAnimation() })
      .hitTestBehavior(HitTestMode.None)
      .accessibilityText('运行栏玻璃流光')
  }
}
