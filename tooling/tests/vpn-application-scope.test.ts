import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const extensionSource = readFileSync(new URL(
  '../../entry/src/main/ets/vpnextension/NetworkVpnExtAbility.ets', import.meta.url), 'utf8')
const runtimeStoreSource = readFileSync(new URL(
  '../../entry/src/main/ets/services/VpnRuntimeConfigStore.ts', import.meta.url), 'utf8')
const coordinatorSource = readFileSync(new URL(
  '../../entry/src/main/ets/services/ConnectionCoordinator.ts', import.meta.url), 'utf8')
const catalogSource = readFileSync(new URL(
  '../../entry/src/main/ets/services/ApplicationCatalogService.ts', import.meta.url), 'utf8')
const indexSource = readFileSync(new URL(
  '../../entry/src/main/ets/pages/Index.ets', import.meta.url), 'utf8')
const moduleSource = readFileSync(new URL(
  '../../entry/src/main/module.json5', import.meta.url), 'utf8')

test('VPN Extension maps validated allowlist and blocklist to exclusive OS fields', () => {
  assert.match(extensionSource, /applicationScope\.mode === 'allowlist'/)
  assert.match(extensionSource, /config\.trustedApplications = applicationScope\.trustedApplications\.slice\(\)/)
  assert.match(extensionSource, /config\.blockedApplications = applicationScope\.trustedApplications\.slice\(\)/)
  const loadConfigAt = extensionSource.indexOf('await configStore.load()')
  const loadScopeAt = extensionSource.indexOf('await configStore.loadApplicationScope()', loadConfigAt)
  const createAt = extensionSource.indexOf('connection.create(this.buildVpnConfig(ipv6Enabled, applicationScope))')
  assert.ok(loadConfigAt >= 0 && loadScopeAt > loadConfigAt && createAt > loadScopeAt)
})

test('application scope is encrypted and committed before a start ticket becomes visible', () => {
  assert.match(runtimeStoreSource, /vpn-application-scope\.secure\.json/)
  assert.match(runtimeStoreSource, /new SecureFileStore\(/)
  assert.match(runtimeStoreSource, /'vpn-application-scope'/)
  assert.match(runtimeStoreSource, /normalizeVpnApplicationScope/)
  assert.match(runtimeStoreSource, /await this\.applicationScopeStore\.save\(JSON\.stringify\(normalizedScope\)\)/)
  assert.match(runtimeStoreSource, /await this\.applicationScopeStore\.clear\(\)/)
  const ticketAt = coordinatorSource.indexOf('await this.runtimeBridge.publishStartTicket')
  const scopeWriteAt = coordinatorSource.indexOf('await this.configStore.save(configJson, applicationScope, profileId)', ticketAt)
  assert.ok(ticketAt >= 0 && scopeWriteAt > ticketAt)
})

test('phone catalog checks the real signing permission before full inventory access', () => {
  assert.match(catalogSource, /checkAccessTokenSync/)
  assert.match(catalogSource, /GET_BUNDLE_INFO_PRIVILEGED/)
  assert.match(catalogSource, /bundle\.getAllApplicationInfo/)
  assert.doesNotMatch(catalogSource, /bundle\.queryAbilityByWant\(/)
  assert.match(moduleSource, /ohos\.permission\.GET_BUNDLE_INFO/)
  assert.match(indexSource, /applicationBundleDraft/)
  assert.match(indexSource, /validateApplicationBundleName\(bundleName\)/)
  assert.match(indexSource, /仅所选应用/)
  assert.match(indexSource, /Only selected apps/)
})

test('connected allowlist changes use acknowledged runtime reconfiguration', () => {
  assert.match(indexSource, /private async setApplicationMode\(mode: VpnApplicationMode\)/)
  assert.match(indexSource, /private async setApplicationSelected\(bundleName: string, selected: boolean\)/)
  assert.match(indexSource, /this\.applicationMode === 'allowlist' \?\s+gatePlan : 'persist-only'/)
  assert.match(indexSource, /vpnApplicationScope\(previousSettings\)/)
  assert.match(indexSource, /vpnApplicationScope\(nextSettings\)/)
  assert.match(indexSource, /coordinator\.connect\(nextConfigJson,\s+vpnApplicationScope\(nextSettings\)\)/)
})
