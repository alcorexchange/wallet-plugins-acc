// Mock wallets, chain and Session Kit UI for the plugin tests. The wallets hold real keys (@noble/curves,
// what MetaMask and Phantom are built on) and sign the way the real ones do: personal_sign, signMessage.
import { secp256k1 } from '@noble/curves/secp256k1'
import { ed25519 } from '@noble/curves/ed25519'
import { keccak_256 } from '@noble/hashes/sha3'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { ChainDefinition, LoginContext, Serializer, SessionKit, cancelable } from '@wharfkit/session'

export const CHAIN_ID = '9ae36fa71c10a5494664d3e1f9c67fba5dca35d316848a57a8df115ad306978f'
export const RPC = 'https://api.test'
export const HYPERION = 'https://history.test'
export const FAUCET = 'https://acc.alcor.exchange/faucet'
export const ORIGIN = 'https://app.example'

globalThis.location = { origin: ORIGIN }

export const det = (label) => sha256(utf8ToBytes(label))
const N = secp256k1.CURVE.n

// ---------- Ethereum: an EIP-1193 provider with a real secp256k1 key

export function ethAddressOf(priv) {
  return '0x' + bytesToHex(keccak_256(secp256k1.getPublicKey(priv, false).subarray(1)).subarray(12))
}

export function emPubOf(priv) {
  return 'PUB_EM_' + bytesToHex(secp256k1.getPublicKey(priv, false))
}

function personalHash(message) {
  return keccak_256(Uint8Array.from([...utf8ToBytes(`\x19Ethereum Signed Message:\n${message.length}`), ...message]))
}

/**
 * modes: v01 (v = 0 / 1), highS (s = n − s, v flipped), reject (code 4001),
 * signWith (another private key signs), accounts (what eth_accounts answers).
 */
export function mockEthereum(priv, mode = {}) {
  const address = ethAddressOf(priv)
  const calls = []
  const provider = {
    calls,
    mode,
    async request({ method, params }) {
      calls.push({ method, params })
      if (mode.reject?.includes(method)) throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
      switch (method) {
        case 'eth_requestAccounts':
          return mode.requestAccounts ?? [address]
        case 'eth_accounts':
          return mode.accounts ?? [address]
        case 'personal_sign': {
          const [data, from] = params
          if (from.toLowerCase() !== (mode.requestAccounts?.[0] ?? address).toLowerCase()) throw new Error('unknown from')
          const message = hexToBytes(data.slice(2))
          provider.lastMessage = new TextDecoder().decode(message)
          const sig = secp256k1.sign(personalHash(message), mode.signWith ?? priv, { lowS: true })
          let s = sig.s, recid = sig.recovery
          if (mode.highS) { s = N - s; recid ^= 1 }
          const v = mode.v01 ? recid : 27 + recid
          const answer = '0x' + hex32(sig.r) + hex32(s) + v.toString(16).padStart(2, '0')
          provider.lastAnswer = answer
          return answer
        }
        default:
          throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 })
      }
    },
  }
  return provider
}

const hex32 = (n) => n.toString(16).padStart(64, '0')

// ---------- Solana: a Phantom-style provider and a Wallet Standard wallet with a real ed25519 key

export const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
export function base58(bytes) {
  let n = BigInt('0x' + (bytesToHex(bytes) || '0')), s = ''
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s }
  return s
}

export function edPubOf(seed) {
  return 'PUB_ED_' + base58(ed25519.getPublicKey(seed))
}

/** modes: reject ('connect' | 'signMessage'), signWith (another seed signs), connectSeed (connects another key). */
export function mockPhantom(seed, mode = {}) {
  const provider = {
    mode,
    signed: [],
    async connect() {
      if (mode.reject?.includes('connect')) throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
      const key = ed25519.getPublicKey(mode.connectSeed ?? seed)
      return { publicKey: { toBytes: () => key } }
    },
    async signMessage(message, display) {
      if (mode.reject?.includes('signMessage')) throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
      if (display !== 'utf8') throw new Error('expected utf8 display')
      provider.signed.push(new TextDecoder().decode(message))
      return { signature: ed25519.sign(message, mode.signWith ?? seed), publicKey: null }
    },
  }
  return provider
}

