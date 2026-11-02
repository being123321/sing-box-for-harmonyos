export const NAVIGATION_TABS: string[] = ['dashboard', 'log', 'tools', 'settings']

export function navigationIndex(x: number, width: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0) return -1
  return Math.min(3, Math.max(0, Math.floor(x / width * 4)))
}

export function navigationGlowX(x: number, width: number, glowWidth: number): number {
  if (width <= 0 || !Number.isFinite(x)) return 0
  return Math.min(Math.max(0, width - glowWidth), Math.max(0, x - glowWidth / 2))
}
