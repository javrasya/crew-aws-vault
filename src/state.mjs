// What the extension keeps across its own restarts, in crew's home: its
// server's port and token, which the sessions it set up still carry in their
// env, and which profile each of those sessions uses.
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** @typedef {{ port: number, token: string, sessions: Record<string, string> }} State */

const file = () => join(process.env.CREW_HOME ?? join(homedir(), '.crew'), 'aws-vault.json')

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
