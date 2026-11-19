import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compactSessions, createSessionWriter } from './sessions.mjs'

function session(id, turns = 3) {
  const row = { id, title: id, updatedAt: Number(id.replace(/\D/gu, '')) || 1, running: false, events: [], history: [] }
  for (let index = 1; index <= turns; index += 1) {
    row.history.push({ role: 'user', text: `prompt-${String(index)}` })
    row.history.push({ role: 'assistant', text: `answer-${String(index)}` })
    row.events.push({ seq: index, type: 'user/message' })
    row.events.push({ seq: index + turns, type: 'assistant/message' })
  }
  return row
}

test('compaction removes complete oldest turns and marks the session', () => {
  const rows = new Map([['s1', session('s1', 4)]])
  const result = compactSessions(rows, {
    sessions: 10, events: 4, history: 4, sessionBytes: 100000, totalBytes: 1000000, promptBytes: 1000,
  })
  const current = rows.get('s1')
  assert.equal(result.count, 1)
  assert.equal(current.history.length, 4)
  assert.equal(current.history[0].text, 'prompt-3')
  assert.equal(current.events.length, 4)
  assert.equal(current.historyTrimmed, true)
})

test('running sessions are left untouched during compaction', () => {
  const current = session('s1', 4)
  current.running = true
  const rows = new Map([['s1', current]])
  compactSessions(rows, {
    sessions: 10, events: 1, history: 1, sessionBytes: 100, totalBytes: 100, promptBytes: 1000,
  })
  assert.equal(current.history.length, 8)
  assert.equal(current.events.length, 8)
})

test('session writer serializes atomic writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'three-studio-sessions-'))
  try {
    const path = join(dir, 'sessions.json')
    const rows = new Map([['s1', session('s1', 1)]])
    const save = createSessionWriter(path, rows)
    rows.get('s1').title = 'first'
    const first = save()
    rows.get('s1').title = 'last'
    const second = save()
    await Promise.all([first, second])
    const stored = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(stored[0].title, 'last')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
