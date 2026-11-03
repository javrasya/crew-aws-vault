// The extension's files in crew's home: the operator's config, and what the
// extension keeps across its own restarts (its server's port and token, which
// the sessions it set up still carry in their env, and which profile each of
// those sessions uses).
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** @typedef {{ port: number, token: string, sessions: Record<string, string> }} State */

const inCrewHome = (name) => join(process.env.CREW_HOME ?? join(homedir(), '.crew'), name)
const file = () => inCrewHome('aws-vault.json')

/**
 * The operator's config, `aws-vault.config.json` in crew's home, read afresh
 * each time so an edit needs no reload: `profile`, the one a session that
 * names none (no AWS_VAULT, no AWS_PROFILE) gets. Empty when there is none.
 * @returns {{ profile?: string }}
 */
export function loadConfig() {
  try {
    const config = JSON.parse(readFileSync(inCrewHome('aws-vault.config.json'), 'utf8'))
    return typeof config?.profile === 'string' && config.profile ? { profile: config.profile } : {}
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`ignoring ${inCrewHome('aws-vault.config.json')}: ${e.message}`)
    return {}
  }
}

/** @returns {State} */
export function loadState() {
  try {
    const saved = JSON.parse(readFileSync(file(), 'utf8'))
    if (typeof saved.token === 'string' && saved.token && Number.isInteger(saved.port)) return { port: saved.port, token: saved.token, sessions: saved.sessions ?? {} }
  } catch {}
  return { port: 0, token: randomBytes(32).toString('hex'), sessions: {} }
}

/** @param {State} state */
export function saveState(state) {
  try {
    // The token hands out credentials: only the operator may read it.
    writeFileSync(file(), JSON.stringify(state), { mode: 0o600 })
  } catch (e) {
    console.error(`could not keep the extension's state in ${file()}: ${e.message}`)
  }
}
