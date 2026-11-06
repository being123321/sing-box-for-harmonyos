export interface PanelItem { tag: string; type: string; urlTestDelay?: number }
export interface PanelGroup { tag: string; type: string; selectable: boolean; selected: string; items: PanelItem[] }
export interface PanelPresentation { selections: Map<string,string>; delays: Map<string,number> }
export function panelNodeKey(group: string, item: string): string { return JSON.stringify([group,item]) }
// Selection and latency are presentation changes, never node identity changes.
export function panelGroupKey(group: PanelGroup): string {
  return JSON.stringify([group.tag,group.type,group.selectable,group.items.map((item: PanelItem) => [item.tag,item.type])])
}
export function panelPresentation(groups: PanelGroup[]): PanelPresentation {
  const selections: Map<string,string> = new Map()
  const delays: Map<string,number> = new Map()
  for (const group of groups) {
    selections.set(group.tag,group.selected)
    for (const item of group.items) delays.set(panelNodeKey(group.tag,item.tag),item.urlTestDelay || 0)
  }
  return {selections:selections,delays:delays}
}
export function samePanelMap<T>(left: Map<string,T>,right: Map<string,T>): boolean {
  if (left.size !== right.size) return false
  for (const key of left.keys()) if (!right.has(key) || left.get(key) !== right.get(key)) return false
  return true
}
