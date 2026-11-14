import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DNS_BOOTSTRAP_ENDPOINT,
  DNS_PRESETS,
  decodeNetworkSettings,
  defaultNetworkSettings,
  MAX_TRUSTED_APPLICATIONS,
  NETWORK_SETTINGS_SCHEMA,
  normalizeLocalRoutingRules,
  normalizeTrustedApplications,
  normalizeVpnApplicationScope,
  validateApplicationBundleName,
  validateLocalRoutingRule
} from '../../entry/src/main/ets/domain/NetworkSettings.ts'

test('uses an IPv4-literal AliDNS DoH endpoint for startup bootstrap', () => {
  assert.equal(DNS_BOOTSTRAP_ENDPOINT, 'https://223.5.5.5/dns-query')
  assert.equal(DNS_PRESETS.find((preset) => preset.id === 'cloudflare')?.endpoint,
    'https://1.1.1.1/dns-query')
  assert.equal(DNS_PRESETS.find((preset) => preset.id === 'quad9')?.endpoint,
    'https://9.9.9.9/dns-query')
})

test('new network settings enable IPv6 by default', () => {
  const settings = defaultNetworkSettings()
  assert.equal(settings.schemaVersion, NETWORK_SETTINGS_SCHEMA)
  assert.equal(settings.ipv6Enabled, true)
  assert.equal(settings.runMode, 'global')
  assert.deepEqual(settings.localRules, [])
  assert.equal(settings.applicationMode, 'all')
  assert.deepEqual(settings.trustedApplications, [])
})

test('schema 2 settings migrate to IPv6 enabled to preserve dual stack behaviour', () => {
  const settings = decodeNetworkSettings(JSON.stringify({
    schemaVersion: 2,
    runMode: 'global',
    nodeSelectionMode: 'auto',
    logLevel: 'warn',
    dnsPresetId: 'alidns',
    customDns: ''
  }))

  assert.equal(settings.schemaVersion, NETWORK_SETTINGS_SCHEMA)
  assert.equal(settings.ipv6Enabled, true)
  assert.equal(settings.runMode, 'global')
  assert.equal(settings.nodeSelectionMode, 'auto')
  assert.equal(settings.logLevel, 'warn')
  assert.deepEqual(settings.localRules, [])
})

test('schema 1 settings also migrate to IPv6 enabled with legacy strategy defaults', () => {
  const settings = decodeNetworkSettings(JSON.stringify({
    schemaVersion: 1,
    runMode: 'direct',
    dnsPresetId: 'quad9',
    customDns: ''
  }))

  assert.equal(settings.schemaVersion, NETWORK_SETTINGS_SCHEMA)
  assert.equal(settings.ipv6Enabled, true)
  assert.equal(settings.nodeSelectionMode, 'manual')
  assert.equal(settings.logLevel, 'info')
  assert.deepEqual(settings.localRules, [])
})

test('schema 3 settings migrate with an empty local rule list', () => {
  const settings = decodeNetworkSettings(JSON.stringify({
    schemaVersion: 3,
    runMode: 'rule',
    nodeSelectionMode: 'manual',
    logLevel: 'info',
    ipv6Enabled: false,
    dnsPresetId: 'cloudflare',
    customDns: ''
  }))

  assert.equal(settings.schemaVersion, NETWORK_SETTINGS_SCHEMA)
  assert.equal(settings.ipv6Enabled, false)
  assert.deepEqual(settings.localRules, [])
  assert.equal(settings.applicationMode, 'all')
  assert.deepEqual(settings.trustedApplications, [])
})

test('schema 4 settings migrate to the previous all-application VPN behaviour', () => {
  const settings = decodeNetworkSettings(JSON.stringify({
    schemaVersion: 4,
    runMode: 'rule',
    nodeSelectionMode: 'manual',
    logLevel: 'info',
    ipv6Enabled: true,
    dnsPresetId: 'cloudflare',
    customDns: '',
    localRules: []
  }))

  assert.equal(settings.schemaVersion, NETWORK_SETTINGS_SCHEMA)
  assert.equal(settings.applicationMode, 'all')
  assert.deepEqual(settings.trustedApplications, [])
})

test('current schema rejects a missing IPv6 setting instead of silently enabling it', () => {
  assert.throws(() => decodeNetworkSettings(JSON.stringify({
    schemaVersion: NETWORK_SETTINGS_SCHEMA,
    runMode: 'rule',
    nodeSelectionMode: 'manual',
    logLevel: 'info',
    dnsPresetId: 'cloudflare',
    customDns: '',
    localRules: []
  })), /版本无法识别/)
})

test('validates and normalizes the deliberately small local routing subset', () => {
  assert.deepEqual(validateLocalRoutingRule('domain', '  WWW.Example.COM ', 'proxy'), {
    kind: 'domain',
    value: 'www.example.com',
    target: 'proxy',
    source: 'local'
  })
  assert.deepEqual(validateLocalRoutingRule('domain_suffix', 'Example.COM', 'direct'), {
    kind: 'domain_suffix',
    value: 'example.com',
    target: 'direct',
    source: 'local'
  })
  assert.equal(validateLocalRoutingRule('ip_cidr', '192.0.2.0/24', 'reject').value, '192.0.2.0/24')
  assert.equal(validateLocalRoutingRule('ip_cidr', '2001:DB8::/32', 'proxy').value, '2001:db8::/32')
})

