import { accountApiBase, accountHeaders, HTTP_TIMEOUT_MS, type FetchInjection } from './account.js'

export interface AccountProfileUpdate { name: string; avatar?: string | null }
export async function updateAccountProfile(accessToken: string, input: AccountProfileUpdate, opts: FetchInjection = {}): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await (opts.fetchImpl ?? fetch)(`${accountApiBase()}/functions/v1/tui-account-profile-update`, {
      method: 'POST', headers: { ...accountHeaders(), Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(input), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    const body = await response.json() as { ok?: boolean; error?: string }
    return response.ok && body.ok === true ? { ok: true } : { ok: false, error: body.error || 'profile_update_failed' }
  } catch { return { ok: false, error: 'profile_update_unavailable' } }
}
