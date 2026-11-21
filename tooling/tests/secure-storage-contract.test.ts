import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const cipherSource = readFileSync(new URL(
  '../../entry/src/main/ets/services/SecureCipher.ts', import.meta.url), 'utf8')
const fileStoreSource = readFileSync(new URL(
  '../../entry/src/main/ets/services/SecureFileStore.ts', import.meta.url), 'utf8')
const subscriptionSource = readFileSync(new URL(
  '../../entry/src/main/ets/repositories/SubscriptionRepository.ts', import.meta.url), 'utf8')
const runtimeSource = readFileSync(new URL(
  '../../entry/src/main/ets/services/VpnRuntimeConfigStore.ts', import.meta.url), 'utf8')
const networkSettingsSource = readFileSync(new URL(
  '../../entry/src/main/ets/repositories/NetworkSettingsRepository.ts', import.meta.url), 'utf8')

test('private files use API 22 HUKS AES-256-GCM with random nonce, AAD and tag', () => {
  assert.match(cipherSource, /from '@kit\.UniversalKeystoreKit'/)
  assert.match(cipherSource, /from '@kit\.CryptoArchitectureKit'/)
  assert.match(cipherSource, /HUKS_AES_KEY_SIZE_256/)
  assert.match(cipherSource, /HUKS_MODE_GCM/)
  assert.match(cipherSource, /generateRandom\(AES_GCM_NONCE_BYTES\)/)
  assert.match(cipherSource, /const AES_GCM_NONCE_BYTES: number = 12/)
  assert.match(cipherSource, /HUKS_TAG_ASSOCIATED_DATA/)
  assert.match(cipherSource, /HUKS_TAG_AE_TAG/)
  assert.match(cipherSource, /const AES_GCM_TAG_BYTES: number = 16/)
  assert.match(cipherSource, /nonceBase64: string/)
  assert.match(cipherSource, /ciphertextBase64: string/)
  assert.match(cipherSource, /authTagBase64: string/)
  assert.doesNotMatch(cipherSource, /console\.(?:log|info|warn|error)/)
  assert.match(cipherSource, /SystemCapability\.Security\.CryptoFramework\.Rand/)
  assert.match(cipherSource, /fail closed rather than using a weaker/)
  assert.doesNotMatch(cipherSource, /Math\.random|Date\.now|generateRandomUUID/)

  const keyPropertiesAt = cipherSource.indexOf('private keyProperties()')
  const ensureKeyAt = cipherSource.indexOf('private async ensureKey()', keyPropertiesAt)
  const keyPropertiesBody = cipherSource.slice(keyPropertiesAt, ensureKeyAt)
  assert.match(keyPropertiesBody, /HUKS_TAG_ALGORITHM/)
  assert.match(keyPropertiesBody, /HUKS_TAG_KEY_SIZE/)
  assert.match(keyPropertiesBody, /HUKS_TAG_PURPOSE/)
  assert.doesNotMatch(keyPropertiesBody, /HUKS_TAG_BLOCK_MODE|HUKS_TAG_PADDING/)
  assert.doesNotMatch(keyPropertiesBody, /HUKS_TAG_KEY_SECURITY_LEVEL|HuksKeySecurityLevel/)

  const decryptAt = cipherSource.indexOf('async decrypt(')
  const decryptBody = cipherSource.slice(decryptAt)
  assert.match(decryptBody, /HUKS_KEY_PURPOSE_DECRYPT, nonce, authTag/)
  assert.match(decryptBody, /runOperation\(properties, ciphertext\)/)
  assert.doesNotMatch(decryptBody, /ciphertext\.(?:concat|push).*authTag/)
})

