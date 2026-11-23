import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TRANSACTION_SIGNING_PREFIX } from '@wharfkit/antelope'
import {
  LOGIN_TITLE,
  NoAccount,
  WalletPluginEvm,
  WalletRejected,
  WrongAccount,
  normalizeEmSignature,
  requestDigest,
} from '@alcorexchange/wallet-plugin-evm'

import {
  FAUCET,
  ORIGIN,
  PLUGIN_CHAINS,
  det,
  emPubOf,
  ethAddressOf,
  expectedDigest,
  makeKit,
  memoryStorage,
  mockChain,
  mockEthereum,
  mockUI,
  loginContext,
  transfer,
} from './helpers.mjs'
import { verdict } from './oracle.mjs'

const priv = det('evm test key')
const pub = emPubOf(priv)
const address = ethAddressOf(priv)
const chainWith = (extra = {}) => mockChain({ accounts: { alice: { owner: [pub], active: [pub] } }, ...extra })

/** Log in and sign a transfer; return what the test checks. */
async function loginAndSign(mode = {}, { chain = chainWith() } = {}) {
  const provider = mockEthereum(priv, mode)
  const plugin = new WalletPluginEvm({ provider, chains: PLUGIN_CHAINS })
  const { session } = await makeKit(plugin, { chain }).login()
  const result = await transfer(session)
  const digest = requestDigest(result.resolved)
  const [signature] = result.signatures
  return { provider, plugin, session, result, digest, signature }
}

/** Every signature handed to Session Kit must be one the chain accepts for the key. */
function assertChainAccepts(digest, signature) {
  assert.equal(verdict({ kind: 'em', digest: digest.hexString, pub, sig: String(signature) }), 'accept')
}

test('login: the key is recovered from the login signature and the address checked', async () => {
  const provider = mockEthereum(priv)
  const plugin = new WalletPluginEvm({ provider, chains: PLUGIN_CHAINS })
  const { session } = await makeKit(plugin, { chain: chainWith() }).login()

  assert.equal(String(session.permissionLevel), 'alice@active')
  assert.equal(plugin.data.publicKey, pub)
  assert.equal(plugin.data.address, address)

  const text = provider.lastMessage
  assert.ok(text.startsWith(LOGIN_TITLE + '\n'))
  assert.ok(!text.startsWith(TRANSACTION_SIGNING_PREFIX))
  assert.match(text, new RegExp(`^Origin: ${ORIGIN}$`, 'm'))
  assert.match(text, new RegExp(`^Address: ${address}$`, 'm'))
  assert.match(text, /^Issued at: \d{4}-\d\d-\d\dT[\d:.]+Z$/m)
})

test('sign: personal_sign of the library text; the signature recovers to the key over the digest', async () => {
  const { provider, result, digest, signature } = await loginAndSign()
  assert.equal(digest.hexString, expectedDigest(result.resolved.transaction))
  assert.equal(provider.lastMessage, TRANSACTION_SIGNING_PREFIX + digest.hexString)
  assert.match(String(signature), /^SIG_EM_0x[0-9a-f]{128}(1b|1c)$/)
  assert.equal(String(signature.recoverDigest(digest)), pub)
  assertChainAccepts(digest, signature)
})

test('sign: v = 0 / 1 from the wallet becomes 27 / 28', async () => {
  const { provider, digest, signature } = await loginAndSign({ v01: true })
  const raw = provider.lastAnswer
  assert.ok(raw.endsWith('00') || raw.endsWith('01'))
  assert.equal(verdict({ kind: 'em', digest: digest.hexString, pub, sig: 'SIG_EM_' + raw }), 'reject')
  assert.equal(String(signature).slice(0, -2), 'SIG_EM_' + raw.slice(0, -2))
  assertChainAccepts(digest, signature)
})

