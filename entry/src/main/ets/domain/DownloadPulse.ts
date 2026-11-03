export interface PulsePoint { x: number; y: number; alpha: number; radius: number }

// A slow ECG sweep for the running bar. Samples are dense on purpose: the trail
// is drawn as connected segments so it never breaks into dots, and a long tail
// fades out for the smear. 9 s per sweep keeps it calm rather than blinking.
export function downloadPulsePoints(width: number, height: number, rate: number, elapsed: number): PulsePoint[] {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return []
  const speed: number = Number.isFinite(rate) && rate > 0 ? rate : 0
  const amplitude: number = Math.min(height * 0.34, 4 + Math.log2(1 + speed / 1024) * height * 0.02)
  const cycle: number = 9000
  const head: number = ((Math.max(0, elapsed) % cycle) / cycle) * (width + 160)
  const span: number = Math.max(90, Math.min(160, width * 0.42))
  const step: number = 1.5
  const points: PulsePoint[] = []
  for (let offset: number = 0; offset <= span; offset += step) {
    const x: number = head - offset
    if (x < -2 || x > width + 2) continue
    const phase: number = ((x / Math.max(1, width)) * 4) % 1
    const qrs: number = Math.exp(-Math.pow((phase - 0.46) / 0.055, 2)) - 0.42 * Math.exp(-Math.pow((phase - 0.55) / 0.07, 2))
    const tail: number = 1 - offset / span
    points.push({ x: x, y: height / 2 - amplitude * qrs, alpha: Math.max(0, tail * tail * 0.85), radius: 0.7 + tail * 1.5 })
  }
  return points
}
