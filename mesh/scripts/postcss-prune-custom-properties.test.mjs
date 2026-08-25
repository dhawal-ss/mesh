import assert from 'node:assert/strict'
import test from 'node:test'
import postcss from 'postcss'
import {
  customPropertiesReferencedByRuntimeSource,
  pruneUnreachableCustomProperties,
} from './postcss-prune-custom-properties.mjs'

async function optimize(source, runtimeSource = '') {
  const retainedProperties = customPropertiesReferencedByRuntimeSource(runtimeSource)
  const result = await postcss([pruneUnreachableCustomProperties({ retainedProperties })])
    .process(source, { from: undefined })
  return result.css
}

test('keeps direct CSS consumers and their complete dependency chain', async () => {
  const result = await optimize(`
    :root {
      --reference: #fff;
      --semantic: var(--reference);
      --component: var(--semantic);
      --dead: #000;
    }
    .surface { color: var(--component); }
  `)

  assert.match(result, /--reference:/)
  assert.match(result, /--semantic:/)
  assert.match(result, /--component:/)
  assert.doesNotMatch(result, /--dead:/)
})

test('keeps properties referenced directly by renderer source', async () => {
  const result = await optimize(`
    :root { --runtime-avatar: #fff; --unused: #000; }
  `, `const avatar = 'var(--runtime-avatar)'`)

  assert.match(result, /--runtime-avatar:/)
  assert.doesNotMatch(result, /--unused:/)
})

test('removes every unreachable theme override and its empty rule', async () => {
  const result = await optimize(`
    :root { --unused: #000; --used: #fff; }
    [data-theme='light'] { --unused: #eee; --used: #111; }
    [data-theme='empty'] { --unused: #ddd; }
    body { color: var(--used); }
  `)

  assert.doesNotMatch(result, /--unused:/)
  assert.doesNotMatch(result, /data-theme='empty'/)
  assert.equal((result.match(/--used:/g) ?? []).length, 2)
})

test('keeps custom properties consumed from at-rule parameters', async () => {
  const result = await optimize(`
    :root { --viewport: 40rem; --dead: 1px; }
    @media (min-width: var(--viewport)) { body { display: block; } }
  `)

  assert.match(result, /--viewport:/)
  assert.doesNotMatch(result, /--dead:/)
})
