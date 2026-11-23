/** The person said no in the wallet: closed the window or pressed Reject. */
export class WalletRejected extends Error {
  readonly wallet: string
  constructor(wallet: string, options?: { cause?: unknown }) {
    super(`You rejected the request in ${wallet}`, options)
    this.name = 'WalletRejected'
    this.wallet = wallet
  }
}

/** No wallet of the kind the plugin needs is in this browser. */
export class WalletNotFound extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WalletNotFound'
  }
}

/**
 * The wallet answered for another key or address than the one this session belongs to,
 * or the account asked for is not controlled by the wallet's key.
 */
export class WrongAccount extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WrongAccount'
  }
}

/** The wallet's key controls no account on this chain. */
export class NoAccount extends Error {
  readonly publicKey: string
  readonly createAccountUrl?: string
  constructor(publicKey: string, createAccountUrl?: string) {
    const where = createAccountUrl ? ` Create one first: ${createAccountUrl}` : ' Create one first.'
    super(`No account on this chain is controlled by ${publicKey}.${where}`)
    this.name = 'NoAccount'
    this.publicKey = publicKey
    this.createAccountUrl = createAccountUrl
  }
}

/**
 * Whether a wallet error means the person refused.
 * EIP-1193 and Phantom use code 4001. Wallet Standard has no error codes, so for its wallets
 * the message is matched as a best effort.
 */
export function isUserRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { code, message } = error as { code?: unknown; message?: unknown }
  if (code === 4001) return true
  return typeof message === 'string' && /\b(user rejected|rejected the request|user denied|denied by user|user declined|user cancel)/i.test(message)
}

/** Run a wallet call, turning the person's refusal into `WalletRejected`. Other errors pass as they are. */
export async function askWallet<T>(wallet: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (isUserRejection(error)) throw new WalletRejected(wallet, { cause: error })
    throw error
  }
}
