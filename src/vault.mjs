// One profile's credentials, kept fresh through aws-vault: every session of
// that profile shares them, so a refresh, and any keychain or SSO prompt it
// brings, happens once for all of them.
import { exportCredentials, ssoPrompt } from './aws-vault.mjs'

/**
 * @typedef {import('./aws-vault.mjs').Credentials} Credentials
 * @typedef {import('./aws-vault.mjs').SsoPrompt} Prompt
 */

/** Credentials this close to their expiry are refreshed behind the fetch that finds them. */
const REFRESH_WINDOW_MS = 15 * 60 * 1000
/** A token refused within this long of a renewal is taken as one handed out before it, so it is not renewed again. */
const RECENT_RENEWAL_MS = 60 * 1000
/** aws-vault may hand back the same near-expiry credentials it holds; ask it again no sooner than this. */
const SAME_CREDENTIALS_RETRY_MS = 60 * 1000

const expiryOf = (c) => {
  const at = Date.parse(c?.Expiration ?? '')
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at
}

/**
 * @param {string} profile
 * @param {{ timeoutMs: number, cooldownMs: number, onFailure?: (message: string) => void, onPrompt?: (prompt: Prompt) => void }} opts
 */
export function createVault(profile, { timeoutMs, cooldownMs, onFailure, onPrompt }) {
  /** @type {Credentials | undefined} */
  let credentials
  /** @type {Promise<Credentials | undefined> | undefined} */
  let inFlight
  /** When a refresh last came back with the credentials already held. */
  let unchangedAt = Number.NEGATIVE_INFINITY
  /** When a renewal last brought new credentials. */
  let renewedAt = Number.NEGATIVE_INFINITY
  /** After a failed export, no automatic one before this, so a locked keychain is not asked on every start. */
  let cooldownUntil = Number.NEGATIVE_INFINITY
  /** The sign-in the refresh in flight waits on, once aws-vault has printed it. */
  /** @type {Prompt | undefined} */
  let prompt
  /** Who waits on the refresh in flight and wants to hear of its sign-in. */
  /** @type {Set<(prompt: Prompt) => void>} */
  const waiting = new Set()

  function refresh() {
    if (inFlight) return inFlight
    if (Date.now() < cooldownUntil) return Promise.resolve(undefined)
    const onStderr = (soFar) => {
      if (prompt) return
      prompt = ssoPrompt(soFar)
      if (!prompt) return
      onPrompt?.(prompt)
      for (const listener of waiting) listener(prompt)
    }
    inFlight = exportCredentials(profile, { timeoutMs, onStderr })
      .then((result) => {
        if ('message' in result) {
          cooldownUntil = Date.now() + cooldownMs
          onFailure?.(result.message)
          return undefined
        }
        cooldownUntil = Number.NEGATIVE_INFINITY
        if (result.credentials.AccessKeyId === credentials?.AccessKeyId) unchangedAt = Date.now()
        credentials = result.credentials
        return credentials
      })
      .finally(() => {
        inFlight = undefined
        prompt = undefined
        waiting.clear()
      })
    return inFlight
  }

  /** `refresh()`, with `onWaitPrompt` told of the sign-in it waits on, at once if aws-vault already printed it. */
  function refreshFor(onWaitPrompt) {
    const flight = refresh()
    if (onWaitPrompt && inFlight) {
      waiting.add(onWaitPrompt)
      if (prompt) onWaitPrompt(prompt)
    }
    return flight
  }

  return {
    /**
     * Credentials good for now, refreshed first when there are none or they
     * have expired, and behind the answer when they near expiry; undefined
     * when aws-vault could not give any. `onWaitPrompt` hears of an SSO
     * sign-in this call waits on.
     * @param {(prompt: Prompt) => void} [onWaitPrompt]
     */
    async get(onWaitPrompt) {
      const now = Date.now()
      const left = expiryOf(credentials) - now
      if (!credentials || left <= 0) return refreshFor(onWaitPrompt)
      if (left < REFRESH_WINDOW_MS && now - unchangedAt > SAME_CREDENTIALS_RETRY_MS) void refresh()
      return credentials
    },
    /**
     * After AWS refused these credentials as expired: credentials other than
     * the ones held now, refreshed however long those claim to be good for,
     * or the ones a renewal just brought, as when several agents' calls fail
     * on the same expiry. Undefined when aws-vault could give none but the
     * refused ones, or none at all.
     */
    async renew() {
      const refused = credentials?.AccessKeyId
      if (!inFlight && credentials && Date.now() - renewedAt < RECENT_RENEWAL_MS) return credentials
      const renewed = await refresh()
      if (!renewed || renewed.AccessKeyId === refused) return undefined
      renewedAt = Date.now()
      return renewed
    },
  }
}
