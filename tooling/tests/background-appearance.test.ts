import test from 'node:test'
import assert from 'node:assert/strict'
import {BACKGROUND_SWATCHES,normalizeBackgroundColor,backgroundColorIsDark,validBackgroundImageName} from '../../entry/src/main/ets/domain/BackgroundAppearance.ts'

test('custom background accepts opaque RGB colors and rejects invalid or transparent values',()=>{
 assert.equal(normalizeBackgroundColor(' #abc '),'#AABBCC')
 assert.equal(normalizeBackgroundColor('e4f0fc'),'#E4F0FC')
 for(const value of ['', '#12','#GGGGGG','#00FFFFFF','red']) assert.throws(()=>normalizeBackgroundColor(value))
 assert.equal(backgroundColorIsDark('#000'),true);assert.equal(backgroundColorIsDark('#FFF'),false)
 assert.equal(new Set(BACKGROUND_SWATCHES.map(s=>normalizeBackgroundColor(s.color))).size,12)
})

test('persisted image names cannot escape private background storage',()=>{
 assert.equal(validBackgroundImageName('appearance-background-123.img'),true)
 for(const value of ['../secret','/tmp/a.jpg','https://example.invalid/image','appearance-background-1.img/../x',''])assert.equal(validBackgroundImageName(value),false)
})
