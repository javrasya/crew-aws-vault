import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { applyReply, cleanUp, creds, fetchCreds, MIN, scratch, sleep, startExtension as start, waitFor } from './harness.mjs'

after(cleanUp)

// What `aws-vault exec dev -- crew start` leaves in every agent's env.
const execEnv = { AWS_VAULT: 'dev', AWS_REGION: 'eu-west-1', AWS_ACCESS_KEY_ID: 'spawn-key', AWS_SECRET_ACCESS_KEY: 'spawn-secret', AWS_SESSION_TOKEN: 'spawn-token', AWS_CREDENTIAL_EXPIRATION: new Date(Date.now() + 60_000).toISOString(), HOME: '/home/op' }
// A shell with only a profile named, no `aws-vault exec` around it.
const profileEnv = { AWS_PROFILE: 'dev', AWS_REGION: 'eu-west-1', HOME: '/home/op' }

const expired = 'An error occurred (ExpiredToken) when calling the ListBuckets operation: The security token included in the request is expired'
const messages = (ext) => ext.lines.filter((m) => m.type === 'message')

test("a starting session is pointed at the extension's credentials server, which serves fresh aws-vault credentials for its profile", async () => {
  const ext = await start({ script: [{ stdout: creds('fresh') }], env: { AWS_VAULT: 'outer' } })
  const env = applyReply(execEnv, await ext.starting('1', execEnv))

  for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_CREDENTIAL_EXPIRATION', 'AWS_PROFILE', 'AWS_VAULT']) assert.equal(env[key], undefined, key)
  assert.equal(env.AWS_REGION, 'eu-west-1')
  assert.match(env.AWS_CONTAINER_CREDENTIALS_FULL_URI, /^http:\/\/127\.0\.0\.1:\d+\//)
  assert.ok(env.AWS_CONTAINER_AUTHORIZATION_TOKEN)

  const { status, body } = await fetchCreds(env)
  assert.equal(status, 200)
  assert.equal(body.AccessKeyId, 'fresh')
  assert.equal(body.SecretAccessKey, 'fresh-secret')
  assert.equal(body.Token, 'fresh-token')
  assert.ok(body.Expiration)
  assert.deepEqual(ext.calls(), [{ argv: ['export', '--format=json', 'dev'], awsVault: null }])
})

test('credentials still good are shared by every session and every fetch, with no second aws-vault call', async () => {
  const ext = await start({ script: [{ stdout: creds('one') }, { stdout: creds('two') }] })
  const a = applyReply(execEnv, await ext.starting('1', execEnv))
  const b = applyReply(execEnv, await ext.starting('2', execEnv))
  assert.equal((await fetchCreds(a)).body.AccessKeyId, 'one')
  assert.equal((await fetchCreds(b)).body.AccessKeyId, 'one')
  assert.equal(ext.calls().length, 1)
})

test('credentials near their expiry are still served while aws-vault refreshes them behind the fetch', async () => {
  const ext = await start({ script: [{ stdout: creds('old', 10 * MIN) }, { stdout: creds('new'), delayMs: 300 }] })
  const env = applyReply(execEnv, await ext.starting('1', execEnv))
  assert.equal((await fetchCreds(env)).body.AccessKeyId, 'old')
  await waitFor(async () => (await fetchCreds(env)).body.AccessKeyId === 'new')
  assert.equal(ext.calls().length, 2)
})

test('expired credentials are refreshed before the fetch is answered', async () => {
  const ext = await start({ script: [{ stdout: creds('old', -MIN) }, { stdout: creds('new') }] })
  const env = applyReply(execEnv, await ext.starting('1', execEnv))
  assert.equal((await fetchCreds(env)).body.AccessKeyId, 'new')
})

test('a fetch of expired credentials is not kept waiting on a slow aws-vault: it is refused at once, and served once aws-vault is done', async () => {
  const ext = await start({ script: [{ stdout: creds('old', -MIN) }, { stdout: creds('new'), delayMs: 2500 }] })
  const env = applyReply(execEnv, await ext.starting('1', execEnv))
  const asked = Date.now()
  assert.equal((await fetchCreds(env)).status, 503)
  assert.ok(Date.now() - asked < 1500, `answered after ${Date.now() - asked} ms`)
  await waitFor(async () => (await fetchCreds(env)).status === 200)
  assert.equal(ext.calls().length, 2)
})

test('a failed aws-vault leaves a session with only a profile its own env, tells the operator why, and is not asked again until its cooldown passes', async () => {
  const ext = await start({ script: [{ exit: 1, stderr: 'aws-vault: error: keychain is locked\n' }, { stdout: creds('back') }], env: { CREW_AWS_VAULT_COOLDOWN_MS: '500' } })
  assert.equal(await ext.starting('1', profileEnv), null)
  const notice = await ext.next((m) => m.type === 'notice' && m.level === 'error')
  assert.match(notice.text, /dev/)
  assert.match(notice.text, /keychain is locked/)

  assert.equal(await ext.starting('2', profileEnv), null)
  assert.equal(ext.calls().length, 1)

  await sleep(600)
  const env = applyReply(profileEnv, await ext.starting('3', profileEnv))
  assert.equal((await fetchCreds(env)).body.AccessKeyId, 'back')
  assert.equal(ext.calls().length, 2)
})

test('a session started under aws-vault exec is pointed at the server even when aws-vault fails, and gets credentials once it works again', async () => {
  const ext = await start({ script: [{ exit: 1, stderr: 'aws-vault: error: keychain is locked\n' }, { stdout: creds('back') }], env: { CREW_AWS_VAULT_COOLDOWN_MS: '300' } })
  const env = applyReply(execEnv, await ext.starting('1', execEnv))
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined)
  assert.equal((await fetchCreds(env)).status, 503)
  await sleep(400)
  await waitFor(async () => (await fetchCreds(env)).status === 200)
  assert.equal((await fetchCreds(env)).body.AccessKeyId, 'back')
})

