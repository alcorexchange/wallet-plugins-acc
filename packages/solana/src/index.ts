import { ed25519 } from '@noble/curves/ed25519'
import {
  AbstractWalletPlugin,
  Base58,
  Bytes,
  PublicKey,
  Signature,
  WalletPluginMetadata,
  type LoginContext,
  type ResolvedSigningRequest,
  type TransactContext,
  type WalletPlugin,
  type WalletPluginConfig,
  type WalletPluginLoginResponse,
  type WalletPluginSignResponse,
} from '@wharfkit/session'
import {
  WalletNotFound,
  WrongAccount,
  askWallet,
  assertSignedBy,
  chooseOne,
  loginText,
  loginWithKey,
  pageOrigin,
  requestDigest,
  signingMessage,
  type PluginOptions,
} from '@alcorexchange/acc-wallet-common'

import { discoverWallets, fromInjected, sameBytes, type InjectedSolanaProvider, type SolanaWallet } from './wallets.js'

export * from '@alcorexchange/acc-wallet-common'
export { discoverWallets, fromInjected, fromStandard, type InjectedSolanaProvider, type SolanaWallet } from './wallets.js'

export interface WalletPluginSolanaOptions extends PluginOptions {
  /** Use this Phantom-style provider instead of looking for wallets in the page. */
  provider?: InjectedSolanaProvider
}

/** What a session keeps, so it signs after a page reload. */
interface SolanaSessionData {
  publicKey: string
  walletName: string
}

/**
 * Alcor Chain ED keys from a Solana wallet (Phantom, Solflare, Backpack, …).
 * The wallet signs a transaction as text with `signMessage`; nothing to install.
 */
export class WalletPluginSolana extends AbstractWalletPlugin implements WalletPlugin {
  readonly config: WalletPluginConfig = {
    requiresChainSelect: true,
    requiresPermissionSelect: false,
  }

  readonly metadata = WalletPluginMetadata.from({
    name: 'Solana wallet',
    description: 'Phantom, Solflare, Backpack or another Solana wallet',
  })

  private readonly options: WalletPluginSolanaOptions

  constructor(options: WalletPluginSolanaOptions = {}) {
    super()
    this.options = options
  }

  get id() {
    return 'alcor-solana'
  }

  /**
   * Connect, sign the login text and check the signature against the wallet's key: a wallet that
   * prefixes messages (as hardware wallets do) fails here, not on the first transaction.
   * Then find the account the key controls.
   */
  async login(context: LoginContext): Promise<WalletPluginLoginResponse> {
    const wallet = await this.pickWallet(context)
    const [key] = await askWallet(wallet.name, () => wallet.connect(false))
    if (!key || key.length !== 32) throw new Error(`${wallet.name} connected no account`)

    const address = Base58.encode(Bytes.from(key))
    const text = loginText({ origin: pageOrigin(), address, issuedAt: new Date().toISOString() })
    const message = new TextEncoder().encode(text)
    const signature = await askWallet(wallet.name, () => wallet.signMessage(key, message))
    if (signature.length !== 64 || !ed25519.verify(signature, message, key, { zip215: false })) {
      throw new WrongAccount(`${wallet.name} signed the login text with another key or in another format`)
    }
    const publicKey = PublicKey.from(`PUB_ED_${address}`)

    const response = await loginWithKey(context, publicKey, this.options, { wallet: wallet.name, address })
    const data: SolanaSessionData = { publicKey: String(publicKey), walletName: wallet.name }
    this.data = { ...data }
    return response
  }

  /** `signMessage` over the library's transaction text, checked against the session's key. */
  async sign(resolved: ResolvedSigningRequest, _context: TransactContext): Promise<WalletPluginSignResponse> {
    const session = this.sessionData()
    const publicKey = PublicKey.from(session.publicKey)
    const key = publicKey.data.array
    const wallet = this.sessionWallet(session)
    await ensureKey(wallet, key)

    const digest = requestDigest(resolved)
    const detached = await askWallet(wallet.name, () => wallet.signMessage(key, signingMessage(digest)))
    if (detached.length !== 64) throw new Error(`${wallet.name} returned a ${detached.length}-byte signature, not 64`)
    const data = new Uint8Array(96)
    data.set(key, 0)
    data.set(detached, 32)
    const signature = Signature.from(`SIG_ED_${Base58.encode(Bytes.from(data))}`)
    assertSignedBy(signature, digest, publicKey)
    return { signatures: [signature] }
  }

  private async pickWallet(context: LoginContext): Promise<SolanaWallet> {
    if (this.options.provider) return fromInjected(this.options.provider, 'Solana wallet')
    const wallets = discoverWallets()
    if (wallets.length === 0) throw new WalletNotFound('No Solana wallet in this browser. Install Phantom, Solflare or Backpack')
    const choices = wallets.map((wallet) => ({ label: wallet.name, value: wallet }))
    return chooseOne(context.ui, 'Choose a wallet', 'Several Solana wallets are installed.', choices)
  }

  private sessionWallet(session: SolanaSessionData): SolanaWallet {
    if (this.options.provider) return fromInjected(this.options.provider, session.walletName)
    const wallet = discoverWallets().find((w) => w.name === session.walletName)
    if (!wallet) throw new WalletNotFound(`${session.walletName} is not in this browser. Log in again`)
    return wallet
  }

  private sessionData(): SolanaSessionData {
    const { publicKey, walletName } = this.data as Partial<SolanaSessionData>
    if (typeof publicKey !== 'string' || typeof walletName !== 'string') {
      throw new Error('Log in with your Solana wallet again')
    }
    return { publicKey, walletName }
  }
}

/** The wallet must be connected with the session's key: quietly if it trusts the page, else by asking once. */
async function ensureKey(wallet: SolanaWallet, key: Uint8Array): Promise<void> {
  const has = (keys: Uint8Array[]) => keys.some((k) => sameBytes(k, key))
  let keys: Uint8Array[] = []
  try {
    keys = await wallet.connect(true)
  } catch {
    // A silent connect fails when the wallet does not trust the page yet; ask below.
  }
  if (has(keys)) return
  keys = await askWallet(wallet.name, () => wallet.connect(false))
  if (!has(keys)) {
    throw new WrongAccount(`Switch to ${Base58.encode(Bytes.from(key))} in ${wallet.name}: this session belongs to it`)
  }
}
