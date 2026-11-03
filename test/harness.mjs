// Runs the extension as crew does: crew's own extension bootstrap as a child
// process, spoken to in JSON lines over stdio, with test/fake-bin's aws-vault
// first on its PATH, answering from a script the test writes.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const crewDir = resolve(process.env.CREW_DIR ?? join(here, '..', '..', 'crew'))
const bootstrap = join(crewDir, 'src', 'extension-bootstrap.mjs')
const entry = join(here, '..', 'index.mjs')

const HOUR = 60 * 60 * 1000
export const MIN = 60 * 1000

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Credentials as `aws-vault export --format=json` prints them, valid for `ms` from now. */
export function creds(key, ms = HOUR) {
  return { Version: 1, AccessKeyId: key, SecretAccessKey: `${key}-secret`, SessionToken: `${key}-token`, Expiration: new Date(Date.now() + ms).toISOString() }
}

/** Every child and scratch folder the tests made, for `cleanUp`. */
const children = new Set()
const dirs = new Set()

/** A scratch folder, removed by `cleanUp`: a crew home, say, for extensions that must share one. */
export function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-aws-vault-'))
  dirs.add(dir)
  return dir
}

/** Ends every extension still running and removes every scratch folder. */
export async function cleanUp() {
  await Promise.all(
    [...children].map((child) => {
      if (child.exitCode !== null || child.signalCode !== null) return undefined
      const exited = new Promise((r) => child.once('exit', r))
      child.kill('SIGKILL')
      return exited
    }),
  )
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}

/**
 * Starts the extension with `script`, the fake aws-vault's steps (see
 * test/fake-bin/aws-vault), `env` on top of this process's, and crew's home
 * at `crewHome`, a fresh one unless given. Answers after crew's hello and
 * the extension's ready.
 */
export async function startExtension({ script, env = {}, crewHome = scratch() }) {
  const dir = scratch()
  const scriptFile = join(dir, 'script.json')
  writeFileSync(scriptFile, JSON.stringify(script))
  const child = spawn(process.execPath, [bootstrap, entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${join(here, 'fake-bin')}:${process.env.PATH}`, FAKE_AWS_VAULT: scriptFile, CREW_HOME: crewHome, ...env },
  })
  children.add(child)
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  const lines = []
  const waiters = new Set()
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    lines.push(message)
    for (const w of waiters)
      if (w.match(message)) {
        waiters.delete(w)
        clearTimeout(w.timer)
        w.resolve(message)
      }
  })
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
  /** The first line from the extension that `match` takes, one already sent included. */
  const next = (match, ms = 10_000) => {
    const seen = lines.find(match)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      const w = { match, resolve, timer: undefined }
      w.timer = setTimeout(() => {
        waiters.delete(w)
        reject(new Error(`no matching line in ${ms} ms; lines: ${JSON.stringify(lines)}; stderr: ${stderr}`))
      }, ms)
      waiters.add(w)
    })
  }
  let nextId = 0
  const ext = {
    lines,
    next,
    /** The extension's reply to a session.starting for `session` starting with `env`; `extra` overrides the rest of its payload. */
    async starting(session, sessionEnv, extra = {}) {
      const id = ++nextId
      send({ type: 'signal', id, signal: 'session.starting', payload: { session, agent: null, kind: 'agent', harness: 'claude', cwd: dir, reason: 'spawn', env: sessionEnv, ...extra } })
      const line = await next((m) => m.type === 'reply' && m.id === id, 30_000)
      if (line.error) throw new Error(line.error)
      return line.reply
    },
    /** A failed shell call's tool.result for `session`; `extra` overrides the rest of it. */
    toolResult(session, output, extra = {}) {
      send({ type: 'tool.result', session, agent: null, harness: 'claude', tool: 'Bash', input: 'aws s3 ls', error: true, output, ...extra })
    },
    /** Answers the extension's message as crew would. */
    answerMessage(id, answer) {
      send({ type: 'message.result', id, ...answer })
    },
    /** Each aws-vault call so far: its argv and whether AWS_VAULT was set. */
    calls() {
      try {
        return readFileSync(`${scriptFile}.calls`, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      } catch {
        return []
      }
    },
    stop() {
      const exited = new Promise((r) => child.once('exit', r))
      send({ type: 'stop' })
      return exited
    },
  }
  send({ type: 'hello', protocol: 1, crew: '0.1.0' })
  await next((m) => m.type === 'ready')
  return ext
}

/** What the extension's credentials server answers an agent's SDK, as the container provider asks it. */
export async function fetchCreds(env) {
  const res = await fetch(env.AWS_CONTAINER_CREDENTIALS_FULL_URI, { headers: { Authorization: env.AWS_CONTAINER_AUTHORIZATION_TOKEN } })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/** `base` with the extension's reply applied, as crew applies it. */
export function applyReply(base, reply) {
  const env = { ...base, ...(reply?.set ?? {}) }
  for (const key of reply?.unset ?? []) delete env[key]
  return env
}

/** Resolves once `check` holds, polling; rejects after `ms`. */
export async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > until) throw new Error('condition never held')
    await sleep(50)
  }
}
