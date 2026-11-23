import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Checksum256, PublicKey, Signature, TRANSACTION_SIGNING_PREFIX } from '@wharfkit/antelope'

import { corpus, verdict } from './oracle.mjs'

test('the library signs the text the corpus signs', () => {
  assert.equal(TRANSACTION_SIGNING_PREFIX, corpus.prefix)
})

test('the test oracle gives every corpus case its expected answer', () => {
  assert.ok(corpus.cases.length > 300)
  for (const c of corpus.cases) assert.equal(verdict(c), c.expect, `${c.kind}: ${c.case}`)
})

// The linked fork must agree too, or the plugins would hand out what the chain refuses.
test('the linked library fork gives every corpus case its expected answer', () => {
  for (const c of corpus.cases) {
    let got
    try {
      got = Signature.from(c.sig).recoverDigest(Checksum256.from(c.digest)).equals(PublicKey.from(c.pub)) ? 'accept' : 'mismatch'
    } catch {
      got = 'reject'
    }
    assert.equal(got, c.expect, `${c.kind}: ${c.case}`)
  }
})
