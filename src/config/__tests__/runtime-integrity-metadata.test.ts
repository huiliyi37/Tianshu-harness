import assert from 'node:assert/strict'
import { sign as cryptoSign } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { LICENSE_PRODUCT } from '../license-keys.js'
import {
  INTEGRITY_MANIFEST_FILENAME,
  INTEGRITY_MANIFEST_VERSION,
  computeBundle,
  integritySigningMessage,
  verifyIntegrityManifest,
  type IntegrityManifest,
  type IntegrityMode,
} from '../runtime-integrity.js'
import { makeTestSigner } from './grant-fixtures.js'

for (const mode of ['code', 'full'] satisfies IntegrityMode[]) {
  test(`${mode}: AppleDouble metadata leaves signed bundle bytes unchanged`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'rivet-integrity-metadata-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(join(root, 'native'))
    writeFileSync(join(root, 'app.js'), 'console.log(1)\n')
    writeFileSync(join(root, 'keep._part.js'), 'export const keep = true\n')
    writeFileSync(join(root, 'native', 'addon.node'), Buffer.from([0, 1, 255, 2]))

    const before = computeBundle(root, mode)
    assert.deepEqual(Object.keys(before.files), ['app.js', 'keep._part.js', 'native/addon.node'])
    const { privateKey, publicKeyB64 } = makeTestSigner()
    const base = {
      v: INTEGRITY_MANIFEST_VERSION,
      product: LICENSE_PRODUCT,
      mode,
      createdAt: 1,
      ...before,
    }
    const manifest: IntegrityManifest = {
      ...base,
      sig: cryptoSign(null, Buffer.from(integritySigningMessage(base), 'utf8'), privateKey).toString('base64url'),
    }
    assert.equal(verifyIntegrityManifest(root, { mode, publicKeyB64, manifest }).ok, true)
    writeFileSync(join(root, INTEGRITY_MANIFEST_FILENAME), JSON.stringify(manifest))

    // Explicit sidecars also exercise this behavior on filesystems that do not create them.
    for (const relative of ['._app.js', '._integrity.json', 'native/._addon.node']) {
      writeFileSync(join(root, relative), Buffer.from([0, 5, 22, 7]))
    }
    mkdirSync(join(root, '._metadata'))
    writeFileSync(join(root, '._metadata', 'extra.js'), 'filesystem metadata\n')

    assert.deepEqual(computeBundle(root, mode), before)
    assert.equal(verifyIntegrityManifest(root, { mode, publicKeyB64 }).ok, true)

    writeFileSync(join(root, 'keep._part.js'), 'export const keep = false\n')
    const changed = verifyIntegrityManifest(root, { mode, publicKeyB64 })
    assert.equal(changed.ok, false)
    assert.equal(changed.reason, 'digest_mismatch')
    assert.deepEqual(changed.changed, ['~keep._part.js'])
  })
}
