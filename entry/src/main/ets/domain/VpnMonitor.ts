export interface VpnMonitorEvent {
  at: number; eventAt: number; event: string; state: string; stage: string;
  pid: number; session: string; code: number; reason: string; runId: string
}
export interface VpnMonitorJournal { version: number; latest: VpnMonitorEvent | null; events: VpnMonitorEvent[] }

export function emptyVpnJournal(): VpnMonitorJournal { return {version: 1, latest: null, events: []} }

function token(value: string, max: number): string {
  return typeof value === 'string' && value.length <= max && /^[A-Za-z0-9_.()\-]*$/.test(value) ? value : ''
}

// Copy only the fixed diagnostic schema. No config, URL, IP, SSID, node name,
// exception text, system stack trace or external log path can enter this file.
export function cleanMonitorEvent(value: VpnMonitorEvent): VpnMonitorEvent {
  return {at: Number.isFinite(value.at) ? value.at : 0, eventAt: Number.isFinite(value.eventAt) ? value.eventAt : 0,
    event: token(value.event, 64), state: token(value.state, 32), stage: token(value.stage, 80),
    pid: Number.isSafeInteger(value.pid) ? value.pid : -1, session: token(value.session, 128),
    code: Number.isFinite(value.code) ? value.code : -1, reason: token(value.reason, 100), runId: token(value.runId, 40)}
}

export function appendMonitorEvent(journal: VpnMonitorJournal, event: VpnMonitorEvent): VpnMonitorJournal {
  const clean: VpnMonitorEvent = cleanMonitorEvent(event)
  if (clean.event.startsWith('APP_') || clean.event === 'RESOURCE_OVERLIMIT') {
    if (clean.eventAt > 0 && journal.events.some((prior: VpnMonitorEvent) => prior.event === clean.event && prior.eventAt === clean.eventAt && prior.pid === clean.pid && prior.runId === clean.runId)) return journal
  }
  const last: VpnMonitorEvent | undefined = journal.events[journal.events.length - 1]
  const duplicate: boolean = last !== undefined && last.event === clean.event && last.state === clean.state &&
    last.stage === clean.stage && last.pid === clean.pid && last.session === clean.session &&
    last.code === clean.code && last.reason === clean.reason && last.runId === clean.runId &&
    (clean.event === 'runtime' || clean.event === 'ui-observation' || last.eventAt === clean.eventAt)
  return {version: 1, latest: clean, events: duplicate ? journal.events.slice(-128) : [...journal.events.slice(-127), clean]}
}

export function monitorContinuity(latest: VpnMonitorEvent | null, now: number): string {
  if (!latest) return '尚无记录'
  if (latest.state === 'stopped') return '已记录停止'
  if (latest.stage === 'ssid-suspended') return now - latest.at > 90000 ? '上次记录为按需挂起，之后心跳未更新' : '按需挂起'
  if (now - latest.at < -2000) return '系统时间发生变化，无法判断心跳'
  if (now - latest.at > 90000) return '心跳记录已中断，原因待确认'
  return '近期有运行记录（不代表节点外网可用）'
}
