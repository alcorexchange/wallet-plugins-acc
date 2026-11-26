import { SessionKit, type Session } from '@wharfkit/session'
import { WebRenderer } from '@wharfkit/web-renderer'
import { WalletPluginEvm } from '@alcorexchange/wallet-plugin-evm'
import { WalletPluginSolana } from '@alcorexchange/wallet-plugin-solana'

// Alcor Chain testnet: chain id from https://api.acc.alcor.exchange/v1/chain/get_info.
// The system token HORN is eosio.token (get_currency_stats); the node has no get_accounts_by_authorizers,
// so the plugins find accounts through Hyperion.
const TESTNET = {
  id: 'a23b0ec475262075fa3b99a38614e243c00275f777fce93e2d70a4f8d367e3fb',
  url: 'https://api.acc.alcor.exchange',
}
const chains = {
  [TESTNET.id]: {
    hyperion: 'https://history.acc.alcor.exchange',
    createAccountUrl: 'https://acc.alcor.exchange/faucet',
  },
}

const sessionKit = new SessionKit({
  appName: 'accwallets',
  chains: [TESTNET],
  ui: new WebRenderer(),
  walletPlugins: [new WalletPluginEvm({ chains }), new WalletPluginSolana({ chains })],
})

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const log = $<HTMLPreElement>('log')
let session: Session | undefined

function show(text: string) {
  log.textContent = text
  console.info('[example]', text)
}

function setSession(next: Session | undefined) {
  session = next
  $<HTMLButtonElement>('transfer').disabled = !session
  $<HTMLButtonElement>('logout').disabled = !session
  show(session ? `Logged in as ${session.permissionLevel} with ${session.walletPlugin.metadata.name}` : 'Not logged in')
}

$('login').onclick = async () => {
  try {
    setSession((await sessionKit.login()).session)
  } catch (error) {
    // With no account for the wallet's key, the message carries the faucet link.
    show(`Login failed: ${(error as Error).message}`)
  }
}

$('transfer').onclick = async () => {
  if (!session) return
  const to = $<HTMLInputElement>('to').value.trim()
  const quantity = $<HTMLInputElement>('quantity').value.trim()
  try {
    const result = await session.transact({
      action: {
        account: 'eosio.token',
        name: 'transfer',
        authorization: [session.permissionLevel],
        data: { from: session.actor, to, quantity, memo: 'wallet plugin example' },
      },
    })
    show(`Sent: ${result.response?.transaction_id ?? '(no id)'}\nSignature: ${result.signatures[0]}`)
  } catch (error) {
    show(`Signing failed: ${(error as Error).message}`)
  }
}

$('logout').onclick = async () => {
  await sessionKit.logout()
  setSession(undefined)
}

sessionKit.restore().then(setSession, (error) => show(`Restore failed: ${error.message}`))
