import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'
import { NAVIGATION_TABS, navigationIndex, navigationGlowX } from '../../entry/src/main/ets/domain/NavigationDrag.ts'

function fixture() {
  const source = fs.readFileSync(new URL('../../entry/src/main/ets/pages/SfaIndex.ets', import.meta.url), 'utf8')
  const methods = source.slice(source.indexOf('  private highlightedNav('), source.indexOf('  @Builder\n  navItem(')).replace(/@State /g, '')
  const TouchType = { Down: 0, Up: 1, Move: 2, Cancel: 3 }
  let pending: (() => void) | undefined
  const Nav = vm.runInNewContext(stripTypeScriptTypes('class Nav {' + methods + '}\nNav'), { NAVIGATION_TABS, navigationIndex, navigationGlowX, TouchType, Date,
    setTimeout: (callback: () => void) => { pending = callback; return 1 }, clearTimeout: () => { pending = undefined } })
  const nav = new Nav()
  Object.assign(nav, { tab: 'dashboard', page: 'old', navDragging: false, navPreviewIndex: -1, navBarWidth: 400 })
  nav.dockSize = (v: number) => v * 0.8
  const touch = (type: number, x: number, y = 20) => nav.handleNavTouch({ type, touches: type === 1 ? [] : [{ x, y }], changedTouches: [{ x, y }] })
  return { nav, touch, TouchType, tick: () => { const callback = pending; pending = undefined; callback?.() }, hasTimer: () => pending !== undefined }
}

test('glow tracks finger continuously, covers any slot and commits only at release', () => {
  const { nav, touch, TouchType } = fixture()
  touch(TouchType.Down, 20)
  touch(TouchType.Move, 240)
  assert.equal(nav.highlightedNav(), 'tools')
  assert.equal(nav.tab, 'dashboard', 'content must not repeatedly change while swiping')
  assert.equal(nav.navGlowLeft(), 194)
  touch(TouchType.Up, 350)
  assert.equal(nav.tab, 'settings')
  assert.equal(nav.page, '')
  assert.equal(nav.navDragging, false)
  assert.ok(nav.navIgnoreClickUntil > Date.now(), 'child click must not restore the initial touched menu')
})

test('leaving the bar chooses the last in-bar slot, cancel and multiple touches preserve the prior menu', () => {
  const { nav, touch, TouchType } = fixture()
  touch(TouchType.Down, 10)
  touch(TouchType.Move, 220)
  touch(TouchType.Move, 390, 100)
  assert.equal(nav.tab, 'tools')
  touch(TouchType.Up, 390, 100)
  assert.equal(nav.tab, 'tools')
  touch(TouchType.Down, 350)
  touch(TouchType.Cancel, 350)
  assert.equal(nav.tab, 'tools')
  touch(TouchType.Down, 10)
  nav.handleNavTouch({ type: TouchType.Move, touches: [{ x: 10 }, { x: 20 }], changedTouches: [] })
  assert.equal(nav.tab, 'tools')
  assert.equal(nav.navDragging, false)
  touch(TouchType.Down, 10)
  touch(TouchType.Move, 450, 20)
  assert.equal(nav.tab, 'settings', 'fast horizontal exit must select the edge item')
})

test('coordinate bounds remain valid at different sizes and reject unmeasured layout', () => {
  assert.equal(navigationIndex(10, 0), -1)
  assert.equal(navigationIndex(320, 320), 3)
  assert.equal(navigationIndex(160, 320), 2)
  assert.equal(navigationGlowX(-10, 320, 72), 0)
  assert.equal(navigationGlowX(999, 320, 72), 248)
})

test('sheen re-arms across reappearance and stops while UI is inactive', () => {
  const {nav, tick, hasTimer} = fixture()
  Object.assign(nav, {uiForeground: true, pageAlive: true, reduceTransparency: false})
  nav.startNavSheen(); assert.equal(hasTimer(), true)
  tick(); assert.equal(nav.navSheenPhase, true)
  tick(); assert.equal(nav.navSheenPhase, false)
  nav.stopNavSheen(); assert.equal(hasTimer(), false)
  nav.startNavSheen(); tick(); assert.equal(nav.navSheenPhase, true)
  nav.uiForeground = false
  nav.stopNavSheen(); nav.startNavSheen(); assert.equal(hasTimer(), false)
})
