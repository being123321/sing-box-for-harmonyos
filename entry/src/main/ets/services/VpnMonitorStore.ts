import { fileIo } from '@kit.CoreFileKit'
import { writeAtomicText } from './AtomicFileWriter'
import { VpnMonitorEvent, VpnMonitorJournal, emptyVpnJournal, appendMonitorEvent, cleanMonitorEvent } from '../domain/VpnMonitor'

export class VpnMonitorStore {
  private static stores: Map<string, VpnMonitorStore> = new Map()
  private queue: Promise<void> = Promise.resolve()
  private last: VpnMonitorEvent | null = null
  private path: string
  private constructor(path: string) { this.path = path }

  static get(filesDir: string, channel: string): VpnMonitorStore {
    const path: string = filesDir + '/vpn-monitor-' + (channel === 'extension' ? 'extension' : 'ui') + '.json'
    let store: VpnMonitorStore | undefined = this.stores.get(path)
    if (!store) { store = new VpnMonitorStore(path); this.stores.set(path, store) }
    return store
  }

  read(): VpnMonitorJournal {
    try {
      if (fileIo.statSync(this.path).size > 65536) return emptyVpnJournal()
      const journal: VpnMonitorJournal = JSON.parse(fileIo.readTextSync(this.path)) as VpnMonitorJournal
      if (journal.version !== 1 || !Array.isArray(journal.events)) return emptyVpnJournal()
      return {version: 1, latest: journal.latest ? cleanMonitorEvent(journal.latest) : null,
        events: journal.events.slice(-128).map((event: VpnMonitorEvent) => cleanMonitorEvent(event))}
    } catch (_) { return emptyVpnJournal() }
  }

  record(event: VpnMonitorEvent): Promise<void> {
    const sample: VpnMonitorEvent = cleanMonitorEvent(event)
    const previous: VpnMonitorEvent | null = this.last
    if ((sample.event === 'runtime' || sample.event === 'ui-observation') && previous && previous.event === sample.event && previous.session === sample.session && previous.code === sample.code &&
      previous.stage === sample.stage && previous.state === sample.state && sample.at >= previous.at && sample.at - previous.at < 30000) return Promise.resolve()
    this.last = sample
    const task: Promise<void> = this.queue.then(async () => {
      const journal: VpnMonitorJournal = appendMonitorEvent(this.read(), sample)
      while (journal.events.length > 1 && JSON.stringify(journal).length > 60000) journal.events.shift()
      await writeAtomicText(this.path, JSON.stringify(journal))
    })
    // Diagnostic failures must never take down the VPN or prevent safe stop.
    this.queue = task.catch(() => { this.last = null })
    return this.queue
  }

  recordDestroy(event: VpnMonitorEvent): void {
    // onDestroy cannot wait for an asynchronous write. A separate tiny file
    // avoids racing the queued journal writer. Sudden kills may skip it.
    let file: fileIo.File | null = null
    try {
      file = fileIo.openSync(this.path + '.destroy', fileIo.OpenMode.CREATE | fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.TRUNC)
      fileIo.writeSync(file.fd, JSON.stringify(cleanMonitorEvent(event)))
      fileIo.fsyncSync(file.fd)
    } catch (_) { }
    finally { if (file) { try { fileIo.closeSync(file) } catch (_) { } } }
  }

  readDestroy(): VpnMonitorEvent | null {
    try {
      if (fileIo.statSync(this.path + '.destroy').size > 4096) return null
      return cleanMonitorEvent(JSON.parse(fileIo.readTextSync(this.path + '.destroy')) as VpnMonitorEvent)
    } catch (_) { return null }
  }
}
