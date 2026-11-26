import {
  AbstractWalletPlugin,
  PublicKey,
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
  signingText,
  type PluginOptions,
} from '@alcorexchange/acc-wallet-common'

import { discoverWallets, findWallet, type Eip1193Provider, type EvmWallet } from './discovery.js'
import { emPublicKey, emSignature, ethAddress, normalizeEmSignature, recoverPersonalSigner, utf8Hex } from './em.js'

export * from '@alcorexchange/acc-wallet-common'
export { discoverWallets, type Eip1193Provider, type Eip6963ProviderInfo, type EvmWallet } from './discovery.js'
export { emSignature, ethAddress, normalizeEmSignature, personalMessageHash, recoverPersonalSigner } from './em.js'

export interface WalletPluginEvmOptions extends PluginOptions {
  /** Use this EIP-1193 provider instead of looking for wallets in the page. */
  provider?: Eip1193Provider
  /** How long to wait for EIP-6963 wallets to announce themselves, in ms. Default 300. */
  discoveryMs?: number
}

/** What a session keeps, so it signs after a page reload. */
interface EvmSessionData {
  publicKey: string
  address: string
  walletName: string
  /** EIP-6963 id; absent for `window.ethereum` and for a provider passed in the options. */
  rdns?: string
}

/**
 * Alcor Chain EM keys from an Ethereum wallet (MetaMask, Rabby, Coinbase Wallet, …).
 * The wallet signs a transaction as text with `personal_sign`; no Snap, nothing to install.
 */
export class WalletPluginEvm extends AbstractWalletPlugin implements WalletPlugin {
  readonly config: WalletPluginConfig = {
    requiresChainSelect: true,
    requiresPermissionSelect: false,
  }

  readonly metadata = WalletPluginMetadata.from({
    name: 'Ethereum wallet',
    description: 'MetaMask, Rabby, Coinbase Wallet or another Ethereum wallet',
  })

  private readonly options: WalletPluginEvmOptions

  constructor(options: WalletPluginEvmOptions = {}) {
    super()
    this.options = options
  }

  get id() {
    return 'alcor-evm'
  }

  /**
   * Connect, sign the login text, recover the key from that signature (an Ethereum wallet gives
   * only an address), check it is the connected address, then find the account the key controls.
   */
  async login(context: LoginContext): Promise<WalletPluginLoginResponse> {
    const wallet = await this.pickWallet(context)
    const accounts = await askWallet(wallet.name, () => wallet.provider.request({ method: 'eth_requestAccounts' }))
    const address = firstAddress(accounts, wallet.name)

    const text = loginText({ origin: pageOrigin(), address, issuedAt: new Date().toISOString() })
    const answer = await askWallet(wallet.name, () =>
      wallet.provider.request({ method: 'personal_sign', params: [utf8Hex(text), address] })
    )
    const signer = recoverPersonalSigner(text, normalizeEmSignature(answer))
    if (ethAddress(signer) !== address.toLowerCase()) {
      throw new WrongAccount(`${wallet.name} signed with ${ethAddress(signer)}, not with the connected ${address}`)
    }
    const publicKey = emPublicKey(signer)

    const response = await loginWithKey(context, publicKey, this.options, { wallet: wallet.name, address })
    const data: EvmSessionData = { publicKey: String(publicKey), address, walletName: wallet.name, rdns: wallet.rdns }
    this.data = { ...data }
    return response
  }

  /** `personal_sign` over the library's transaction text, normalized, and checked against the session's key. */
  async sign(resolved: ResolvedSigningRequest, _context: TransactContext): Promise<WalletPluginSignResponse> {
    const session = this.sessionData()
    const wallet = await this.sessionWallet(session)
    await ensureAddress(wallet, session.address)

    const digest = requestDigest(resolved)
    const answer = await askWallet(wallet.name, () =>
      wallet.provider.request({ method: 'personal_sign', params: [utf8Hex(signingText(digest)), session.address] })
    )
    const signature = emSignature(normalizeEmSignature(answer))
    assertSignedBy(signature, digest, PublicKey.from(session.publicKey))
    return { signatures: [signature] }
  }

  private async pickWallet(context: LoginContext): Promise<EvmWallet> {
    if (this.options.provider) return { name: 'Ethereum wallet', provider: this.options.provider }
    const wallets = await discoverWallets(this.options.discoveryMs ?? 300)
    if (wallets.length === 0) throw new WalletNotFound('No Ethereum wallet in this browser. Install MetaMask, Rabby or Coinbase Wallet')
    const choices = wallets.map((wallet) => ({ label: wallet.name, value: wallet }))
    return chooseOne(context.ui, 'Choose a wallet', 'Several Ethereum wallets are installed.', choices)
  }

  private async sessionWallet(session: EvmSessionData): Promise<EvmWallet> {
    if (this.options.provider) return { name: session.walletName, provider: this.options.provider }
    const wallet = findWallet(await discoverWallets(this.options.discoveryMs ?? 300), session.rdns)
    if (!wallet) throw new WalletNotFound(`${session.walletName} is not in this browser. Log in again`)
    return wallet
  }

  private sessionData(): EvmSessionData {
    const { publicKey, address, walletName, rdns } = this.data as Partial<EvmSessionData>
    if (typeof publicKey !== 'string' || typeof address !== 'string' || typeof walletName !== 'string') {
      throw new Error('Log in with your Ethereum wallet again')
    }
    return { publicKey, address, walletName, rdns }
  }
}

/** The wallet must have the session's address connected; ask once to connect it, then give up. */
async function ensureAddress(wallet: EvmWallet, address: string): Promise<void> {
  const has = (accounts: unknown) =>
    Array.isArray(accounts) && accounts.some((a) => typeof a === 'string' && a.toLowerCase() === address.toLowerCase())
  if (has(await wallet.provider.request({ method: 'eth_accounts' }))) return
  const accounts = await askWallet(wallet.name, () => wallet.provider.request({ method: 'eth_requestAccounts' }))
  if (!has(accounts)) throw new WrongAccount(`Switch to ${address} in ${wallet.name}: this session belongs to it`)
}

function firstAddress(accounts: unknown, walletName: string): string {
  const address = Array.isArray(accounts) ? accounts[0] : undefined
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`${walletName} connected no account`)
  }
  return address
}
