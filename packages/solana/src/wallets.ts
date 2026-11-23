import { SolanaSignMessage, type SolanaSignMessageFeature } from '@solana/wallet-standard-features'
import { getWallets } from '@wallet-standard/app'
import type { Wallet, WalletAccount } from '@wallet-standard/base'
import { StandardConnect, type StandardConnectFeature } from '@wallet-standard/features'

/** One way to talk to a Solana wallet, whichever API it speaks. */
export interface SolanaWallet {
  name: string
  /** Connect and return the wallet's public keys (32 bytes each), the active one first. `silent` asks no question. */
  connect(silent: boolean): Promise<Uint8Array[]>
  /** Ed25519-sign exactly `message` with `publicKey`; returns the 64-byte signature. */
  signMessage(publicKey: Uint8Array, message: Uint8Array): Promise<Uint8Array>
}

/**
 * The Phantom-style injected provider (`window.phantom.solana`, `window.solana`): what wallets offered
 * before the Wallet Standard.
 */
export interface InjectedSolanaProvider {
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toBytes(): Uint8Array } }>
  signMessage(message: Uint8Array, display?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array }>
}

type SigningWallet = Wallet & { features: StandardConnectFeature & SolanaSignMessageFeature }

/** The Solana wallets in this page: Wallet Standard wallets that sign messages, else the injected provider. */
export function discoverWallets(): SolanaWallet[] {
  const standard = getWallets()
    .get()
    .filter(canSignMessages)
    .map(fromStandard)
  if (standard.length) return standard

  const page = globalThis.window as
    | (Window & { phantom?: { solana?: InjectedSolanaProvider }; solana?: InjectedSolanaProvider })
    | undefined
  const injected = page?.phantom?.solana ?? page?.solana
  return injected ? [fromInjected(injected, 'Solana wallet')] : []
}

function canSignMessages(wallet: Wallet): wallet is SigningWallet {
  return StandardConnect in wallet.features && SolanaSignMessage in wallet.features
}

/** A Wallet Standard wallet with `standard:connect` and `solana:signMessage`. */
export function fromStandard(wallet: SigningWallet): SolanaWallet {
  let accounts: readonly WalletAccount[] = []
  return {
    name: wallet.name,
    async connect(silent) {
      const answer = await wallet.features[StandardConnect].connect({ silent })
      accounts = answer.accounts.filter((account) => account.features.includes(SolanaSignMessage))
      return accounts.map((account) => Uint8Array.from(account.publicKey))
    },
    async signMessage(publicKey, message) {
      const account = accounts.find((a) => sameBytes(a.publicKey, publicKey))
      if (!account) throw new Error(`${wallet.name} has not connected this key`)
      const [output] = await wallet.features[SolanaSignMessage].signMessage({ account, message })
      if (!output) throw new Error(`${wallet.name} returned no signature`)
      // The standard lets a wallet prefix the message; the chain verifies exactly the text it was given.
      if (!sameBytes(output.signedMessage, message)) {
        throw new Error(`${wallet.name} changed the message before signing it, so the chain would not accept the signature`)
      }
      if (output.signatureType && output.signatureType !== 'ed25519') {
        throw new Error(`${wallet.name} signed with ${output.signatureType}, not Ed25519`)
      }
      return Uint8Array.from(output.signature)
    },
  }
}

/** A Phantom-style injected provider. */
export function fromInjected(provider: InjectedSolanaProvider, name: string): SolanaWallet {
  return {
    name,
    async connect(silent) {
      const { publicKey } = await provider.connect(silent ? { onlyIfTrusted: true } : undefined)
      return [Uint8Array.from(publicKey.toBytes())]
    },
    async signMessage(_publicKey, message) {
      const { signature } = await provider.signMessage(message, 'utf8')
      return Uint8Array.from(signature)
    },
  }
}

export function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