test('rejects unsupported, malformed, duplicate and excessive local routing rules', () => {
  assert.throws(() => validateLocalRoutingRule('domain_keyword', 'example', 'proxy'), /仅支持/)
  assert.throws(() => validateLocalRoutingRule('domain', '*.example.com', 'proxy'), /通配符/)
  assert.throws(() => validateLocalRoutingRule('domain_suffix', 'https://example.com', 'direct'), /网址/)
  assert.throws(() => validateLocalRoutingRule('ip_cidr', '192.0.2.0/33', 'reject'), /0 到 32/)
  assert.throws(() => validateLocalRoutingRule('ip_cidr', '2001:db8::/129', 'reject'), /0 到 128/)
  assert.throws(() => validateLocalRoutingRule('ip_cidr', '010.0.0.0/8', 'proxy'), /IP 地址格式/)
  assert.throws(() => validateLocalRoutingRule('ip_cidr', '192.0.2.0/08', 'proxy'), /前导零/)
  assert.throws(() => validateLocalRoutingRule('ip_cidr', '::1:/128', 'proxy'), /IP 地址格式/)
  assert.throws(() => validateLocalRoutingRule('ip_cidr', ':1::/128', 'proxy'), /IP 地址格式/)
  assert.equal(validateLocalRoutingRule('ip_cidr', '::ffff:192.0.2.0/120', 'proxy').value,
    '::ffff:192.0.2.0/120')
  assert.throws(() => validateLocalRoutingRule('domain', 'example.com', 'Streaming'), /目标/)
  const duplicate = validateLocalRoutingRule('domain', 'example.com', 'proxy')
  assert.throws(() => normalizeLocalRoutingRules([duplicate, duplicate]), /只能配置一次/)
  assert.throws(() => normalizeLocalRoutingRules([
    duplicate,
    { ...duplicate, target: 'direct' }
  ]), /只能配置一次/)
  assert.throws(() => normalizeLocalRoutingRules(Array.from({ length: 101 }, (_, index) => ({
    kind: 'domain', value: `host-${index}.example.com`, target: 'proxy', source: 'local'
  }))), /最多 100 条/)
})

test('current schema rejects tampered local rule payloads', () => {
  const baseline = defaultNetworkSettings()
  assert.throws(() => decodeNetworkSettings(JSON.stringify({
    ...baseline,
    localRules: [{ kind: 'rule_set', value: 'provider', target: 'direct', source: 'local' }]
  })), /仅支持/)
  assert.throws(() => decodeNetworkSettings(JSON.stringify({
    ...baseline,
    localRules: [{ kind: 'domain', value: 'example.com', target: 'proxy', source: 'subscription' }]
  })), /数据不完整/)
})

test('validates the HarmonyOS VPN application allowlist fail closed', () => {
  assert.equal(validateApplicationBundleName(' com.example.browser '), 'com.example.browser')
  assert.deepEqual(normalizeTrustedApplications([
    'com.example.browser',
    'com.example.chat_app'
  ]), ['com.example.browser', 'com.example.chat_app'])
  assert.deepEqual(normalizeVpnApplicationScope({
    mode: 'allowlist',
    trustedApplications: ['com.example.browser']
  }), {
    mode: 'allowlist',
    trustedApplications: ['com.example.browser']
  })
  assert.deepEqual(normalizeVpnApplicationScope({ mode: 'all', trustedApplications: [] }), {
    mode: 'all', trustedApplications: []
  })
  assert.equal(validateApplicationBundleName('example.app'), 'example.app')
  assert.throws(() => validateApplicationBundleName('1com.example.app'), /第一段必须以字母开头/)
  assert.throws(() => validateApplicationBundleName('com._example.app'), /后续分段必须以字母或数字开头/)
  assert.throws(() => validateApplicationBundleName('com.example.bad-name'), /只能包含/)
  assert.throws(() => validateApplicationBundleName('com.harmonynet.assistant'), /自身/)
  assert.throws(() => validateApplicationBundleName('com.harmonynet.assistant.beta'), /自身/)
  assert.throws(() => normalizeTrustedApplications([
    'com.example.browser', 'com.example.browser'
  ]), /只能加入白名单一次/)
  assert.throws(() => normalizeVpnApplicationScope({ mode: 'allowlist', trustedApplications: [] }),
    /至少需要加入一个应用/)
  assert.throws(() => normalizeTrustedApplications(Array.from(
    { length: MAX_TRUSTED_APPLICATIONS + 1 },
    (_, index: number) => `com.example.app_${index}`)), /最多/)
})

test('current schema requires and normalizes the application scope', () => {
  const baseline = defaultNetworkSettings()
  const decoded = decodeNetworkSettings(JSON.stringify({
    ...baseline,
    applicationMode: 'allowlist',
    trustedApplications: ['com.example.browser']
  }))
  assert.equal(decoded.applicationMode, 'allowlist')
  assert.deepEqual(decoded.trustedApplications, ['com.example.browser'])
  assert.throws(() => decodeNetworkSettings(JSON.stringify({
    ...baseline,
    applicationMode: 'allowlist',
    trustedApplications: []
  })), /至少需要加入一个应用/)
  assert.throws(() => decodeNetworkSettings(JSON.stringify({
    ...baseline,
    applicationMode: 'unsupported'
  })), /版本无法识别/)
})
