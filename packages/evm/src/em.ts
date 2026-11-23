import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { PublicKey, Signature } from '@wharfkit/session'

const N = secp256k1.CURVE.n

/** The parts of a wallet's `personal_sign` answer, in the one encoding the chain takes. */
export interface EmSignatureParts {
  r: Uint8Array
  s: Uint8Array
  recid: 0 | 1
}

/**
 * Parse a `personal_sign` answer (`0x` + 65 bytes `r ‖ s ‖ v`) and bring it to the chain's form:
 * v = 0 / 1 is taken as 27 / 28, and a high s becomes n − s with the recovery bit flipped.
 */
export function normalizeEmSignature(answer: unknown): EmSignatureParts {
  if (typeof answer !== 'string' || !/^0x[0-9a-fA-F]*$/.test(answer)) {
    throw new Error('The wallet did not answer with a hex signature')
  }
  const bytes = hexToBytes(answer.slice(2))
  if (bytes.length !== 65) {
    throw new Error(
      `The wallet returned a ${bytes.length}-byte signature, not 65 bytes. ` +
        'Alcor Chain needs a plain Ethereum account; smart-contract wallets do not work'
    )
  }
  const v = bytes[64]
  let recid: 0 | 1
  if (v === 27 || v === 28) recid = (v - 27) as 0 | 1
  else if (v === 0 || v === 1) recid = v
  else throw new Error(`The wallet returned a signature with v = ${v}, not 27 or 28`)

  let s = toBigInt(bytes.subarray(32, 64))
  if (s > N >> 1n) {
    s = N - s
    recid = (recid ^ 1) as 0 | 1
  }
  return { r: bytes.slice(0, 32), s: toBytes32(s), recid }
}

/** The chain signature `SIG_EM_0x r ‖ s ‖ v`, v = 27 + recid. */
export function emSignature(parts: EmSignatureParts): Signature {
  return Signature.from({ type: 'EM', r: parts.r, s: parts.s, recid: parts.recid })
}

/** EIP-191 `personal_sign` hash of a text. */
export function personalMessageHash(text: string): Uint8Array {
  const message = utf8ToBytes(text)
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${message.length}`)
  const data = new Uint8Array(prefix.length + message.length)
  data.set(prefix, 0)
  data.set(message, prefix.length)
  return keccak_256(data)
}

/** The uncompressed key (65 bytes, `04 ‖ x ‖ y`) that signed a text with `personal_sign`. */
export function recoverPersonalSigner(text: string, parts: EmSignatureParts): Uint8Array {
  const compact = new Uint8Array(64)
  compact.set(parts.r, 0)
  compact.set(parts.s, 32)
  const point = secp256k1.Signature.fromCompact(compact)
    .addRecoveryBit(parts.recid)
    .recoverPublicKey(personalMessageHash(text))
  return point.toRawBytes(false)
}

/** The Ethereum address of an uncompressed key: the last 20 bytes of keccak-256(x ‖ y), lowercase. */
export function ethAddress(uncompressed: Uint8Array): string {
  if (uncompressed.length !== 65 || uncompressed[0] !== 4) throw new Error('Expected an uncompressed secp256k1 key')
  return '0x' + bytesToHex(keccak_256(uncompressed.subarray(1)).subarray(12))
}

/** `PUB_EM_04…` for an uncompressed key. */
export function emPublicKey(uncompressed: Uint8Array): PublicKey {
  return PublicKey.from(`PUB_EM_${bytesToHex(uncompressed)}`)
}

/** `0x` + hex of the UTF-8 bytes: how `personal_sign` takes a text without guessing its encoding. */
export function utf8Hex(text: string): string {
  return '0x' + bytesToHex(utf8ToBytes(text))
}

function toBigInt(bytes: Uint8Array): bigint {
  return BigInt('0x' + bytesToHex(bytes))
}

function toBytes32(value: bigint): Uint8Array {
  return hexToBytes(value.toString(16).padStart(64, '0'))
}
