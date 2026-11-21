export interface ScannedProfile { name: string; url: string; content: string; kind: string }
// Same wire format as SFA/libbox GenerateRemoteProfileImportLink: query url,
// percent-encoded fragment name. Query '+' means space; fragment '+' is literal.
export function parseProfileQr(value: string): ScannedProfile {
  const text: string = value.trim()
  if (text.length > 4 * 1024 * 1024) throw new Error('二维码内容过大')
  if (text.startsWith('{')) {
    const config: Record<string, Object> = JSON.parse(text) as Record<string, Object>
    if (!config || Array.isArray(config)) throw new Error('配置格式无效')
    return { name: '扫码配置', url: '', content: text, kind: 'local' }
  }
  if (!text.startsWith('sing-box://import-remote-profile?')) throw new Error('不是有效的 sing-box 远程配置链接')
  const hash: number = text.indexOf('#')
  const query: string = text.substring(text.indexOf('?') + 1, hash < 0 ? text.length : hash)
  let target: string = ''
  for (const part of query.split('&')) {
    const split: number = part.indexOf('=')
    if (split >= 0 && decodeURIComponent(part.substring(0, split).replace(/\+/g, ' ')) === 'url') {
      target = decodeURIComponent(part.substring(split + 1).replace(/\+/g, ' ')); break
    }
  }
  if (!/^https:\/\/[^\s/?#]+(?:[/?#]|$)/i.test(target)) throw new Error('远程配置链接必须使用 HTTPS')
  const name: string = hash >= 0 ? decodeURIComponent(text.substring(hash + 1)) : ''
  return { name: name || target.substring(8).split(/[/?#]/)[0], url: target, content: '', kind: 'remote' }
}
