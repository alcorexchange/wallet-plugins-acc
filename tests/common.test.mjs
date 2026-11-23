import assert from 'node:assert/strict'
import { test } from 'node:test'
import { APIClient, PermissionLevel, PublicKey, cancelable } from '@wharfkit/session'
import { chooseOne, findPermissions, isUserRejection, loginText, preferActive } from '@alcorexchange/acc-wallet-common'

import { RPC, det, edPubOf } from './helpers.mjs'

const pub = PublicKey.from(edPubOf(det('common key')))
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

test('findPermissions keeps only permissions the key satisfies alone', async () => {
  const fetch = async () =>
    json({
      accounts: [
        { account_name: 'alice', permission_name: 'active', authorizing_key: String(pub), weight: 1, threshold: 1 },
        { account_name: 'multisig', permission_name: 'active', authorizing_key: String(pub), weight: 1, threshold: 2 },
        { account_name: 'alice', permission_name: 'active', authorizing_key: String(pub), weight: 1, threshold: 1 },
      ],
    })
  const client = new APIClient({ url: RPC, fetch })
  const found = await findPermissions(client, fetch, pub)
  assert.deepEqual(found.map(String), ['alice@active'])
})

test('preferActive drops owner where the key holds active too', () => {
  const list = ['a@owner', 'a@active', 'b@owner', 'c@trade'].map((p) => PermissionLevel.from(p))
  assert.deepEqual(preferActive(list).map(String), ['a@active', 'b@owner', 'c@trade'])
})

test('chooseOne: closing the dialog rejects; one option asks nothing', async () => {
  let prompts = 0
  const ui = {
    prompt() {
      prompts++
      let reject
      const promise = cancelable(new Promise((_, r) => { reject = r }), (c) => reject(c))
      queueMicrotask(() => promise.cancel('Modal closed', true))
      return promise
    },
  }
  await assert.rejects(() => chooseOne(ui, 'Pick', '', [{ label: 'a', value: 1 }, { label: 'b', value: 2 }]), /Modal closed/)
  assert.equal(await chooseOne(ui, 'Pick', '', [{ label: 'a', value: 1 }]), 1)
  assert.equal(prompts, 1)
})

test('isUserRejection: EIP-1193 4001 and the usual wallet messages, nothing else', () => {
  assert.ok(isUserRejection({ code: 4001, message: 'x' }))
  assert.ok(isUserRejection(new Error('User rejected the request.')))
  assert.ok(isUserRejection(new Error('Approval denied by user')))
  assert.ok(!isUserRejection(new Error('Network error')))
  assert.ok(!isUserRejection({ code: -32603, message: 'Internal error' }))
  assert.ok(!isUserRejection(undefined))
})

test('loginText has the fields in a fixed order', () => {
  assert.equal(
    loginText({ origin: 'https://a.b', address: '0xab', issuedAt: '2026-11-23T00:00:00.000Z' }),
    'Alcor Chain login\nOrigin: https://a.b\nAddress: 0xab\nIssued at: 2026-11-23T00:00:00.000Z\n\n' +
      'This shows the app which key is yours. It is not a transaction and moves no funds.'
  )
})
