import { classifyProxyUrlTestFailure } from './ProxyUrlTestDiagnostic.ts'
export function nodeProbeErrorCode(message: string): string {
  const value: string = message.toLowerCase()
  if (value.includes('probe-init:') || value.includes('probe-start:')) return 'init'
  if (value.includes('probe-cleanup:')) return 'cleanup'
  if (value.includes('测速线程') || value.includes('worker')) return 'worker'
  if (value.includes('取消') || value.includes('context canceled')) return 'cancelled'
  if (value.includes('no available network interface')) return 'network'
  const mapped: string[] = ['TIMEOUT', 'DNS', 'TLS', 'PROTECT', 'CONNECT', 'HANDSHAKE']
  const codes: string[] = ['timeout', 'dns', 'tls', 'network', 'connect', 'handshake']
  for (let i: number = 0; i < mapped.length; i++) {
    if (value.includes('hna-url-' + mapped[i].toLowerCase())) return codes[i]
  }
  const code: string = classifyProxyUrlTestFailure(message).code
  if (code === 'HNA-URL-TIMEOUT') return 'timeout'
  if (code === 'HNA-URL-DNS') return 'dns'
  if (code === 'HNA-URL-TLS') return 'tls'
  if (code === 'HNA-URL-PROTECT') return 'network'
  if (code === 'HNA-URL-CONNECT') return 'connect'
  if (code === 'HNA-URL-HANDSHAKE') return 'handshake'
  return 'failed'
}
export function nodeProbeErrorLabel(code: string): string {
  switch (code) {
    case 'timeout': return '超时'
    case 'dns': return 'DNS 失败'
    case 'tls': return 'TLS 失败'
    case 'network': return '网络不可用'
    case 'connect': return '连接失败'
    case 'handshake': return '握手失败'
    case 'init': return '初始化失败'
    case 'cleanup': return '清理失败'
    case 'worker': return '测速启动失败'
    case 'cancelled': return '已取消'
    default: return '测速失败'
  }
}
