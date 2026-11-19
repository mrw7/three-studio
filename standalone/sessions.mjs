/** Bounded conversation retention and serialized, atomic session persistence. */
import { writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export const SESSION_LIMITS = Object.freeze({
  sessions: 500,
  events: 1000,
  history: 200,
  sessionBytes: 2 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  promptBytes: 64 * 1024,
})
const bytes = value => Buffer.byteLength(JSON.stringify(value))

// Remove whole turns so every retained tool result has its assistant call.
function trimTurn(session) {
  if (session.history.length === 0 && session.events.length === 0) return false
  const historyBoundary = session.history.findIndex((row, index) => index > 0 && row.role === 'user')
  const eventBoundary = session.events.findIndex((row, index) => index > 0 && row.type === 'user/message')
  session.history.splice(0, historyBoundary < 0 ? session.history.length : historyBoundary)
  session.events.splice(0, eventBoundary < 0 ? session.events.length : eventBoundary)
  session.historyTrimmed = true
  return true
}

export function compactSessions(sessions, limits = SESSION_LIMITS) {
  const rows = [...sessions.values()]
  let trimmed = 0
  for (const session of rows) {
    // Never mutate a history array while runAgent is using it.
    if (session.running) continue
    while (session.events.length > limits.events || session.history.length > limits.history
      || bytes(session) > limits.sessionBytes) {
      if (!trimTurn(session)) break
      trimmed += 1
    }
  }
  let size = bytes(rows)
  for (const session of [...rows].sort((a, b) => a.updatedAt - b.updatedAt)) {
    if (size <= limits.totalBytes) break
    if (session.running) continue
    while (size > limits.totalBytes) {
      const before = bytes(session)
      if (!trimTurn(session)) break
      trimmed += 1
      size -= before - bytes(session)
    }
  }
  return { bytes: size, count: rows.length, trimmed, limits }
}

export function createSessionWriter(path, sessions) {
  let pending = Promise.resolve()
  return () => {
    const write = async () => {
      compactSessions(sessions)
      const temp = `${path}.${randomUUID()}.tmp`
      await writeFile(temp, JSON.stringify([...sessions.values()]), { mode: 0o600 })
      await rename(temp, path)
    }
    pending = pending.catch(() => {}).then(write)
    return pending
  }
}
