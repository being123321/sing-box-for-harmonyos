export interface PulsePoint { x: number; y: number; alpha: number; radius: number }
export function downloadPulsePoints(width: number, height: number, rate: number, elapsed: number): PulsePoint[] {
  if (!Number.isFinite(width) || width <= 0 || height <= 0) return []
  const speed: number = Number.isFinite(rate) && rate > 0 ? rate : 0
  const amplitude: number = Math.min(height * 0.40, Math.log2(1 + speed / 1024) * height * 0.035)
  const head: number = ((Math.max(0,elapsed) % 2600) / 2600) * (width + 80)
  const points: PulsePoint[] = []
  for (let index: number = 28; index >= 0; index--) {
    const x: number = head - index * 3
    if (x < 0 || x > width) continue
    const phase: number = ((x / Math.max(1,width)) * 4) % 1
    const qrs: number = Math.exp(-Math.pow((phase-0.46)/0.035,2)) - 0.5*Math.exp(-Math.pow((phase-0.52)/0.045,2))
    points.push({x:x,y:height/2-amplitude*qrs,alpha:1-index/32,radius:index===0?2.5:1.2})
  }
  return points
}
