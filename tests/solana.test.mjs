import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getWallets } from '@wallet-standard/app'
import { TRANSACTION_SIGNING_PREFIX } from '@wharfkit/antelope'
import {
  LOGIN_TITLE,
  NoAccount,
  WalletPluginSolana,
  WalletRejected,
  WrongAccount,
  requestDigest,
} from '@alcorexchange/wallet-plugin-solana'

import {
  FAUCET,
  ORIGIN,
  PLUGIN_CHAINS,
  det,
  edPubOf,
  expectedDigest,
  loginContext,
  makeKit,
  memoryStorage,
  mockChain,
  mockPhantom,
  mockStandardWallet,
  mockUI,
  transfer,
} from './helpers.mjs'
import { verdict } from './oracle.mjs'

const seed = det('solana test key')
const pub = edPubOf(seed)
const address = pub.slice('PUB_ED_'.length)
const chainWith = (extra = {}) => mockChain({ accounts: { alice: { active: [pub] } }, ...extra })

function assertChainAccepts(digest, signature) {
  assert.equal(verdict({ kind: 'ed', digest: digest.hexString, pub, sig: String(signature) }), 'accept')
}

test('login: the wallet key, a verified login signature, the account', async () => {
  const provider = mockPhantom(seed)
  const plugin = new WalletPluginSolana({ provider, chains: PLUGIN_CHAINS })
  const { session } = await makeKit(plugin, { chain: chainWith() }).login()

  assert.equal(String(session.permissionLevel), 'alice@active')
  assert.equal(plugin.data.publicKey, pub)
  const [text] = provider.signed
  assert.ok(text.startsWith(LOGIN_TITLE + '\n'))
  assert.ok(!text.startsWith(TRANSACTION_SIGNING_PREFIX))
  assert.match(text, new RegExp(`^Origin: ${ORIGIN}$`, 'm'))
  assert.match(text, new RegExp(`^Address: ${address}$`, 'm'))
})

test('sign: signMessage of the library text; SIG_ED_ verifies against the key over the digest', async () => {
  const provider = mockPhantom(seed)
  const { session } = await makeKit(new WalletPluginSolana({ provider, chains: PLUGIN_CHAINS }), { chain: chainWith() }).login()
  const result = await transfer(session)
  const digest = requestDigest(result.resolved)
  const [signature] = result.signatures

  assert.equal(digest.hexString, expectedDigest(result.resolved.transaction))
  assert.equal(provider.signed.at(-1), TRANSACTION_SIGNING_PREFIX + digest.hexString)
  assert.match(String(signature), /^SIG_ED_[1-9A-HJ-NP-Za-km-z]+$/)
  assert.equal(String(signature.recoverDigest(digest)), pub)
  assertChainAccepts(digest, signature)
})

test('login and sign: a rejection in the wallet is WalletRejected', async () => {
  for (const step of ['connect', 'signMessage']) {
    const plugin = new WalletPluginSolana({ provider: mockPhantom(seed, { reject: [step] }), chains: PLUGIN_CHAINS })
    await assert.rejects(() => plugin.login(loginContext(chainWith())), WalletRejected, step)
  }
  const provider = mockPhantom(seed)
  const { session } = await makeKit(new WalletPluginSolana({ provider, chains: PLUGIN_CHAINS }), { chain: chainWith() }).login()
  provider.mode.reject = ['signMessage']
  await assert.rejects(() => transfer(session), /You rejected the request in/)
})

test('login: a wallet signing with another key than the one it connected fails', async () => {
  const plugin = new WalletPluginSolana({ provider: mockPhantom(seed, { signWith: det('other') }), chains: PLUGIN_CHAINS })
  await assert.rejects(() => plugin.login(loginContext(chainWith())), WrongAccount)
})

