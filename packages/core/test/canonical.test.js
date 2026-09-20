/**
 * Conformance against the shared vectors in `docs/canonical-vectors.json`.
 *
 * The Rust peer runs the same file. Two implementations agreeing with each
 * other by accident is not the same as two implementations agreeing with a
 * written rule, and only the second survives someone writing a third.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { canonical } from '../src/codec.js'

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../docs/canonical-vectors.json', import.meta.url)), 'utf8')
)

test('every valid vector encodes to exactly the documented bytes', () => {
  for (const v of vectors.valid) {
    assert.equal(canonical(v.input), v.canonical, v.why)
  }
})

test('every rejected vector is refused rather than guessed at', () => {
  for (const v of vectors.rejected) {
    assert.throws(() => canonical(JSON.parse(v.json)), undefined, v.why)
  }
})

test('the vector file covers the cases that actually diverged', () => {
  const whys = vectors.valid.map((v) => v.why).join(' ')
  assert.match(whys, /code point/, 'key ordering must stay covered')
  assert.match(whys, /non-ASCII/, 'literal UTF-8 must stay covered')
  assert.match(whys, /normalises/, 'number normalisation must stay covered')
  assert.ok(vectors.rejected.length >= 3, 'the refusal cases must not quietly disappear')
})