test('sign: a high s from the wallet becomes n - s with v flipped', async () => {
  const { provider, digest, signature } = await loginAndSign({ highS: true })
  const raw = provider.lastAnswer
  assert.equal(verdict({ kind: 'em', digest: digest.hexString, pub, sig: 'SIG_EM_' + raw }), 'reject')
  assert.notEqual(String(signature), 'SIG_EM_' + raw)
  assert.notEqual(String(signature).slice(-2), raw.slice(-2))
  assertChainAccepts(digest, signature)
})

test('sign: v = 0 / 1 and high s together', async () => {
  const { digest, signature } = await loginAndSign({ v01: true, highS: true })
  assertChainAccepts(digest, signature)
})

test('login: a rejection in the wallet is WalletRejected', async () => {
  for (const method of ['eth_requestAccounts', 'personal_sign']) {
    const plugin = new WalletPluginEvm({ provider: mockEthereum(priv, { reject: [method] }), chains: PLUGIN_CHAINS })
    await assert.rejects(() => plugin.login(loginContext(chainWith())), WalletRejected, method)
  }
})

test('sign: a rejection in the wallet is WalletRejected', async () => {
  const provider = mockEthereum(priv)
  const plugin = new WalletPluginEvm({ provider, chains: PLUGIN_CHAINS })
  const { session } = await makeKit(plugin, { chain: chainWith() }).login()
  provider.mode.reject = ['personal_sign']
  await assert.rejects(() => transfer(session), /You rejected the request in/)
})

test('login: a wallet signing with another key than the connected address fails', async () => {
  const plugin = new WalletPluginEvm({ provider: mockEthereum(priv, { signWith: det('other key') }), chains: PLUGIN_CHAINS })
  await assert.rejects(() => plugin.login(loginContext(chainWith())), (error) => {
    assert.ok(error instanceof WrongAccount)
    assert.match(error.message, new RegExp(`not with the connected ${address}`))
    return true
  })
})

test('sign: the wallet switched to another address', async () => {
  const provider = mockEthereum(priv)
  const plugin = new WalletPluginEvm({ provider, chains: PLUGIN_CHAINS })
  const { session } = await makeKit(plugin, { chain: chainWith() }).login()
  const other = ethAddressOf(det('other key'))
  provider.mode.accounts = [other]
  provider.mode.requestAccounts = [other]
  await assert.rejects(() => transfer(session), new RegExp(`Switch to ${address}`))
})

