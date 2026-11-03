// Running `aws-vault export` for a profile: its credentials, or why not.
import { spawn } from 'node:child_process'

/**
 * @typedef {{ AccessKeyId: string, SecretAccessKey: string, SessionToken?: string, Expiration?: string }} Credentials
 * @typedef {{ ok: true, credentials: Credentials } | { ok: false, message: string }} ExportResult
 * @typedef {{ url: string, code?: string }} SsoPrompt
 */

/**
 * Runs `aws-vault export --format=json <profile>`. `onStderr` gets the stderr
 * seen so far each time more comes, since the SSO banner and its URL can land
 * in separate reads. Killed after `timeoutMs`.
 * @param {string} profile
 * @param {{ timeoutMs: number, onStderr?: (soFar: string) => void }} opts
 * @returns {Promise<ExportResult>}
 */
export function exportCredentials(profile, { timeoutMs, onStderr }) {
  const failed = (why) => ({ ok: /** @type {const} */ (false), message: `aws-vault export ${profile} ${why}` })
  return new Promise((resolve) => {
    // aws-vault refuses to export inside an `aws-vault exec` subshell, which
    // is what crew's daemon is when the operator started it that way.
    const env = { ...process.env }
    delete env.AWS_VAULT
    const child = spawn('aws-vault', ['export', '--format=json', profile], { stdio: ['ignore', 'pipe', 'pipe'], env })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => {
      stderr += d
      onStderr?.(stderr)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve(failed(`could not run: ${e.message}`))
    })
    // 'close', not 'exit': only then has all of stdout been read.
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        const detail = stderr.trim().split('\n').slice(-3).join(' ')
        return resolve(failed(`${code === null ? 'timed out' : `exited ${code}`}${detail ? `: ${detail}` : ''}`))
      }
      try {
        const parsed = JSON.parse(stdout)
        if (!parsed.AccessKeyId || !parsed.SecretAccessKey) return resolve(failed('returned no credentials'))
        resolve({ ok: true, credentials: parsed })
      } catch {
        resolve(failed('printed something that is not JSON'))
      }
    })
  })
}

/** aws-vault's SSO sign-in banner, both the browser-opening and the `--stdout` wording. */
const SSO_PAGE = /Opening the SSO authorization page|Open the SSO authorization page/

/**
 * The SSO sign-in aws-vault waits on, from its stderr so far: the page's URL
 * and, on the device-code flow, its code. Undefined until both the banner and
 * the URL have come.
 * @param {string} stderr
 * @returns {SsoPrompt | undefined}
 */
export function ssoPrompt(stderr) {
  if (!SSO_PAGE.test(stderr)) return undefined
  const url = stderr.match(/(https?:\/\/\S+)/)?.[1]
  if (!url) return undefined
  return { url, code: url.match(/user_code=([A-Za-z0-9-]+)/)?.[1] }
}

/**
 * What to tell the operator to do for `prompt`, for `profile`.
 * @param {string} profile
 * @param {SsoPrompt} prompt
 */
export function signInText(profile, { url, code }) {
  return `sign in to AWS for ${profile}${code ? ` with code ${code}` : ''}: ${url}`
}