test('starts waiting on an SSO sign-in are held with its link, the operator is told once, and aws-vault runs once for all of them', async () => {
  const url = 'https://device.sso.eu-west-1.amazonaws.com/?user_code=ABCD-EFGH'
  const ext = await start({ script: [{ stderr: `Opening the SSO authorization page in your default browser (use Ctrl-C to abort)\n${url}\n`, delayMs: 700, stdout: creds('signed-in') }] })
  const [a, b] = await Promise.all([ext.starting('1', execEnv), ext.starting('2', execEnv)])

  assert.equal((await fetchCreds(applyReply(execEnv, a))).body.AccessKeyId, 'signed-in')
  assert.ok(b.set.AWS_CONTAINER_CREDENTIALS_FULL_URI)
  for (const session of ['1', '2']) {
    const held = ext.lines.filter((m) => m.type === 'holding' && m.session === session)
    assert.ok(
      held.some((m) => m.why.includes(url) && m.why.includes('ABCD-EFGH') && m.why.includes('dev')),
      `session ${session}: ${JSON.stringify(held)}`,
    )
  }
  const notices = ext.lines.filter((m) => m.type === 'notice' && m.text.includes(url))
  assert.equal(notices.length, 1)
  assert.equal(notices[0].level, 'warn')
  assert.equal(ext.calls().length, 1)
})

test("an expired token in a session's tool output refreshes its profile's credentials and tells that agent, once, to retry", async () => {
  const ext = await start({ script: [{ stdout: creds('first') }, { stdout: creds('second'), delayMs: 200 }] })
  const env = applyReply(execEnv, await ext.starting('1', execEnv))
  ext.toolResult('1', expired)
  ext.toolResult('1', `Exit code 254\n${expired}`)

  const message = await ext.next((m) => m.type === 'message' && m.session === '1')
  assert.match(message.text, /dev/)
  assert.match(message.text, /retry/i)
  ext.answerMessage(message.id, { result: 'typed' })
  assert.equal((await fetchCreds(env)).body.AccessKeyId, 'second')
  await sleep(300)
  assert.equal(messages(ext).length, 1)
  assert.equal(ext.calls().length, 2)
})

test('an agent is not told to retry when aws-vault hands back the very credentials that were refused', async () => {
  const ext = await start({ script: [{ stdout: creds('same') }] })
  await ext.starting('1', execEnv)
  ext.toolResult('1', expired)
  await waitFor(() => ext.calls().length === 2)
  await sleep(200)
  assert.equal(messages(ext).length, 0)
})

