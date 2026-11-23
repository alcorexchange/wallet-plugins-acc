// The differential corpus rules of the alcor-chain signature corpus (alcor-chain unittests/test-data/keys-oracle), applied with @noble/curves
// directly, not with the library fork. Given a digest, a key and a signature in the chain's string forms:
//   accept    recovery gives exactly the key
//   mismatch  recovery works but gives another key
//   reject    recovery fails: EM v not 27 / 28, r or s out of range, high s; ED not verifying against its key
// The signing text prefix is the corpus's own, so a library that drifts from it fails the tests.
import { readFileSync } from 'node:fs'
import { secp256k1 } from '@noble/curves/secp256k1'
import { ed25519 } from '@noble/curves/ed25519'
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'

import { B58 } from './helpers.mjs'

export const CORPUS_PATH = new URL('./data/keys-corpus.json', import.meta.url)
export const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'))

const N = secp256k1.CURVE.n
const text = (digestHex) => utf8ToBytes(corpus.prefix + digestHex)

function unbase58(s) {
  let n = 0n
  for (const c of s) {
    const i = B58.indexOf(c)
    if (i < 0) throw new Error('bad base58')
    n = n * 58n + BigInt(i)
  }
  const body = n === 0n ? [] : hexToBytes(n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, '0'))
  const zeros = s.match(/^1*/)[0].length
  return Uint8Array.from([...new Array(zeros).fill(0), ...body])
}

function emVerdict(digest, pub, sig) {
  const m = /^SIG_EM_0x([0-9a-f]{130})$/.exec(sig)
  if (!m) return 'reject'
  const bytes = hexToBytes(m[1])
  const v = bytes[64]
  if (v !== 27 && v !== 28) return 'reject'
  const r = BigInt('0x' + bytesToHex(bytes.subarray(0, 32)))
  const s = BigInt('0x' + bytesToHex(bytes.subarray(32, 64)))
  if (r === 0n || r >= N || s === 0n || s > N >> 1n) return 'reject'
  const message = text(digest)
  const hash = keccak_256(Uint8Array.from([...utf8ToBytes(`\x19Ethereum Signed Message:\n${message.length}`), ...message]))
  let point
  try {
    point = new secp256k1.Signature(r, s).addRecoveryBit(v - 27).recoverPublicKey(hash)
  } catch {
    return 'reject'
  }
  return 'PUB_EM_' + bytesToHex(point.toRawBytes(false)) === pub ? 'accept' : 'mismatch'
}

function edVerdict(digest, pub, sig) {
  if (!sig.startsWith('SIG_ED_')) return 'reject'
  let bytes
  try {
    bytes = unbase58(sig.slice('SIG_ED_'.length))
  } catch {
    return 'reject'
  }
  if (bytes.length !== 96) return 'reject'
  const key = bytes.subarray(0, 32)
  let ok
  try {
    ok = ed25519.verify(bytes.subarray(32), text(digest), key, { zip215: false })
  } catch {
    ok = false
  }
  if (!ok) return 'reject'
  return 'PUB_ED_' + base58Of(key) === pub ? 'accept' : 'mismatch'
}

function base58Of(bytes) {
  let n = BigInt('0x' + (bytesToHex(bytes) || '0')), s = ''
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s }
  return s
}

/** The corpus verdict for one case: { kind: 'em' | 'ed', digest (hex), pub, sig }. */
export function verdict({ kind, digest, pub, sig }) {
  return kind === 'em' ? emVerdict(digest, pub, sig) : edVerdict(digest, pub, sig)
}
