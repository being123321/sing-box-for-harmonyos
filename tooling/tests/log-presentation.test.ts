import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanLogLine, logBody } from '../../entry/src/main/ets/domain/LogPresentation.ts'

test('terminal color codes are removed and duplicated levels are not shown in log body', () => {
  const raw = 'info \u001b[36mINFO\u001b[0m[0170] [\u001b[38;5;221m1234\u001b[0m 0ms] inbound/tun[tun-in]: 测试连接'
  assert.equal(logBody(raw), '[0170] [1234 0ms] inbound/tun[tun-in]: 测试连接')
  assert.equal(cleanLogLine(raw), 'info INFO[0170] [1234 0ms] inbound/tun[tun-in]: 测试连接')
})
test('OSC terminal hyperlinks, C1 colors and stray controls do not become squares', () => {
  assert.equal(cleanLogLine('error \u001b]8;;https://example.org\u0007text\u001b]8;;\u001b\\ \u009b31m红色\u009b0m\u0000'), 'error text 红色')
  assert.equal(logBody('warn 中文\nnext\tline'), '中文\nnext\tline')
})
