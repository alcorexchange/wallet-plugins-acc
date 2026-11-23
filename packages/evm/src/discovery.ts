/** EIP-1193: the provider object an Ethereum wallet injects. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
}

/** EIP-6963 `info` of an announced wallet. */
export interface Eip6963ProviderInfo {
  uuid: string
  name: string
  icon: string
  rdns: string
}

export interface EvmWallet {
  name: string
  /** EIP-6963 reverse-DNS id, e.g. `io.metamask`; undefined for the legacy `window.ethereum`. */
  rdns?: string
  provider: Eip1193Provider
}

const LEGACY_NAME = 'Browser wallet'

/**
 * The Ethereum wallets in this page: EIP-6963 announcements, or `window.ethereum` when no wallet announces.
 * Wallets answer the request event at once; `waitMs` leaves room for slow ones.
 */
export async function discoverWallets(waitMs: number): Promise<EvmWallet[]> {
  const page = globalThis.window as (Window & { ethereum?: Eip1193Provider }) | undefined
  if (!page) return []

  const found = new Map<string, EvmWallet>()
  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<{ info?: Eip6963ProviderInfo; provider?: Eip1193Provider }>).detail
    if (!detail?.info?.uuid || typeof detail.provider?.request !== 'function') return
    found.set(detail.info.uuid, { name: detail.info.name, rdns: detail.info.rdns, provider: detail.provider })
  }
  page.addEventListener('eip6963:announceProvider', onAnnounce)
  page.dispatchEvent(new Event('eip6963:requestProvider'))
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  page.removeEventListener('eip6963:announceProvider', onAnnounce)

  if (found.size) return [...found.values()]
  return page.ethereum ? [{ name: LEGACY_NAME, provider: page.ethereum }] : []
}

/** The wallet a session was made with: by its EIP-6963 id, or the legacy `window.ethereum`. */
export function findWallet(wallets: EvmWallet[], rdns: string | undefined): EvmWallet | undefined {
  return wallets.find((wallet) => wallet.rdns === rdns)
}