test('sign: a wallet signing with another key is refused before Session Kit gets it', async () => {
  const provider = mockEthereum(priv)
  const plugin = new WalletPluginEvm({ provider, chains: PLUGIN_CHAINS })
  const { session } = await makeKit(plugin, { chain: chainWith() }).login()
  provider.mode.signWith = det('other key')
  await assert.rejects(() => transfer(session), /not with this session's key/)
})

test('login: no account for the key points to account creation', async () => {
  const plugin = new WalletPluginEvm({ provider: mockEthereum(priv), chains: PLUGIN_CHAINS })
  await assert.rejects(() => plugin.login(loginContext(mockChain())), (error) => {
    assert.ok(error instanceof NoAccount)
    assert.equal(error.publicKey, pub)
    assert.equal(error.createAccountUrl, FAUCET)
    assert.ok(error.message.includes(FAUCET))
    return true
  })
})

test('login: several accounts, the person picks one in the dialog', async () => {
  const chain = mockChain({ accounts: { alice: { active: [pub] }, bob: { owner: [pub] }, carol: { active: [pub], owner: [pub] } } })
  const ui = mockUI({ pick: 'bob@owner' })
  const plugin = new WalletPluginEvm({ provider: mockEthereum(priv), chains: PLUGIN_CHAINS })
  const { session } = await makeKit(plugin, { chain, ui }).login()
  assert.equal(String(session.permissionLevel), 'bob@owner')
  assert.deepEqual(
    ui.prompts[0].elements.map((e) => e.data.label),
    ['alice@active', 'bob@owner', 'carol@active']
  )
})

test('login: the app asks for a permission the key does not hold', async () => {
  const plugin = new WalletPluginEvm({ provider: mockEthereum(priv), chains: PLUGIN_CHAINS })
  const kit = makeKit(plugin, { chain: chainWith() })
  await assert.rejects(() => kit.login({ permissionLevel: 'bob@active' }), /bob@active is not controlled by/)
})

test('login: the node has no get_accounts_by_authorizers, Hyperion finds the account', async () => {
  const chain = chainWith({ byAuthorizers: false })
  const { session, digest, signature } = await loginAndSign({}, { chain })
  assert.equal(String(session.permissionLevel), 'alice@active')
  assert.ok(chain.requests.some((r) => r.url.includes('/v2/state/get_key_accounts?public_key=' + pub)))
  assertChainAccepts(digest, signature)
})

test('login: no account query on the node and no Hyperion set', async () => {
  const plugin = new WalletPluginEvm({ provider: mockEthereum(priv) })
  await assert.rejects(
    () => plugin.login(loginContext(chainWith({ byAuthorizers: false }))),
    /no Hyperion is set for this chain/
  )
})

test('a restored session signs with the same wallet', async () => {
  const storage = memoryStorage()
  const provider = mockEthereum(priv)
  const chain = chainWith()
  await makeKit(new WalletPluginEvm({ provider, chains: PLUGIN_CHAINS }), { chain, storage }).login()

  const restored = await makeKit(new WalletPluginEvm({ provider, chains: PLUGIN_CHAINS }), { chain, storage }).restore()
  const result = await transfer(restored)
  assertChainAccepts(requestDigest(result.resolved), result.signatures[0])
})

test('EIP-6963: the person picks among announced wallets; a restored session finds its wallet by rdns', async () => {
  const metamask = mockEthereum(det('metamask key'))
  const rabby = mockEthereum(priv)
  const page = new EventTarget()
  page.addEventListener('eip6963:requestProvider', () => {
    for (const [name, rdns, provider] of [['MetaMask', 'io.metamask', metamask], ['Rabby', 'io.rabby', rabby]]) {
      page.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: rdns, name, icon: '', rdns }, provider } }))
    }
  })
  globalThis.window = page
  try {
    const storage = memoryStorage()
    const chain = chainWith()
    const ui = mockUI({ pick: 'Rabby' })
    const { session } = await makeKit(new WalletPluginEvm({ chains: PLUGIN_CHAINS, discoveryMs: 0 }), { chain, ui, storage }).login()
    assert.deepEqual(ui.prompts[0].elements.map((e) => e.data.label), ['MetaMask', 'Rabby'])
    assert.equal(session.walletPlugin.data.rdns, 'io.rabby')

    const restored = await makeKit(new WalletPluginEvm({ chains: PLUGIN_CHAINS, discoveryMs: 0 }), { chain, storage }).restore()
    const result = await transfer(restored)
    assert.equal(metamask.calls.length, 0)
    assertChainAccepts(requestDigest(result.resolved), result.signatures[0])
  } finally {
    delete globalThis.window
  }
})

test('window.ethereum when no wallet announces itself', async () => {
  const page = new EventTarget()
  page.ethereum = mockEthereum(priv)
  globalThis.window = page
  try {
    const { session } = await makeKit(new WalletPluginEvm({ chains: PLUGIN_CHAINS, discoveryMs: 0 }), { chain: chainWith() }).login()
    assert.equal(String(session.permissionLevel), 'alice@active')
  } finally {
    delete globalThis.window
  }
})

test('normalizeEmSignature refuses what it cannot fix', () => {
  const rs = '11'.repeat(32) + '22'.repeat(32)
  assert.throws(() => normalizeEmSignature('0x' + rs + '1d'), /v = 29/)
  assert.throws(() => normalizeEmSignature('0x' + rs), /64-byte signature/)
  assert.throws(() => normalizeEmSignature('0x' + rs + '1b' + '00'.repeat(32)), /smart-contract wallets/)
  assert.throws(() => normalizeEmSignature(undefined), /hex signature/)
  assert.equal(normalizeEmSignature('0x' + rs + '00').recid, 0)
  assert.equal(normalizeEmSignature('0x' + rs + '1c').recid, 1)
})