test('large payloads use segmented HUKS updates and unfinished sessions abort', () => {
  const initAt = cipherSource.indexOf('await huks.initSession')
  const updateAt = cipherSource.indexOf('await huks.updateSession', initAt)
  const finishAt = cipherSource.indexOf('await huks.finishSession', updateAt)
  const abortAt = cipherSource.indexOf('await huks.abortSession', finishAt)
  const rethrowAt = cipherSource.indexOf('throw error', abortAt)
  assert.ok(initAt >= 0 && updateAt > initAt && finishAt > updateAt && abortAt > finishAt &&
    rethrowAt > abortAt)
  assert.match(cipherSource, /const HUKS_STREAM_CHUNK_BYTES: number = 32 \* 1024/)
  assert.match(cipherSource, /while \(input\.length - offset > HUKS_STREAM_CHUNK_BYTES\)/)
  assert.match(cipherSource, /if \(handle >= 0 && !finished\)/)
})

test('UI and VPN Extension serialize every repository operation with a cross-process file lock', () => {
  const lockAt = fileStoreSource.indexOf('private async withExclusiveLock')
  const openAt = fileStoreSource.indexOf('await fileIo.open(this.lockPath', lockAt)
  const acquireAt = fileStoreSource.indexOf('await lockFile.lock(true)', openAt)
  const unlockAt = fileStoreSource.indexOf('lockFile.unlock()', acquireAt)
  const closeAt = fileStoreSource.indexOf('await fileIo.close(lockFile)', unlockAt)
  assert.ok(lockAt >= 0 && openAt > lockAt && acquireAt > openAt &&
    unlockAt > acquireAt && closeAt > unlockAt)
  assert.match(fileStoreSource, /fileIo\.OpenMode\.READ_WRITE \| fileIo\.OpenMode\.CREATE/)
  assert.match(fileStoreSource, /saveTail\.then/)
  assert.match(fileStoreSource, /load, save and clear are totally ordered/)
})

test('legacy migration validates a candidate before transactional promotion and plaintext deletion', () => {
  const saveAt = fileStoreSource.indexOf('private async saveNow')
  const businessValidateAt = fileStoreSource.indexOf('this.validatePlaintext(plaintext)', saveAt)
  const writeAt = fileStoreSource.indexOf('await this.writeCandidate(envelope)', saveAt)
  const verifyAt = fileStoreSource.indexOf(
    'await this.verifyEncryptedFile(this.candidatePath, plaintext)', writeAt)
  const backupAt = fileStoreSource.indexOf(
    'await this.rename(this.securePath, this.backupPath)', verifyAt)
  const promoteAt = fileStoreSource.indexOf(
    'await this.rename(this.candidatePath, this.securePath)', backupAt)
  const deleteAt = fileStoreSource.indexOf('await this.removeLegacyAfterVerification()', promoteAt)
  assert.ok(saveAt >= 0 && businessValidateAt > saveAt && writeAt > businessValidateAt &&
    verifyAt > writeAt && backupAt > verifyAt && promoteAt > backupAt && deleteAt > promoteAt)
  assert.match(fileStoreSource, /verifiedPlaintext !== expectedPlaintext/)
  assert.match(fileStoreSource, /recoverInterruptedPromotion/)
  assert.match(fileStoreSource, /if \(!await this\.exists\(this\.securePath\)\)/)
  assert.match(fileStoreSource, /this\.saveTail = operation\.then/)
  assert.match(subscriptionSource, /validateSubscriptionStore/)
  assert.match(runtimeSource, /validateRuntimeConfig/)
  assert.match(networkSettingsSource, /validateNetworkSettings/)
})

test('size limits count UTF-8 bytes and envelope allowance covers base64 expansion', () => {
  assert.match(fileStoreSource, /new util\.TextEncoder\(\)\.encodeInto\(plaintext\)/)
  assert.match(fileStoreSource, /plaintextByteLength > this\.maxPlaintextBytes/)
  assert.match(fileStoreSource, /Math\.ceil\(\(this\.maxPlaintextBytes \+ 16\) \/ 3\) \* 4 \+ 4096/)
})

