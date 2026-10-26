/**
 * Offline smoke test: load the plugin with a mock DSH context and check
 *   - both model tools register with the expected schemas and render paths;
 *   - the Web UI manifest is wired;
 *   - the /api/openai-codex-image routes answer JSON, apply the trust fence,
 *     and do not reach the network for status / unknown paths.
 *
 * No network, no credentials, no image generation. Run with `node scripts/smoke.mjs`.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { apply } from '../index.js'

const here = dirname(fileURLToPath(import.meta.url))

const registered = []
const routes = []
const effect = run => {
  const dispose = run()
  return typeof dispose === 'function' ? dispose : () => {}
}
const ctx = {
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
  inject(_dependencies, callback) {
    callback({
      effect,
      webServer: {
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
    })
  },
  effect,
  logger: { info() {}, warn() {} },
  // No credentials / connection / attachments in this composition: the Web API
  // must still answer, with the unauthenticated status and the structural fence.
  get() {
    return undefined
  },
}

apply(ctx, { authFile: join(here, 'no-such-codex-auth.json') })

assert.deepEqual(
  registered.map(tool => tool.name).sort(),
  ['generate_image', 'openai_account'],
  'expected exactly generate_image and openai_account',
)

const generate = registered.find(tool => tool.name === 'generate_image')
assert.deepEqual(generate.parameters.required, ['prompt'])
assert.equal(generate.parameters.properties.size.enum.length, 7)
assert.doesNotThrow(() => {
  const blocks = generate.output.render(
    {},
    {
      path: 'generated_images/example.png',
      width: 1024,
      height: 1024,
      bytes: 1024,
      model: 'gpt-image-2',
      size: '1024x1024',
    },
  )
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /example\.png/)
})

const account = registered.find(tool => tool.name === 'openai_account')
assert.deepEqual(account.parameters.properties.action.enum, ['status', 'login_start', 'login_poll', 'logout'])

const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
assert.equal(manifest.dsh.client.platform, 'web')
assert.equal(manifest.exports['./client'], './client.js')

// ── Web API route ────────────────────────────────────────────────────────────
assert.equal(routes.length, 1, 'expected one registered Web route')
assert.equal(routes[0].kind, 'prefix')
assert.equal(routes[0].path, '/api/openai-codex-image')

function request(path, method = 'GET', host = '127.0.0.1:43120') {
  return { url: path, method, headers: { host } }
}

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value
    },
    end(body) {
      this.body = body ?? ''
      this.headersSent = true
    },
  }
}

async function call(path, method, host) {
  const res = response()
  await routes[0].handler(request(path, method, host), res)
  return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers }
}

const status = await call('/api/openai-codex-image/status')
assert.equal(status.status, 200)
assert.equal(status.body.authorized, false, 'no credentials mounted means unauthorized')
assert.equal(status.headers['cache-control'], 'no-store')

const unknown = await call('/api/openai-codex-image/nope')
assert.equal(unknown.status, 404)

const wrongMethod = await call('/api/openai-codex-image/status', 'POST')
assert.equal(wrongMethod.status, 405)

const pollWithoutStart = await call('/api/openai-codex-image/login/poll', 'POST')
assert.equal(pollWithoutStart.status, 400)
assert.match(pollWithoutStart.body.error, /login_start/)

const foreignHost = await call('/api/openai-codex-image/status', 'GET', 'example.invalid:43120')
assert.equal(foreignHost.status, 403, 'the structural fence must reject a non-loopback Host')

console.log('smoke OK: tools, schemas, client manifest and Web API routes are valid')