test('sign: the wallet switched to another key', async () => {
  const provider = mockPhantom(seed)
  const { session } = await makeKit(new WalletPluginSolana({ provider, chains: PLUGIN_CHAINS }), { chain: chainWith() }).login()
  provider.mode.connectSeed = det('other')
  await assert.rejects(() => transfer(session), new RegExp(`Switch to ${address}`))
})

test('sign: a wallet signing with another key is refused before Session Kit gets it', async () => {
  const provider = mockPhantom(seed)
  const { session } = await makeKit(new WalletPluginSolana({ provider, chains: PLUGIN_CHAINS }), { chain: chainWith() }).login()
  provider.mode.signWith = det('other')
  await assert.rejects(() => transfer(session), /does not verify|not with this session's key/)
})

test('login: no account for the key points to account creation', async () => {
  const plugin = new WalletPluginSolana({ provider: mockPhantom(seed), chains: PLUGIN_CHAINS })
  await assert.rejects(() => plugin.login(loginContext(mockChain())), (error) => {
    assert.ok(error instanceof NoAccount)
    assert.equal(error.publicKey, pub)
    assert.equal(error.createAccountUrl, FAUCET)
    return true
  })
})

test('login: Hyperion finds the account when the node has no account query', async () => {
  const chain = chainWith({ byAuthorizers: false })
  const { session } = await makeKit(new WalletPluginSolana({ provider: mockPhantom(seed), chains: PLUGIN_CHAINS }), { chain }).login()
  assert.equal(String(session.permissionLevel), 'alice@active')
  assert.ok(chain.requests.some((r) => r.url.includes('get_key_accounts?public_key=' + encodeURIComponent(pub))))
})

test('Wallet Standard: the person picks among wallets; a restored session finds its wallet by name', async () => {
  const unregister = getWallets().register(
    mockStandardWallet('Solflare', det('solflare key')),
    mockStandardWallet('Backpack', seed)
  )
  try {
    const storage = memoryStorage()
    const chain = chainWith()
    const ui = mockUI({ pick: 'Backpack' })
    const { session } = await makeKit(new WalletPluginSolana({ chains: PLUGIN_CHAINS }), { chain, ui, storage }).login()
    assert.deepEqual(ui.prompts[0].elements.map((e) => e.data.label), ['Solflare', 'Backpack'])
    assert.equal(String(session.permissionLevel), 'alice@active')

    const restored = await makeKit(new WalletPluginSolana({ chains: PLUGIN_CHAINS }), { chain, storage }).restore()
    const result = await transfer(restored)
    assertChainAccepts(requestDigest(result.resolved), result.signatures[0])
  } finally {
    unregister()
  }
})

test('Wallet Standard: a wallet that changes the message before signing is refused', async () => {
  const unregister = getWallets().register(mockStandardWallet('Ledgerish', seed, { prefix: '\xffsolana offchain' }))
  try {
    const plugin = new WalletPluginSolana({ chains: PLUGIN_CHAINS })
    await assert.rejects(() => plugin.login(loginContext(chainWith())), /changed the message before signing/)
  } finally {
    unregister()
  }
})

test('Wallet Standard: a rejection without an error code is still WalletRejected', async () => {
  const unregister = getWallets().register(mockStandardWallet('Solflare', seed, { reject: true }))
  try {
    const plugin = new WalletPluginSolana({ chains: PLUGIN_CHAINS })
    await assert.rejects(() => plugin.login(loginContext(chainWith())), WalletRejected)
  } finally {
    unregister()
  }
})

test('window.phantom.solana when no Wallet Standard wallet is registered', async () => {
  globalThis.window = { phantom: { solana: mockPhantom(seed) } }
  try {
    const { session } = await makeKit(new WalletPluginSolana({ chains: PLUGIN_CHAINS }), { chain: chainWith() }).login()
    const result = await transfer(session)
    assertChainAccepts(requestDigest(result.resolved), result.signatures[0])
  } finally {
    delete globalThis.window
  }
})
