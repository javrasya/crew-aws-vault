// The credentials server every session's AWS SDK asks, as the container
// credential provider does: GET <AWS_CONTAINER_CREDENTIALS_FULL_URI> with
// AWS_CONTAINER_AUTHORIZATION_TOKEN as its Authorization header. The path
// names the profile, so sessions of different profiles share one server.
import { createServer } from 'node:http'

/** An SDK gives up on the container endpoint after about a second; answer before that. */
const ANSWER_WITHIN_MS = 800

const PROFILE_PATH = /^\/creds\/([^/]+)$/

/** The profile a request's path names, or undefined for any other path. */
function profileOf(url) {
  const encoded = new URL(url, 'http://localhost').pathname.match(PROFILE_PATH)?.[1]
  try {
    return encoded && decodeURIComponent(encoded)
  } catch {
    return undefined
  }
}

/**
 * Listens on `port` (any free one when 0, or when it is taken) for requests
 * carrying `token`.
 * @param {{ port: number, token: string, credentialsFor: (profile: string) => Promise<import('./aws-vault.mjs').Credentials | undefined> }} opts
 * @returns {Promise<{ port: number, envFor(profile: string): Record<string, string> }>}
 */
export async function startServer({ port, token, credentialsFor }) {
  const server = createServer(async (req, res) => {
    const answer = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    try {
      if (req.method !== 'GET' || req.headers.authorization !== token) return answer(403, { message: 'not authorised' })
      const profile = profileOf(req.url)
      if (!profile) return answer(404, { message: 'no such profile path' })
      const waited = new Promise((resolve) => setTimeout(resolve, ANSWER_WITHIN_MS).unref())
      const credentials = await Promise.race([credentialsFor(profile), waited])
      if (!credentials) return answer(503, { message: `aws-vault has no credentials for ${profile} yet` })
      answer(200, { AccessKeyId: credentials.AccessKeyId, SecretAccessKey: credentials.SecretAccessKey, Token: credentials.SessionToken, Expiration: credentials.Expiration })
    } catch (e) {
      answer(500, { message: String(e?.message ?? e) })
    }
  })
  // An agent's SDK keeps the connection open between fetches; never let that hold the extension.
  server.keepAliveTimeout = 1000
  const listen = (on) =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(on, '127.0.0.1', () => {
        server.off('error', reject)
        resolve(undefined)
      })
    })
  await listen(port).catch((e) => {
    if (port === 0 || e.code !== 'EADDRINUSE') throw e
    console.error(`port ${port} is taken; sessions set up before this restart lose their credentials until revived`)
    return listen(0)
  })
  server.unref()
  const bound = /** @type {import('node:net').AddressInfo} */ (server.address()).port
  return {
    port: bound,
    envFor: (profile) => ({ AWS_CONTAINER_CREDENTIALS_FULL_URI: `http://127.0.0.1:${bound}/creds/${encodeURIComponent(profile)}`, AWS_CONTAINER_AUTHORIZATION_TOKEN: token }),
  }
}
