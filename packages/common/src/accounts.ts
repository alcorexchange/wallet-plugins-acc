import {
  Checksum256,
  PermissionLevel,
  PublicKey,
  type APIClient,
  type Fetch,
  type LoginContext,
  type WalletPluginLoginResponse,
} from '@wharfkit/session'

import { chooseOne } from './choose.js'
import { NoAccount, WrongAccount } from './errors.js'

/** What a plugin may know about a chain beyond Session Kit's chain definition. */
export interface ChainOptions {
  /** Hyperion base URL, asked when the chain API has no `get_accounts_by_authorizers`. */
  hyperion?: string
  /** Where a person without an account can make one; shown in the "no account" error. */
  createAccountUrl?: string
}

export interface PluginOptions {
  /** Per chain id. Any chain works without an entry. */
  chains?: Record<string, ChainOptions>
}

/**
 * The permissions the key satisfies alone (its weight reaches the threshold).
 * Asks the chain API `get_accounts_by_authorizers`; if the node does not serve it, asks Hyperion
 * `get_key_accounts` and reads each account's permissions from the chain.
 */
export async function findPermissions(
  client: APIClient,
  fetch: Fetch,
  publicKey: PublicKey,
  hyperion?: string
): Promise<PermissionLevel[]> {
  let chainError: unknown
  try {
    const { accounts } = await client.v1.chain.get_accounts_by_authorizers({ keys: [publicKey] })
    return unique(
      accounts
        .filter((row) => row.weight.toNumber() >= row.threshold.toNumber())
        .map((row) => PermissionLevel.from({ actor: row.account_name, permission: row.permission_name }))
    )
  } catch (error) {
    chainError = error
  }
  if (!hyperion) {
    throw new Error(
      'The chain API does not answer get_accounts_by_authorizers and no Hyperion is set for this chain',
      { cause: chainError }
    )
  }
  const names = await hyperionKeyAccounts(fetch, hyperion, publicKey)
  const found: PermissionLevel[] = []
  for (const name of names) {
    const account = await client.v1.chain.get_account(name)
    for (const permission of account.permissions) {
      const auth = permission.required_auth
      const enough = auth.keys.some(
        (entry) => entry.key.equals(publicKey) && entry.weight.toNumber() >= auth.threshold.toNumber()
      )
      if (enough) found.push(PermissionLevel.from({ actor: account.account_name, permission: permission.perm_name }))
    }
  }
  return unique(found)
}

async function hyperionKeyAccounts(fetch: Fetch, hyperion: string, publicKey: PublicKey): Promise<string[]> {
  const url = `${hyperion.replace(/\/+$/, '')}/v2/state/get_key_accounts?public_key=${encodeURIComponent(String(publicKey))}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Hyperion answered ${response.status} for get_key_accounts`)
  const body = (await response.json()) as { account_names?: unknown }
  if (!Array.isArray(body.account_names) || !body.account_names.every((name) => typeof name === 'string')) {
    throw new Error('Hyperion get_key_accounts answered without account_names')
  }
  return body.account_names
}

/** Per account, `active` alone when the key holds it: owner is there to recover the account, not to trade. */
export function preferActive(permissions: PermissionLevel[]): PermissionLevel[] {
  const withActive = new Set(permissions.filter((p) => p.permission.equals('active')).map((p) => String(p.actor)))
  return permissions.filter((p) => !withActive.has(String(p.actor)) || p.permission.equals('active'))
}

/**
 * The login answer for a key: the account the app asked for, if the key controls it;
 * otherwise the one account the key controls, or the one the person picks.
 */
export async function loginWithKey(
  context: LoginContext,
  publicKey: PublicKey,
  options: PluginOptions
): Promise<WalletPluginLoginResponse> {
  if (!context.chain) throw new Error('Pick a chain before logging in')
  const chainId = String(context.chain.id)
  const extra = options.chains?.[chainId] ?? {}

  const permissions = await findPermissions(context.getClient(context.chain), context.fetch, publicKey, extra.hyperion)
  if (permissions.length === 0) throw new NoAccount(String(publicKey), extra.createAccountUrl)

  let permissionLevel: PermissionLevel
  if (context.permissionLevel) {
    const asked = context.permissionLevel
    if (!permissions.some((p) => p.equals(asked))) {
      throw new WrongAccount(`${asked} is not controlled by ${publicKey}`)
    }
    permissionLevel = asked
  } else {
    const choices = preferActive(permissions).map((p) => ({ label: String(p), value: p }))
    permissionLevel = await chooseOne(context.ui, 'Choose an account', 'Your key controls several accounts.', choices)
  }
  return { chain: Checksum256.from(chainId), permissionLevel }
}

function unique(permissions: PermissionLevel[]): PermissionLevel[] {
  return permissions.filter((p, i) => permissions.findIndex((q) => q.equals(p)) === i)
}
