import { downloadPulsePoints, PulsePoint } from '../domain/DownloadPulse'

@Component
export struct DownloadPulse {
  @Prop rate: number = 0
  @Prop @Watch('syncAnimation') active: boolean = false
  @Prop @Watch('syncAnimation') foreground: boolean = true
  private context: CanvasRenderingContext2D = new CanvasRenderingContext2D(new RenderingContextSettings(true))
  private pulseWidth: number = 280
  private timer: number = 0
  private startedAt: number = Date.now()
  private ready: boolean = false

  aboutToDisappear(): void { this.ready = false; this.stop() }
  private stop(): void { if(this.timer!==0)clearInterval(this.timer);this.timer=0 }
  private syncAnimation(): void {
    this.stop()
    if(!this.ready||!this.active||!this.foreground){if(this.ready)this.context.clearRect(0,0,this.pulseWidth,22);return}
    this.timer=setInterval(()=>this.draw(),50)
    this.draw()
  }
  private draw(): void {
    const height:number=22
    this.context.clearRect(0,0,this.pulseWidth,height)
    const gradient:CanvasGradient=this.context.createLinearGradient(0,0,this.pulseWidth,0)
    gradient.addColorStop(0,'#FF9C9C');gradient.addColorStop(0.5,'#FF354D');gradient.addColorStop(1,'#B8002C')
    this.context.fillStyle=gradient
    this.context.shadowColor='#F0445D';this.context.shadowBlur=5
    for(const point of downloadPulsePoints(this.pulseWidth,height,this.rate,Date.now()-this.startedAt)) {
      this.context.globalAlpha=point.alpha
      this.context.beginPath();this.context.arc(point.x,point.y,point.radius,0,Math.PI*2);this.context.fill()
    }
    this.context.globalAlpha=1
  }
  build() {
    Canvas(this.context).width('100%').height(22)
      .onAreaChange((_old:Area,area:Area)=>{this.pulseWidth=Number(area.width)})
      .onReady(()=>{this.ready=true;this.syncAnimation()})
      .accessibilityText('下载流量动态指示')
  }
}
