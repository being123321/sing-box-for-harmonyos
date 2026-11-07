import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = readFileSync(new URL('../../entry/src/main/ets/services/PhysicalNetwork.ts', import.meta.url), 'utf8')
  .replace(/import[^\n]+\n/g, '').replaceAll('export async function', 'async function')

function fixture() {
  const state = {
    defaultId: 90,
    afterId: undefined as number | undefined,
    capabilities: { bearerTypes: [0], networkCap: [12, 15, 16] },
    properties: {
      interfaceName: 'rmnet1',
      linkAddresses: [{ address: { address: '192.0.2.1' }, prefixLength: 24 }],
      dnses: [{ address: '2001:db8::53' }, { address: '192.0.2.53' }]
    },
    readError: null as Error | null
  }
  let reads = 0
  const context = vm.createContext({ Error, connection: {
    NetBearType: { BEARER_WIFI: 1, BEARER_CELLULAR: 0, BEARER_VPN: 4 },
    NetCap: { NET_CAPABILITY_INTERNET: 12, NET_CAPABILITY_NOT_VPN: 15, NET_CAPABILITY_VALIDATED: 16 },
    getDefaultNet: async () => {
      if (state.readError) throw state.readError
      reads++
      return { netId: reads % 2 === 0 && state.afterId !== undefined ? state.afterId : state.defaultId }
    },
    // Both data SIMs or a nondefault Wi-Fi may still be connected. Neither
    // their enumeration order nor their smaller IDs may influence selection.
    getAllNets: async () => { throw new Error('must not enumerate arbitrary fallback networks') },
    getNetCapabilities: async ({ netId }: { netId: number }) => {
      assert.equal(netId, state.defaultId)
      return state.capabilities
    },
    getConnectionProperties: async ({ netId }: { netId: number }) => {
      assert.equal(netId, state.defaultId)
      return state.properties
    }
  } })
  return {
    state,
    signature: vm.runInContext(stripTypeScriptTypes(source) + '\nphysicalNetworkSignature', context),
    dns: vm.runInContext('physicalProbeDns', context)
  }
}

test('physical signature follows default data SIM even while previous networks remain connected', async () => {
  const { state, signature } = fixture()
  assert.deepEqual(JSON.parse(await signature()), {
    id: 90, kind: 'cellular', interface: 'rmnet1', addresses: ['192.0.2.1/24'],
    dns: ['192.0.2.53', '2001:db8::53']
  })
  state.defaultId = 120
  state.properties.interfaceName = 'rmnet2'
  assert.equal(JSON.parse(await signature()).id, 120)
  assert.equal(JSON.parse(await signature()).interface, 'rmnet2')
  state.defaultId = 140
  state.capabilities.bearerTypes = [1]
  state.properties.interfaceName = 'wlan0'
  assert.equal(JSON.parse(await signature()).kind, 'wifi')
})

test('unsafe or unvalidated default has no fallback to a previous SIM or VPN', async () => {
  for (const capabilities of [
    { bearerTypes: [4], networkCap: [12, 15, 16] },
    { bearerTypes: [0], networkCap: [12, 16] },
    { bearerTypes: [0], networkCap: [12, 15] },
    { bearerTypes: [0], networkCap: [15, 16] },
    { bearerTypes: [3], networkCap: [12, 15, 16] }
  ]) {
    const { state, signature } = fixture()
    state.capabilities = capabilities
    assert.equal(await signature(), 'none')
  }
  const { state, signature } = fixture()
  state.defaultId = 0
  assert.equal(await signature(), 'none')
})

test('default change during snapshot is retriable and never publishes previous SIM', async () => {
  const { state, signature } = fixture()
  state.afterId = 120
  await assert.rejects(signature(), /正在切换/)
  state.afterId = undefined
  state.defaultId = 120
  assert.equal(JSON.parse(await signature()).id, 120)
  state.readError = new Error('network manager unavailable')
  await assert.rejects(signature(), /network manager unavailable/)
})

test('signature is stable when DNS/address order changes', async () => {
  const { state, signature } = fixture()
  state.properties.linkAddresses.push({ address: { address: '2001:db8::1' }, prefixLength: 64 })
  const before = await signature()
  state.properties.linkAddresses.reverse()
  state.properties.dnses.reverse()
  assert.equal(await signature(), before)
})

test('probe DNS uses current default underlay and reports unavailable DNS/network', async () => {
  const { state, dns } = fixture()
  assert.equal(await dns(), '192.0.2.53')
  state.properties.dnses = [{ address: '2001:db8::53' }]
  assert.equal(await dns(), '2001:db8::53')
  state.properties.dnses = []
  await assert.rejects(dns(), /DNS/)
  state.defaultId = 0
  await assert.rejects(dns(), /网络/)
})
