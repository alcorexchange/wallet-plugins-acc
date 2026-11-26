# Alcor Chain wallet plugins for WharfKit

Sign Alcor Chain transactions with the wallet people already have. No Snap, no extension, nothing to install: the wallet's ordinary message signing is enough.

| Package | Wallets | Key type |
| --- | --- | --- |
| `@alcorexchange/wallet-plugin-evm` | MetaMask, Rabby, Coinbase Wallet, any EIP-1193 wallet | `PUB_EM_…` (secp256k1) |
| `@alcorexchange/wallet-plugin-solana` | Phantom, Solflare, Backpack, any Wallet Standard wallet | `PUB_ED_…` (Ed25519) |
| `@alcorexchange/acc-wallet-common` | shared by both: account lookup, login text, errors | |

Both work with [Session Kit](https://wharfkit.com) 1.x on any chain that knows EM / ED keys. There is no built-in chain list.

## Install

```sh
yarn add @alcorexchange/wallet-plugin-evm @alcorexchange/wallet-plugin-solana
```

### Use the Alcor Chain build of `@wharfkit/antelope`

Upstream `@wharfkit/antelope` knows nothing about EM and ED keys, so Session Kit would fail to read the keys and signatures these plugins hand it. The app must replace it everywhere, including inside `@wharfkit/session`, with the Alcor Chain fork, so there is one copy of it. Use the fork's git URL (or a local path while developing):

```jsonc
// package.json, yarn
"resolutions": { "@wharfkit/antelope": "https://github.com/alcorexchange/wharfkit-antelope/releases/download/v1.2.0-alcor.1/wharfkit-antelope-1.2.0-alcor.1.tgz" }

// package.json, npm
"overrides": { "@wharfkit/antelope": "<fork git URL>" }

// package.json, pnpm
"pnpm": { "overrides": { "@wharfkit/antelope": "<fork git URL>" } }
```

Check with `yarn why @wharfkit/antelope` (or `npm ls @wharfkit/antelope`): there must be a single version. With the upstream copy, the plugins' import of `TRANSACTION_SIGNING_PREFIX` has nothing to bind to, so bundling or loading them fails.

## Use

```ts
import { SessionKit } from '@wharfkit/session'
import { WebRenderer } from '@wharfkit/web-renderer'
import { WalletPluginEvm } from '@alcorexchange/wallet-plugin-evm'
import { WalletPluginSolana } from '@alcorexchange/wallet-plugin-solana'

const testnet = { id: 'a23b0ec475262075fa3b99a38614e243c00275f777fce93e2d70a4f8d367e3fb', url: 'https://api.acc.alcor.exchange' }

// Optional, per chain id
const chains = {
  [testnet.id]: {
    hyperion: 'https://history.acc.alcor.exchange',
    createAccountUrl: 'https://acc.alcor.exchange/faucet',
  },
}

const sessionKit = new SessionKit({
  appName: 'yourapp',
  chains: [testnet],
  ui: new WebRenderer(),
  walletPlugins: [new WalletPluginEvm({ chains }), new WalletPluginSolana({ chains })],
})
```

Options:

| Option | Plugin | |
| --- | --- | --- |
| `chains[chainId].hyperion` | both | Hyperion URL for the account lookup when the node has no `get_accounts_by_authorizers` |
| `chains[chainId].createAccountUrl` | both | Put into the "no account" error |
| `provider` | both | Use this provider instead of looking for wallets in the page: an EIP-1193 provider, or a Phantom-style Solana one |
| `discoveryMs` | evm | How long to wait for EIP-6963 announcements (default 300 ms) |

## How it works

### Signing

A transaction is signed as text, `transactionSigningText(digest)` from the library: its prefix, then the standard Antelope signing digest (which includes the chain id) as hex. The wallet shows that text. The prefix and the text always come from the library, because the chain verifies exactly those bytes.

- **Ethereum** wallets sign it with `personal_sign` (EIP-191). The chain takes one encoding, `SIG_EM_0x` + r ‖ s ‖ v with v = 27 / 28 and a low s. The plugin turns v = 0 / 1 into 27 / 28 and a high s into n − s with v flipped. It refuses anything that is not 65 bytes (smart-contract wallets sign differently).
- **Solana** wallets sign the UTF-8 bytes with `signMessage`. The signature is `SIG_ED_` + base58(public key ‖ signature). A Wallet Standard wallet that reports it signed different bytes (some hardware wallets prefix messages) is refused.

Before returning a signature, the plugin checks that it recovers to the session's key over the digest. A wallet that signed with another account fails here, not on the chain.

### Login

The wallet signs this text:

```
Alcor Chain login
Origin: https://yourapp.example
Address: 0x…   (or the Solana public key)
Issued at: 2026-11-23T12:00:00.000Z

This shows the app which key is yours. It is not a transaction and moves no funds.
```

An Ethereum wallet gives only an address, so the plugin recovers the public key from that signature and checks that the key's address (keccak-256(x ‖ y), last 20 bytes) is the connected address. A Solana wallet gives its key directly. The plugin checks the signature so that a wallet signing in a format the chain does not take fails at login.

The login text carries no server nonce, so it proves nothing to your backend. If your server needs proof of the account, run your own challenge.

### Finding the account

1. `POST /v1/chain/get_accounts_by_authorizers` with `{keys: [publicKey]}`.
2. If the node does not serve it and a Hyperion URL is set for the chain: `GET /v2/state/get_key_accounts?public_key=`, then `get_account` for each name to find which permissions hold the key.

Only permissions the key satisfies alone count (weight ≥ threshold). Where the key holds `active`, `owner` is not offered. If the app passes `permissionLevel` to `login`, the key must hold it. One account is used directly. With several, the person picks one in the Session Kit dialog. With none, login fails with `NoAccount`, which names the key and `createAccountUrl`.

### Errors

Exported from each plugin package:

- `WalletRejected`: the person refused in the wallet. Detected by EIP-1193 code 4001; for Wallet Standard wallets, which have no codes, by the usual messages.
- `WrongAccount`: the wallet answered for another address or key, or the app's `permissionLevel` is not this key's.
- `NoAccount`: `publicKey`, `createAccountUrl`.
- `WalletNotFound`: no wallet of that kind in the browser.

`SessionKit.login` rethrows errors as a plain `Error` with the same message.

## Develop

```sh
yarn install
yarn test      # builds the packages, runs tests/*.test.mjs
yarn example   # bundles example/ into example/dist/main.js
```

The tests use wallets that hold real keys (`@noble/curves`) and a mock node and Hyperion. Every signature they produce is checked against the rules of the Alcor Chain signature corpus (`tests/data/keys-corpus.json`, the same file as alcor-chain `unittests/test-data/keys-oracle/corpus.json`), and the test oracle and the linked library are checked against every case in it.

The example page logs in on the testnet and sends a HORN transfer (`eosio.token`). Serve `example/` over https or on localhost: wallets inject only into secure pages.

## License

BSD-3-Clause