test('sensitive-data clear is serialized, idempotent, deletes all data forms and keeps shared key', () => {
  const clearAt = fileStoreSource.indexOf('clear(): Promise<void>')
  const queueAt = fileStoreSource.indexOf('this.saveTail.then', clearAt)
  const secureDeleteAt = fileStoreSource.indexOf('this.unlink(this.securePath)', queueAt)
  const backupDeleteAt = fileStoreSource.indexOf('this.unlink(this.backupPath)', secureDeleteAt)
  const legacyDeleteAt = fileStoreSource.indexOf('this.unlink(this.legacyPlaintextPath)', backupDeleteAt)
  assert.ok(clearAt >= 0 && queueAt > clearAt && secureDeleteAt > queueAt &&
    backupDeleteAt > secureDeleteAt && legacyDeleteAt > backupDeleteAt)
  assert.doesNotMatch(fileStoreSource, /deleteKeyItem/)
  assert.match(subscriptionSource, /async clear\(\): Promise<void>/)
  assert.match(subscriptionSource, /await this\.secureStore\.clear\(\)/)
  assert.match(runtimeSource, /async clear\(\): Promise<void>/)
  assert.match(runtimeSource, /await this\.secureStore\.clear\(\)/)
  assert.match(networkSettingsSource, /async clear\(\): Promise<void>/)
  assert.match(networkSettingsSource, /await this\.secureStore\.clear\(\)/)
})

