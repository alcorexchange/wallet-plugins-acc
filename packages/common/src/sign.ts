import { transactionSigningMessage, transactionSigningText } from '@wharfkit/antelope'
import type { Checksum256, PublicKey, ResolvedSigningRequest, Signature } from '@wharfkit/session'

import { WrongAccount } from './errors.js'

/** The Antelope signing digest of a request: sha256(chain id ‖ transaction ‖ context-free data hash). */
export function requestDigest(resolved: ResolvedSigningRequest): Checksum256 {
  return resolved.transaction.signingDigest(resolved.chainId)
}

/** The text the wallet signs for a digest. Comes from the library: the chain verifies exactly it. */
export function signingText(digest: Checksum256): string {
  return transactionSigningText(digest.array)
}

/** The UTF-8 bytes of `signingText(digest)`, as a Solana wallet signs them. */
export function signingMessage(digest: Checksum256): Uint8Array {
  return transactionSigningMessage(digest.array)
}

/** Refuse a signature that would not satisfy the chain: it must recover to the session's key over the digest. */
export function assertSignedBy(signature: Signature, digest: Checksum256, publicKey: PublicKey): void {
  let recovered: PublicKey
  try {
    recovered = signature.recoverDigest(digest)
  } catch (error) {
    throw new WrongAccount(`The wallet's signature does not verify: ${(error as Error).message}`)
  }
  if (!recovered.equals(publicKey)) {
    throw new WrongAccount(`The wallet signed with ${recovered}, not with this session's key ${publicKey}`)
  }
}
