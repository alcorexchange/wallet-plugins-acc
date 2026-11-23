import { TRANSACTION_SIGNING_PREFIX } from '@wharfkit/antelope'

export const LOGIN_TITLE = 'Alcor Chain login'

export interface LoginTextFields {
  /** The page's origin, `https://app.example`. */
  origin: string
  /** `0x…` for an Ethereum wallet, the base58 public key for a Solana wallet. */
  address: string
  /** ISO 8601 UTC. */
  issuedAt: string
}

/**
 * The text a wallet signs at login. The plugin learns the key from it (Ethereum wallets give
 * only an address) and checks that the wallet signs plain messages the way the chain verifies them.
 * It is not a transaction, and it carries no server nonce: it is no proof of login for a backend.
 */
export function loginText({ origin, address, issuedAt }: LoginTextFields): string {
  const text = [
    LOGIN_TITLE,
    `Origin: ${origin}`,
    `Address: ${address}`,
    `Issued at: ${issuedAt}`,
    '',
    'This shows the app which key is yours. It is not a transaction and moves no funds.',
  ].join('\n')
  // The chain takes as a transaction signature only text that starts with the prefix.
  if (text.startsWith(TRANSACTION_SIGNING_PREFIX)) {
    throw new Error('Login text must not look like a transaction')
  }
  return text
}

/** The origin of the page the plugin runs on. */
export function pageOrigin(): string {
  const origin = globalThis.location?.origin
  if (!origin) throw new Error('The wallet plugin runs only in a browser page')
  return origin
}