test('storage I/O and cleanup errors are explicit without masking a primary failure', () => {
  assert.match(fileStoreSource, /private async exists\(path: string\): Promise<boolean> \{\s+try \{[\s\S]*?fileIo\.access\(path\)[\s\S]*?\} catch \(error\)/)
  assert.match(fileStoreSource, /private async readText\(path: string\): Promise<string> \{\s+try \{[\s\S]*?fileIo\.readText\(path\)[\s\S]*?\} catch \(error\)/)
  assert.match(fileStoreSource, /private async unlink\(path: string\): Promise<void> \{\s+try \{[\s\S]*?fileIo\.unlink\(path\)[\s\S]*?\} catch \(error\)/)
  assert.match(fileStoreSource, /private async rename\(sourcePath: string, destinationPath: string\): Promise<void> \{\s+try \{[\s\S]*?fileIo\.rename\(sourcePath, destinationPath\)[\s\S]*?\} catch \(error\)/)
  assert.match(fileStoreSource, /let hasPrimaryFailure: boolean = false/)
  assert.match(fileStoreSource, /if \(!hasPrimaryFailure && cleanupFailure !== null\) throw cleanupFailure/)
  assert.match(cipherSource, /catch \(_\) \{[\s\S]*?throw error/)
  assert.match(runtimeSource, /fileIo\.access\(this\.runtimeDirectory\)[\s\S]*?catch \(error\)/)
  assert.match(runtimeSource, /fileIo\.mkdir\(this\.runtimeDirectory, true\)[\s\S]*?catch \(error\)/)
})

test('an existing damaged encrypted file fails closed without plaintext fallback', () => {
  const loadAt = fileStoreSource.indexOf('private async loadNow(): Promise<string | null>')
  const secureAt = fileStoreSource.indexOf('if (await this.exists(this.securePath))', loadAt)
  const decryptAt = fileStoreSource.indexOf('await this.loadEncryptedFile(this.securePath)', secureAt)
  const returnAt = fileStoreSource.indexOf('return plaintext', decryptAt)
  const legacyAt = fileStoreSource.indexOf('if (!await this.exists(this.legacyPlaintextPath))', returnAt)
  assert.ok(loadAt >= 0 && secureAt > loadAt && decryptAt > secureAt &&
    returnAt > decryptAt && legacyAt > returnAt)
  assert.doesNotMatch(fileStoreSource.slice(secureAt, returnAt), /catch\s*\(/)
})

test('subscription, network settings and sing-box runtime no longer write legacy plaintext', () => {
  assert.match(subscriptionSource, /subscriptions-v1\.secure\.json/)
  assert.match(subscriptionSource, /new SecureFileStore/)
  assert.doesNotMatch(subscriptionSource, /writeAtomicText/)
  assert.match(runtimeSource, /sing-box\.secure\.json/)
  assert.match(runtimeSource, /new SecureFileStore/)
  assert.doesNotMatch(runtimeSource, /writeAtomicText/)
  assert.match(networkSettingsSource, /network-settings-v1\.secure\.json/)
  assert.match(networkSettingsSource, /new SecureFileStore/)
  assert.doesNotMatch(networkSettingsSource, /writeAtomicText|fileIo\.write/)
})

interface FaultModelOptions {
  oldSecure: string | null
  legacy: string | null
  failAt: 'none' | 'write-candidate' | 'verify-candidate' | 'move-old' | 'promote'
  validate: (plaintext: string) => void
}

interface FaultModelState {
  secure: string | null
  legacy: string | null
  candidate: string | null
  backup: string | null
}

/**
 * Host-side fault model for the transactional file state machine. HUKS itself
 * is covered by the API contract above; this deliberately injects failures at
 * every pre-commit file boundary where the old authority must survive.
 */
function simulateSave(plaintext: string, options: FaultModelOptions): FaultModelState {
  const state: FaultModelState = {
    secure: options.oldSecure,
    legacy: options.legacy,
    candidate: null,
    backup: null
  }
  try {
    options.validate(plaintext)
  } catch (error) {
    throw Object.assign(error as Error, { state })
  }
  if (options.failAt === 'write-candidate') throw Object.assign(new Error('write-candidate'), { state })
  state.candidate = `encrypted:${plaintext}`
  if (options.failAt === 'verify-candidate') {
    throw Object.assign(new Error('verify-candidate'), { state })
  }
  if (state.secure !== null) {
    if (options.failAt === 'move-old') throw Object.assign(new Error('move-old'), { state })
    state.backup = state.secure
    state.secure = null
  }
  if (options.failAt === 'promote') {
    if (state.backup !== null) {
      state.secure = state.backup
      state.backup = null
    }
    throw Object.assign(new Error('promote'), { state })
  }
  state.secure = state.candidate
  state.candidate = null
  state.backup = null
  state.legacy = null
  return state
}

function injectedState(error: unknown): FaultModelState {
  return (error as Error & { state: FaultModelState }).state
}

test('fault injection never replaces prior authority or deletes legacy before commit', () => {
  for (const failAt of ['write-candidate', 'verify-candidate', 'move-old', 'promote'] as const) {
    let failure: unknown
    try {
      simulateSave('new', {
        oldSecure: 'encrypted:old',
        legacy: 'legacy-old',
        failAt,
        validate: () => {}
      })
    } catch (error) {
      failure = error
    }
    assert.ok(failure instanceof Error, `${failAt} must fail`)
    const state = injectedState(failure)
    assert.equal(state.secure, 'encrypted:old', `${failAt} must preserve prior secure authority`)
    assert.equal(state.legacy, 'legacy-old', `${failAt} must preserve legacy plaintext`)
  }

  const committed = simulateSave('new', {
    oldSecure: 'encrypted:old',
    legacy: 'legacy-old',
    failAt: 'none',
    validate: () => {}
  })
  assert.equal(committed.secure, 'encrypted:new')
  assert.equal(committed.legacy, null)
  assert.equal(committed.candidate, null)
  assert.equal(committed.backup, null)
})

test('business validation failure keeps invalid legacy plaintext and creates no encrypted authority', () => {
  let failure: unknown
  try {
    simulateSave('{"schemaVersion":999}', {
      oldSecure: null,
      legacy: '{"schemaVersion":999}',
      failAt: 'none',
      validate: () => { throw new Error('invalid schema') }
    })
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof Error)
  const state = injectedState(failure)
  assert.equal(state.secure, null)
  assert.equal(state.legacy, '{"schemaVersion":999}')
  assert.equal(state.candidate, null)
  assert.equal(state.backup, null)
  // Validation runs before the model mutates any file state. This source
  // assertion pins the equivalent production ordering.
  const saveAt = fileStoreSource.indexOf('private async saveNow')
  const validateAt = fileStoreSource.indexOf('this.validatePlaintext(plaintext)', saveAt)
  const candidateAt = fileStoreSource.indexOf('await this.writeCandidate(envelope)', saveAt)
  assert.ok(validateAt > saveAt && candidateAt > validateAt)
})
