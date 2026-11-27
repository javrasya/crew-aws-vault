import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { cleanUp, creds, MIN, startExtension as start } from './harness.mjs'

after(cleanUp)

const execEnv = { AWS_VAULT: 'dev', AWS_REGION: 'eu-west-1', HOME: '/home/op' }

test("a mint of the aws-vault source answers with the profile's exported keys and their expiry", async () => {
  const ext = await start({ script: [{ stdout: creds('minted') }] })
  const { reply, error } = await ext.mint('dev')
  assert.equal(error, undefined)
  assert.equal(reply.accessKeyId, 'minted')
  assert.equal(reply.secretAccessKey, 'minted-secret')
  assert.equal(reply.sessionToken, 'minted-token')
  assert.ok(Date.parse(reply.expiresAt) > Date.now())
  assert.deepEqual(ext.calls(), [{ argv: ['export', '--format=json', 'dev'], awsVault: null }])
})

test('an acquire is answered from the copy a session already caused to be exported, and a renew exports again', async () => {
  const ext = await start({ script: [{ stdout: creds('one') }, { stdout: creds('two') }] })
  await ext.starting('1', execEnv)
  assert.equal((await ext.mint('dev')).reply.accessKeyId, 'one')
  assert.equal(ext.calls().length, 1)
  assert.equal((await ext.mint('dev', 'renew')).reply.accessKeyId, 'two')
  assert.equal(ext.calls().length, 2)
})

test('an acquire with only near-expiry keys held exports again rather than hand them out', async () => {
  const ext = await start({ script: [{ stdout: creds('old', 5 * MIN) }, { stdout: creds('new') }] })
  await ext.starting('1', execEnv)
  assert.equal((await ext.mint('dev')).reply.accessKeyId, 'new')
})

test("a failed export fails the mint in aws-vault's words, and so does a mint in its cooldown, with no second export", async () => {
  const ext = await start({ script: [{ exit: 1, stderr: 'aws-vault: error: keychain is locked\n' }, { stdout: creds('back') }] })
  const first = await ext.mint('dev')
  assert.equal(first.reply, undefined)
  assert.match(first.error, /keychain is locked/)
  assert.match((await ext.mint('dev')).error, /keychain is locked/)
  assert.equal(ext.calls().length, 1)
})

test("a mint waiting on an SSO sign-in says it is holding with the sign-in's link and code", async () => {
  const url = 'https://device.sso.eu-west-1.amazonaws.com/?user_code=ABCD-EFGH'
  const ext = await start({ script: [{ stderr: `Opening the SSO authorization page in your default browser (use Ctrl-C to abort)\n${url}\n`, delayMs: 700, stdout: creds('signed-in') }] })
  const { reply, holding } = await ext.mint('dev')
  assert.equal(reply.accessKeyId, 'signed-in')
  assert.deepEqual(holding, [`sign in to AWS for dev with code ABCD-EFGH: ${url}`])
})

test('a mint with no profile is refused, with no export', async () => {
  const ext = await start({ script: [{ stdout: creds('unused') }] })
  assert.match((await ext.mint('')).error, /no aws-vault profile/)
  assert.deepEqual(ext.calls(), [])
})