/** A Wallet Standard wallet. mode.prefix makes it sign a modified message, as the standard allows. */
export function mockStandardWallet(name, seed, mode = {}) {
  const publicKey = ed25519.getPublicKey(seed)
  const account = {
    address: base58(publicKey),
    publicKey,
    chains: ['solana:mainnet'],
    features: ['solana:signMessage'],
  }
  return {
    version: '1.0.0',
    name,
    icon: 'data:image/svg+xml;base64,',
    chains: ['solana:mainnet'],
    accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'solana:signMessage': {
        version: '1.1.0',
        signMessage: async ({ account: used, message }) => {
          if (used !== account) throw new Error('unknown account')
          if (mode.reject) throw new Error('User rejected the request.')
          const signedMessage = mode.prefix ? Uint8Array.from([...utf8ToBytes(mode.prefix), ...message]) : message
          return [{ signedMessage, signature: ed25519.sign(signedMessage, seed) }]
        },
      },
    },
  }
}

// ---------- The chain: a mock fetch for the RPC and Hyperion

const INFO = {
  server_version: '4adefb11',
  chain_id: CHAIN_ID,
  head_block_num: 56332,
  last_irreversible_block_num: 56330,
  last_irreversible_block_id: '0000dc0ac84c9d37b8408da41729dab8d2be44f8b503d91245e1ee035925802d',
  head_block_id: '0000dc0cdd1bb0f928bc578dd7e6039c6b9466f86a21383198ce2dbbe471147b',
  head_block_time: '2026-11-23T20:31:03.400',
  head_block_producer: 'alcor.bp1',
  virtual_block_cpu_limit: 140000000,
  virtual_block_net_limit: 1048576000,
  block_cpu_limit: 140000,
  block_net_limit: 1048576,
  server_version_string: 'v1.2.2-alcor-testnet.1',
  fork_db_head_block_num: 56332,
  fork_db_head_block_id: '0000dc0cdd1bb0f928bc578dd7e6039c6b9466f86a21383198ce2dbbe471147b',
}

const TOKEN_ABI = {
  version: 'eosio::abi/1.2',
  structs: [
    {
      name: 'transfer',
      base: '',
      fields: [
        { name: 'from', type: 'name' },
        { name: 'to', type: 'name' },
        { name: 'quantity', type: 'asset' },
        { name: 'memo', type: 'string' },
      ],
    },
  ],
  actions: [{ name: 'transfer', type: 'transfer', ricardian_contract: '' }],
}

/**
 * accounts: { name: { active: [keys], owner: [keys] } }. byAuthorizers: false makes the node answer 404
 * to get_accounts_by_authorizers, as the testnet node does.
 */
export function mockChain({ accounts = {}, byAuthorizers = true } = {}) {
  const requests = []
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const sameKey = (a, b) => a === b
  const fetch = async (input, init) => {
    const url = new URL(String(input))
    const body = init?.body ? JSON.parse(init.body) : undefined
    requests.push({ url: String(url), body })
    if (url.origin === HYPERION && url.pathname === '/v2/state/get_key_accounts') {
      const key = url.searchParams.get('public_key')
      const names = Object.entries(accounts)
        .filter(([, perms]) => Object.values(perms).some((keys) => keys.some((k) => sameKey(k, key))))
        .map(([name]) => name)
      return json({ account_names: names })
    }
    if (url.origin !== RPC) return json({ message: 'unknown host' }, 404)
    switch (url.pathname) {
      case '/v1/chain/get_info':
        return json(INFO)
      case '/v1/chain/get_accounts_by_authorizers': {
        if (!byAuthorizers) return json({ code: 404, message: 'Not Found', error: { what: 'Unknown Endpoint' } }, 404)
        const rows = []
        for (const [name, perms] of Object.entries(accounts)) {
          for (const [permission, keys] of Object.entries(perms)) {
            for (const key of keys) {
              if (body.keys.some((k) => sameKey(k, key))) {
                rows.push({ account_name: name, permission_name: permission, authorizing_key: key, weight: 1, threshold: 1 })
              }
            }
          }
        }
        return json({ accounts: rows })
      }
      case '/v1/chain/get_account': {
        const perms = accounts[body.account_name]
        if (!perms) return json({ code: 500, message: 'unknown account' }, 500)
        return json(accountObject(body.account_name, perms))
      }
      default:
        return json({ code: 404, message: 'Not Found' }, 404)
    }
  }
  return { fetch, requests }
}

