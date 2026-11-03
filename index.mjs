// crew-aws-vault: a crew extension (protocol 1) that keeps every agent's AWS
// credentials fresh through aws-vault, whatever harness runs it.
//
// Rather than fix short-lived keys into a session's env, it points the
// session's AWS SDK at a credentials server of its own (the container
// credential provider's AWS_CONTAINER_CREDENTIALS_FULL_URI), which serves the
// profile's credentials and refreshes them through `aws-vault export` as they
// near expiry. A running agent's SDK fetches again on its own, so it never
// needs a restart.
import { signInText } from './src/aws-vault.mjs'
import { startServer } from './src/server.mjs'
import { loadState, saveState } from './src/state.mjs'
import { createVault } from './src/vault.mjs'

// Under the manifest's holdMs, so a start's wait on aws-vault ends with our error, not crew's timeout.
const EXPORT_TIMEOUT_MS = 280_000
const COOLDOWN_MS = Number(process.env.CREW_AWS_VAULT_COOLDOWN_MS ?? 2 * 60 * 1000)

// What a failed AWS call prints once the credentials it was given have run
// out: the service's refusal, an SSO session gone stale, or this server
// unable to answer the CLI's container fetch.
const EXPIRED = /ExpiredToken|security token included in the request is (?:expired|invalid)|Token (?:has|is) expired and refresh failed|SSO session associated with this profile has expired|retrieving credentials from container-role/i

// The keys that would win over the container provider in the SDKs' chain.
const SHADOWING = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN', 'AWS_CREDENTIAL_EXPIRATION', 'AWS_PROFILE', 'AWS_VAULT']

// pi's own aws-vault refresher (funnel-io/agent-ops) takes its profile from
// PI_AWS_PROFILE first, and does nothing for one with no SSO sign-in in
// ~/.aws/config. Naming one that is not there makes it stand down, so a pi
// agent neither prompts on its own nor pins static keys over this server's.
const PI_STAND_DOWN = { PI_AWS_PROFILE: 'crew-aws-vault' }

export default async function (crew) {
  /** @type {Map<string, ReturnType<typeof createVault>>} */
  const vaults = new Map()
  const vaultFor = (profile) => {
    if (!vaults.has(profile))
      vaults.set(
        profile,
        createVault(profile, {
          timeoutMs: EXPORT_TIMEOUT_MS,
          cooldownMs: COOLDOWN_MS,
          onPrompt: (prompt) => crew.notice('warn', `aws-vault is waiting: ${signInText(profile, prompt)}`),
          onFailure: (message) => crew.notice('error', `${message}. Credentials for ${profile} are asked of aws-vault again in ${Math.round(COOLDOWN_MS / 1000)} s at the earliest.`),
        }),
      )
    return vaults.get(profile)
  }

  // The sessions this extension pointed at its server, and their profiles,
  // kept with the server's port and token across the extension's restarts.
  const state = loadState()
  const server = await startServer({ port: state.port, token: state.token, credentialsFor: (profile) => vaultFor(profile).get() })
  state.port = server.port
  saveState(state)
  const setUp = (session, profile) => {
    if (state.sessions[session] === profile) return
    if (profile) state.sessions[session] = profile
    else delete state.sessions[session]
    saveState(state)
  }
  /** Each session's last retry message, by the AccessKeyId it was sent for, so one renewal tells an agent once. */
  const retryToldFor = new Map()

  crew.on('session.starting', async ({ session, kind, env }) => {
    const profile = env.AWS_VAULT ?? env.AWS_PROFILE
    if (!profile || kind === 'tail') return null
    const credentials = await vaultFor(profile).get((prompt) => crew.holding(session, signInText(profile, prompt)))
    // Under `aws-vault exec` the profile is aws-vault's for certain, so the
    // session is pointed at the server even now: it gets credentials once
    // aws-vault works again. A bare AWS_PROFILE may be no aws-vault profile
    // at all, so that session keeps the env it was given.
    if (!credentials && !env.AWS_VAULT) {
      setUp(session, undefined)
      return null
    }
    setUp(session, profile)
    return { set: { ...server.envFor(profile), ...PI_STAND_DOWN }, unset: SHADOWING }
  })

  crew.on('tool.result', async ({ session, error, output }) => {
    const profile = state.sessions[session]
    if (!profile || error !== true || typeof output !== 'string' || !EXPIRED.test(output)) return
    const credentials = await vaultFor(profile).renew()
    if (!credentials || retryToldFor.get(session) === credentials.AccessKeyId) return
    retryToldFor.set(session, credentials.AccessKeyId)
    try {
      await crew.message(session, `AWS credentials for profile ${profile} were refreshed after an AWS call failed on an expired token. Retry the call that failed.`)
    } catch (e) {
      console.error(`could not tell session ${session} to retry: ${e.message}`)
    }
  })
}
