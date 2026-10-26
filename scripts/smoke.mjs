/**
 * Offline smoke test: load the plugin with a mock DSH context and check that
 * both tools register with the expected schemas and render paths.
 *
 * No network, no credentials, no image generation. Run with `node scripts/smoke.mjs`.
 */

import assert from 'node:assert/strict'
import { apply } from '../index.js'

const registered = []
const ctx = {
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
  logger: { info() {}, warn() {} },
  get() {
    return undefined
  },
}

apply(ctx, {})

assert.deepEqual(
  registered.map((tool) => tool.name).sort(),
  ['generate_image', 'openai_account'],
  'expected exactly generate_image and openai_account',
)

const generate = registered.find((tool) => tool.name === 'generate_image')
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

const account = registered.find((tool) => tool.name === 'openai_account')
assert.deepEqual(account.parameters.properties.action.enum, ['status', 'login_start', 'login_poll', 'logout'])

console.log('smoke OK: tools, schemas and render paths are valid')