test('tool output that did not fail, of a session the extension did not set up, or with no expired token in it, is left alone', async () => {
  const ext = await start({ script: [{ stdout: creds('first') }, { stdout: creds('second') }] })
  await ext.starting('1', execEnv)
  assert.equal(await ext.starting('2', { HOME: '/home/op' }), null)
  ext.toolResult('2', expired)
  ext.toolResult('1', 'npm ERR! test failed', { tool: 'bash', harness: 'pi' })
  ext.toolResult('1', `grep -r ExpiredToken README.md\n${expired}`, { error: false })
  await sleep(400)
  assert.equal(messages(ext).length, 0)
  assert.equal(ext.calls().length, 1)
})

test('a revive the extension cannot set up is no longer its: an expired token in it is left alone', async () => {
  const ext = await start({ script: [{ stdout: creds('first', -MIN) }, { exit: 1, stderr: 'aws-vault: error: profile gone\n' }], env: { CREW_AWS_VAULT_COOLDOWN_MS: '0' } })
  assert.ok((await ext.starting('1', profileEnv)).set)
  assert.equal(await ext.starting('1', profileEnv, { reason: 'revive' }), null)
  const calls = ext.calls().length
  ext.toolResult('1', expired)
  await sleep(300)
  assert.equal(ext.calls().length, calls)
  assert.equal(messages(ext).length, 0)
})

test('a log tail is left as it is', async () => {
  const ext = await start({ script: [{ stdout: creds('fresh') }] })
  assert.equal(await ext.starting('1', execEnv, { kind: 'tail', harness: null }), null)
  assert.equal(ext.calls().length, 0)
})

test("a pi agent's own aws-vault refresher is told to stand down, by a profile it finds no SSO sign-in for", async () => {
  const ext = await start({ script: [{ stdout: creds('fresh') }] })
  const reply = await ext.starting('1', execEnv, { harness: 'pi' })
  assert.equal(reply.set.PI_AWS_PROFILE, 'crew-aws-vault')
})

test('the credentials server answers no one without the token the extension handed its sessions, nor any path but a profile', async () => {
  const ext = await start({ script: [{ stdout: creds('fresh') }] })
  const env = applyReply(execEnv, await ext.starting('1', execEnv))
  const res = await fetch(env.AWS_CONTAINER_CREDENTIALS_FULL_URI, { headers: { Authorization: 'guess' } })
  assert.equal(res.status, 403)
  assert.doesNotMatch(await res.text(), /fresh/)
  assert.equal((await fetch(env.AWS_CONTAINER_CREDENTIALS_FULL_URI)).status, 403)

  const origin = new URL(env.AWS_CONTAINER_CREDENTIALS_FULL_URI).origin
  const auth = { headers: { Authorization: env.AWS_CONTAINER_AUTHORIZATION_TOKEN } }
  assert.equal((await fetch(`${origin}/anything`, auth)).status, 404)
  assert.equal((await fetch(`${origin}/creds/%E0%A4%A`, auth)).status, 404)
  assert.equal((await fetchCreds(env)).status, 200)
  assert.equal(ext.calls().length, 1)
})

test('sessions set up before the extension restarts keep their server, and their expired tokens are still recognised', async () => {
  const crewHome = scratch()
  const before = await start({ script: [{ stdout: creds('first') }], crewHome })
  const env = applyReply(execEnv, await before.starting('1', execEnv))
  await before.stop()

  const ext = await start({ script: [{ stdout: creds('second') }, { stdout: creds('third') }], crewHome })
  assert.equal((await fetchCreds(env)).body.AccessKeyId, 'second')
  ext.toolResult('1', expired)
  const message = await ext.next((m) => m.type === 'message' && m.session === '1')
  assert.match(message.text, /retry/i)
})

test("a session that names no profile gets the profile in the extension's config file in crew's home", async () => {
  const crewHome = scratch()
  writeFileSync(join(crewHome, 'aws-vault.config.json'), JSON.stringify({ profile: 'configured' }))
  const ext = await start({ script: [{ stdout: creds('from-config') }], crewHome })
  const bare = { HOME: '/home/op', AWS_REGION: 'eu-west-1' }
  const env = applyReply(bare, await ext.starting('1', bare, { harness: 'pi' }))
  assert.equal(env.PI_AWS_PROFILE, 'crew-aws-vault')
  assert.equal((await fetchCreds(env)).body.AccessKeyId, 'from-config')
  assert.deepEqual(ext.calls(), [{ argv: ['export', '--format=json', 'configured'], awsVault: null }])

  assert.ok((await ext.starting('2', { ...bare, AWS_PROFILE: 'mine' })).set.AWS_CONTAINER_CREDENTIALS_FULL_URI.endsWith('/creds/mine'))
})
