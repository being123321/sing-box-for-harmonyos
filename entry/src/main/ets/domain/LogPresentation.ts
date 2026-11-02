// Native core logs may contain terminal colors. ArkUI Text is not a terminal.
export function cleanLogLine(line: string): string {
  return line.replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}

export function logBody(line: string): string {
  return cleanLogLine(line).replace(/^(?:info|debug|warn|warning|error|fatal|trace)\s+/i, '')
    .replace(/^(?:INFO|DEBUG|WARN|WARNING|ERROR|FATAL|TRACE)(?=\[|\s)/, '').trim()
}
