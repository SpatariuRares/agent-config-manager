// Helpers for agent CLIs: option-like values, and commands shown for the user to paste into a terminal.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shellQuote } from './cli.ts'

test('shellQuote: plain words stay as they are; anything a shell would read differently is single-quoted', () => {
  assert.equal(shellQuote(['gemini', 'extensions', 'install', 'https://github.com/a/b', '--ref', 'main', '--consent']), 'gemini extensions install https://github.com/a/b --ref main --consent')
  assert.equal(shellQuote(['gemini', 'extensions', 'install', '/tmp/a b;$(id)']), `gemini extensions install '/tmp/a b;$(id)'`)
  assert.equal(shellQuote(['--ref main']), `'--ref main'`)
  assert.equal(shellQuote(["it's"]), `'it'\\''s'`)
  assert.equal(shellQuote(['']), `''`)
  assert.equal(shellQuote(['a`b', 'c*', '~/x', 'd&e', 'f|g', 'h>i', '$HOME', 'line\nbreak']), `'a\`b' 'c*' '~/x' 'd&e' 'f|g' 'h>i' '$HOME' 'line\nbreak'`)
})