function accountObject(name, perms) {
  const limit = { used: 0, available: 0, max: 0 }
  return {
    account_name: name,
    head_block_num: 1,
    head_block_time: '2026-11-23T20:31:03.400',
    privileged: false,
    last_code_update: '1970-01-01T00:00:00.000',
    created: '2026-11-23T17:20:44.000',
    ram_quota: 10000,
    net_weight: 0,
    cpu_weight: 0,
    net_limit: limit,
    cpu_limit: limit,
    ram_usage: 3000,
    permissions: Object.entries(perms).map(([perm_name, keys]) => ({
      perm_name,
      parent: perm_name === 'owner' ? '' : 'owner',
      required_auth: { threshold: 1, keys: keys.map((key) => ({ key, weight: 1 })), accounts: [], waits: [] },
    })),
  }
}

// ---------- Session Kit

/** A UI that records prompts and clicks the button labelled `pick` (or the first one). */
export function mockUI({ pick } = {}) {
  const prompts = []
  const ui = {
    prompts,
    errors: [],
    async login() { throw new Error('the plugins never need the UI login step') },
    async onError(error) { ui.errors.push(error) },
    async onAccountCreate() { return {} },
    async onAccountCreateComplete() {},
    async onLogin() {},
    async onLoginComplete() {},
    async onTransact() {},
    async onTransactComplete() {},
    async onSign() {},
    async onSignComplete() {},
    async onBroadcast() {},
    async onBroadcastComplete() {},
    prompt(args) {
      prompts.push(args)
      let reject
      const promise = cancelable(new Promise((_, r) => { reject = r }), (canceled) => { reject(canceled) })
      queueMicrotask(() => {
        const button = args.elements.find((e) => e.type === 'button' && (!pick || e.data.label === pick))
        button?.data.onClick()
      })
      return promise
    },
    status() {},
    translate: (key, options) => options?.default ?? key,
    getTranslate: () => (key, options) => options?.default ?? key,
    addTranslations() {},
  }
  return ui
}

export function memoryStorage() {
  const data = new Map()
  return {
    data,
    async write(key, value) { data.set(key, value) },
    async read(key) { return data.get(key) ?? null },
    async remove(key) { data.delete(key) },
  }
}

export function makeKit(plugin, { chain, ui = mockUI(), storage = memoryStorage() }) {
  return new SessionKit(
    { appName: 'test', chains: [{ id: CHAIN_ID, url: RPC }], ui, walletPlugins: [plugin] },
    { fetch: chain.fetch, storage, abis: [{ account: 'eosio.token', abi: TOKEN_ABI }] }
  )
}

export const PLUGIN_CHAINS = { [CHAIN_ID]: { hyperion: HYPERION, createAccountUrl: FAUCET } }

/** A transfer signed but not broadcast; returns Session Kit's result. */
export function transfer(session, quantity = '1.0000 HORN') {
  return session.transact(
    {
      action: {
        account: 'eosio.token',
        name: 'transfer',
        authorization: [session.permissionLevel],
        data: { from: session.actor, to: 'faucet', quantity, memo: 'test' },
      },
    },
    { broadcast: false }
  )
}

/** Session Kit's login context, for calling plugin.login directly: SessionKit.login rethrows errors as plain Error. */
export function loginContext(chain, ui = mockUI()) {
  const definition = ChainDefinition.from({ id: CHAIN_ID, url: RPC })
  return new LoginContext({ appName: 'test', chain: definition, chains: [definition], fetch: chain.fetch, ui })
}

/** The Antelope signing digest computed here, not by the plugin: sha256(chain id ‖ transaction ‖ 32 zero bytes). */
export function expectedDigest(transaction) {
  const tx = Serializer.encode({ object: transaction }).array
  return bytesToHex(sha256(Uint8Array.from([...hexToBytes(CHAIN_ID), ...tx, ...new Uint8Array(32)])))
}
