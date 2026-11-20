import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPluginRuntime } from './runtime.mjs'

const createHarness = async (overrides = {}) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'three-studio-plugins-'))
  const tools = new Map()
  const promptSections = []
  const pluginRoutes = []
  const listeners = []
  const submitted = []
  const runtime = await createPluginRuntime({
    dataDir,
    tools,
    promptSections,
    pluginRoutes,
    subscribe: (event, handler) => {
      const entry = { event, handler }
      listeners.push(entry)
      return () => {
        const index = listeners.indexOf(entry)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    submitPrompt: async (sessionId, text) => {
      submitted.push({ sessionId, text })
      return true
    },
    modelSettings: {},
    runSubagent: async () => 'subagent result',
    selectionOf: () => null,
    ...overrides,
  })
  return {
    dataDir, tools, promptSections, pluginRoutes, listeners, submitted, runtime,
    fire: (event, payload) => {
      for (const entry of [...listeners]) {
        if (entry.event === event) entry.handler(payload)
      }
    },
  }
}

test('skills installs a read_skill tool and can be removed', async () => {
  const { dataDir, tools, promptSections, runtime } = await createHarness()
  try {
    const installed = await runtime.install('skills')
    assert.equal(installed.ok, true)
    assert.equal(tools.has('read_skill'), true)
    assert.equal(promptSections.some(section => section.name === 'studio:skills'), true)
    const value = await tools.get('read_skill').execute({ name: 'threejs-scene' }, {})
    assert.match(value.text, /Three\.js scene skill/)
    assert.equal(runtime.catalog().find(entry => entry.id === 'skills').installed, true)
    await runtime.uninstall('skills')
    assert.equal(tools.has('read_skill'), false)
    assert.equal(promptSections.some(section => section.name === 'studio:skills'), false)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('todo and planning expose validated tools', async () => {
  const { dataDir, tools, runtime } = await createHarness()
  try {
    assert.equal((await runtime.install('todo')).ok, true)
    const todos = await tools.get('todo_write').execute({
      todos: [{ content: 'Build scene', status: 'in_progress' }],
    }, {})
    assert.equal(todos.todos[0].status, 'in_progress')
    assert.equal((await runtime.install('planning')).ok, true)
    const plan = await tools.get('write_plan').execute({
      goal: 'Optimize scene',
      steps: [{ title: 'Measure draw calls' }],
    }, {})
    assert.equal(plan.goal, 'Optimize scene')
    assert.equal(plan.steps.length, 1)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('subagents and web reader add their tools; unavailable entries are refused', async () => {
  const { dataDir, tools, runtime } = await createHarness()
  try {
    assert.equal((await runtime.install('subagents')).ok, true)
    assert.equal(tools.has('spawn_subagent'), true)
    assert.equal((await runtime.install('web-fetch')).ok, true)
    assert.equal(tools.has('web_fetch'), true)
    await assert.rejects(
      tools.get('web_fetch').execute({ url: 'http://127.0.0.1:3090/' }, {}),
      /private or local/,
    )
    const unavailable = await runtime.install('not-a-plugin')
    assert.equal(unavailable.ok, false)
    assert.deepEqual(runtime.installed().sort(), ['subagents', 'web-fetch'])
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('memory persists entries across runs and updates the prompt section', async () => {
  const first = await createHarness()
  let saved = null
  try {
    assert.equal((await first.runtime.install('memory')).ok, true)
    assert.equal(first.tools.has('memory_write'), true)
    assert.equal(first.tools.has('memory_forget'), true)
    const section = () => first.promptSections.find(entry => entry.name === 'studio:memory')
    assert.match(section().text, /No entries yet/)
    const written = await first.tools.get('memory_write').execute(
      { key: 'Material Palette', value: 'Cool blues, brushed metal accents' }, {})
    assert.equal(written.key, 'material palette')
    assert.equal(written.total, 1)
    assert.match(section().text, /material palette: Cool blues/)
    await assert.rejects(
      first.tools.get('memory_write').execute({ key: '../evil', value: 'x' }, {}),
      /key of letters/,
    )
    await assert.rejects(
      first.tools.get('memory_write').execute({ key: 'ok', value: '   ' }, {}),
      /non-empty/,
    )
    const forgotten = await first.tools.get('memory_forget').execute({ key: 'MATERIAL PALETTE' }, {})
    assert.equal(forgotten.forgotten, true)
    assert.match(section().text, /No entries yet/)
    await first.tools.get('memory_write').execute({ key: 'conventions', value: 'Keep part count low' }, {})
    saved = await readFile(join(first.dataDir, 'memory.json'), 'utf8')
  } finally {
    await rm(first.dataDir, { recursive: true, force: true })
  }
  // A second runtime over a fresh home with the saved store reloads it.
  assert.notEqual(saved, null)
  const second = await createHarness()
  try {
    await writeFile(join(second.dataDir, 'memory.json'), saved)
    assert.equal((await second.runtime.install('memory')).ok, true)
    const section = second.promptSections.find(entry => entry.name === 'studio:memory')
    assert.match(section.text, /conventions: Keep part count low/)
  } finally {
    await rm(second.dataDir, { recursive: true, force: true })
  }
})

test('context-files injects AGENTS.md and reads only sandboxed text files', async () => {
  const { dataDir, tools, promptSections, runtime } = await createHarness()
  try {
    await mkdir(join(dataDir, 'context'), { recursive: true })
    await writeFile(join(dataDir, 'context', 'AGENTS.md'), '# Conventions\nUse metres everywhere.', 'utf8')
    await writeFile(join(dataDir, 'context', 'notes.md'), 'scene notes', 'utf8')
    await writeFile(join(dataDir, 'context', 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]))
    assert.equal((await runtime.install('context-files')).ok, true)
    const section = promptSections.find(entry => entry.name === 'studio:context')
    assert.match(section.text, /Use metres everywhere/)
    assert.match(section.text, /notes\.md/)
    const listed = await tools.get('list_context_files').execute({}, {})
    assert.equal(listed.files.some(file => file.name === 'notes.md'), true)
    assert.equal(listed.files.some(file => file.name === 'AGENTS.md'), true)
    const read = await tools.get('read_context_file').execute({ name: 'notes.md' }, {})
    assert.equal(read.text, 'scene notes')
    await assert.rejects(
      tools.get('read_context_file').execute({ name: '../memory.json' }, {}),
      /plain file name/,
    )
    await assert.rejects(
      tools.get('read_context_file').execute({ name: 'missing.txt' }, {}),
      /Unknown context file/,
    )
    await assert.rejects(
      tools.get('read_context_file').execute({ name: 'blob.bin' }, {}),
      /binary/,
    )
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('action-cards validates actions and exposes presentationMeta', async () => {
  const { dataDir, tools, runtime } = await createHarness()
  try {
    assert.equal((await runtime.install('action-cards')).ok, true)
    const definition = tools.get('propose_actions')
    const value = await definition.execute({
      actions: [
        { label: 'Bake lighting', prompt: 'Bake the current lighting setup into the scene script.' },
        { label: '', prompt: 'dropped' },
        { label: 'Optimize', prompt: 'Reduce draw calls.', note: 'Merges static meshes' },
      ],
    }, {})
    assert.equal(value.actions.length, 2)
    assert.equal(value.actions[0].note, undefined)
    assert.equal(value.actions[1].note, 'Merges static meshes')
    const meta = definition.output.presentationMeta({}, value)
    assert.equal(meta.actions.length, 2)
    await assert.rejects(
      definition.execute({ actions: [{ label: 'x', prompt: '' }] }, {}),
      /at least one action/,
    )
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('deliverables saves session-scoped text files and caps card content', async () => {
  const { dataDir, tools, runtime } = await createHarness()
  try {
    assert.equal((await runtime.install('deliverables')).ok, true)
    const definition = tools.get('save_deliverable')
    const value = await definition.execute(
      { name: 'bake-lighting.js', text: 'console.log("baked")', note: 'Automation script' },
      { agent: { session: { id: 'studio-abc123' } } },
    )
    assert.equal(value.bytes, 20)
    assert.equal(value.path, 'deliverables/studio-abc123/bake-lighting.js')
    assert.equal(value.note, 'Automation script')
    const stored = await readFile(join(dataDir, 'deliverables', 'studio-abc123', 'bake-lighting.js'), 'utf8')
    assert.equal(stored, 'console.log("baked")')
    assert.equal(definition.output.presentationMeta({}, value).deliverable.name, 'bake-lighting.js')
    // Missing session context falls back to the shared directory.
    const shared = await definition.execute({ name: 'notes.md', text: 'hello' }, {})
    assert.equal(shared.path, 'deliverables/shared/notes.md')
    // Oversized text is refused; large-but-valid text drops the card copy.
    await assert.rejects(
      definition.execute({ name: 'big.js', text: 'x'.repeat(256 * 1024 + 1) }, {}),
      /limited to/,
    )
    const large = await definition.execute({ name: 'large.md', text: 'y'.repeat(9000) }, {})
    assert.equal(large.text, undefined)
    await assert.rejects(
      definition.execute({ name: 'run.exe', text: 'nope' }, {}),
      /text extension/,
    )
    await assert.rejects(
      definition.execute({ name: 'weird/name.js', text: 'nope' }, {}),
      /plain file name/,
    )
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('voice-input installs as a client-side no-op and uninstalls cleanly', async () => {
  const { dataDir, tools, promptSections, runtime } = await createHarness()
  try {
    assert.equal((await runtime.install('voice-input')).ok, true)
    assert.equal(tools.size, 0)
    assert.equal(promptSections.length, 0)
    assert.equal(runtime.catalog().find(entry => entry.id === 'voice-input').installed, true)
    assert.equal((await runtime.uninstall('voice-input')).ok, true)
    assert.deepEqual(runtime.installed(), [])
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('file-browser lists and reads the workspace through guarded routes', async () => {
  const harness = await createHarness()
  const { dataDir, tools, pluginRoutes, runtime } = harness
  try {
    await mkdir(join(dataDir, 'deliverables'), { recursive: true })
    await writeFile(join(dataDir, 'deliverables', 'note.md'), 'hello workspace', 'utf8')
    await writeFile(join(dataDir, 'top.txt'), 'top level', 'utf8')
    await writeFile(join(dataDir, 'blob.bin'), Buffer.from([0x00, 0x02]))
    assert.equal((await runtime.install('file-browser')).ok, true)
    const root = await tools.get('list_workspace_files').execute({ dir: '' }, {})
    assert.equal(root.entries.some(entry => entry.name === 'deliverables' && entry.kind === 'dir'), true)
    assert.equal(root.entries.some(entry => entry.name === 'top.txt' && entry.kind === 'file'), true)
    const read = await tools.get('read_workspace_file').execute({ path: 'deliverables/note.md' }, {})
    assert.equal(read.text, 'hello workspace')
    await assert.rejects(tools.get('read_workspace_file').execute({ path: '../escape.txt' }, {}), /inside the Studio home/)
    await assert.rejects(tools.get('read_workspace_file').execute({ path: 'credentials.json' }, {}), /Credentials/)
    await assert.rejects(tools.get('read_workspace_file').execute({ path: 'blob.bin' }, {}), /binary/)
    // The UI routes exist only while installed and share the same guards.
    const listRoute = pluginRoutes.find(route => route.path === '/api/plugins/file-browser/list')
    const contentRoute = pluginRoutes.find(route => route.path === '/api/plugins/file-browser/content')
    assert.notEqual(listRoute, undefined)
    assert.notEqual(contentRoute, undefined)
    const listed = await listRoute.handler(null, new URL('http://x/api?dir=deliverables'))
    assert.equal((await listed.json()).entries[0].name, 'note.md')
    const textFile = await contentRoute.handler(null, new URL('http://x/api?path=deliverables/note.md'))
    const textPayload = await textFile.json()
    assert.equal(textPayload.kind, 'text')
    assert.equal(textPayload.text, 'hello workspace')
    const refused = await contentRoute.handler(null, new URL('http://x/api?path=../etc/passwd'))
    assert.equal(refused.status, 400)
    await runtime.uninstall('file-browser')
    assert.equal(pluginRoutes.length, 0, 'routes removed on uninstall')
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('document-preview installs as the viewer half without agent surface', async () => {
  const { dataDir, tools, promptSections, runtime } = await createHarness()
  try {
    assert.equal((await runtime.install('document-preview')).ok, true)
    assert.equal(tools.size, 0)
    assert.equal(promptSections.length, 0)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('background jobs start detached and report findings when done', async () => {
  let calls = 0
  const { dataDir, tools, runtime } = await createHarness({
    runSubagent: async () => { calls += 1; return `finding ${String(calls)}` },
  })
  try {
    assert.equal((await runtime.install('background-jobs')).ok, true)
    const started = await tools.get('start_background_job').execute({ task: 'check fonts' }, {})
    assert.equal(started.status, 'running')
    await new Promise(done => setTimeout(done, 50))
    const checked = await tools.get('check_background_job').execute({ id: started.id }, {})
    assert.equal(checked.status, 'done')
    assert.equal(checked.text, 'finding 1')
    await assert.rejects(tools.get('check_background_job').execute({ id: 99 }, {}), /Unknown background job/)
    await assert.rejects(tools.get('start_background_job').execute({ task: '' }, {}), /needs a task/)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('scheduled tasks persist, validate and fire through submitPrompt', async () => {
  const harness = await createHarness({ scheduleTickMs: 50 })
  const { dataDir, tools, submitted, runtime } = harness
  try {
    // Pre-seed one due schedule so the first tick fires it.
    await writeFile(join(dataDir, 'schedules.json'), JSON.stringify({
      v: 1,
      items: [{ id: 'sched-seed', sessionId: 's1', prompt: 'check the scene', everyMinutes: 5, createdAt: 0, lastFired: 0 }],
    }), 'utf8')
    assert.equal((await runtime.install('scheduled-tasks')).ok, true)
    await new Promise(done => setTimeout(done, 250))
    assert.equal(submitted.some(entry => entry.sessionId === 's1' && entry.text === 'check the scene'), true,
      'due schedule fired through submitPrompt')
    await assert.rejects(
      tools.get('schedule_prompt').execute({ prompt: 'x', everyMinutes: 1 }, { agent: { session: { id: 's1' } } }),
      /everyMinutes must be/,
    )
    await assert.rejects(
      tools.get('schedule_prompt').execute({ prompt: 'x', everyMinutes: 10 }, {}),
      /active session/,
    )
    const created = await tools.get('schedule_prompt').execute(
      { prompt: 'second look', everyMinutes: 30 }, { agent: { session: { id: 's1' } } })
    assert.equal(created.everyMinutes, 30)
    const list = await tools.get('list_schedules').execute({}, {})
    assert.equal(list.items.length, 2)
    const store = JSON.parse(await readFile(join(dataDir, 'schedules.json'), 'utf8'))
    assert.equal(store.items.length, 2, 'store persisted')
    const cancelled = await tools.get('cancel_schedule').execute({ id: created.id }, {})
    assert.equal(cancelled.cancelled, true)
    assert.equal(cancelled.total, 1)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('hooks read user config, fire on turn-end and inject bounded notes', async () => {
  const { dataDir, tools, promptSections, runtime, fire } = await createHarness()
  try {
    await writeFile(join(dataDir, 'hooks.json'), JSON.stringify({
      hooks: [{ event: 'turn-end', say: 'Prefer metres in scene scripts.' }],
    }), 'utf8')
    assert.equal((await runtime.install('hooks')).ok, true)
    const listed = await tools.get('list_hooks').execute({}, {})
    assert.equal(listed.hooks.length, 1)
    const section = () => promptSections.find(entry => entry.name === 'studio:hooks')
    assert.match(section().text, /configured/)
    fire('turn-end', { sessionId: 's1' })
    assert.match(section().text, /Prefer metres in scene scripts/)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('web-search and deep-research validate input and honor provider keys', async () => {
  const { dataDir, tools, runtime } = await createHarness()
  try {
    assert.equal((await runtime.install('web-search')).ok, true)
    await assert.rejects(tools.get('web_search').execute({ query: '' }, {}), /needs a query/)
    assert.equal((await runtime.install('deep-research')).ok, true)
    await assert.rejects(tools.get('deep_research').execute({ question: '' }, {}), /needs a question/)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
  const keyed = await createHarness()
  try {
    await writeFile(join(keyed.dataDir, 'search.json'), JSON.stringify({ provider: 'tavily' }), 'utf8')
    assert.equal((await keyed.runtime.install('web-search')).ok, true)
    await assert.rejects(
      keyed.tools.get('web_search').execute({ query: 'three.js' }, {}),
      /Tavily needs a key/,
    )
  } finally {
    await rm(keyed.dataDir, { recursive: true, force: true })
  }
})

const MCP_ECHO_SERVER = `
const readLines = (stream, onLine) => {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    buffer += chunk
    let newline = buffer.indexOf('\\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line !== '') onLine(line)
      newline = buffer.indexOf('\\n')
    }
  })
}
readLines(process.stdin, line => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '0' } } }) + '\\n')
  } else if (message.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'Echo the payload back.' }] } }) + '\\n')
  } else if (message.method === 'tools/call') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo:' + JSON.stringify(message.params.arguments) }] } }) + '\\n')
  }
})
`

test('mcp connectors refuse without config and drive a stdio echo server', async () => {
  const bare = await createHarness()
  try {
    const refused = await bare.runtime.install('mcp-connectors')
    assert.equal(refused.ok, false)
    assert.match(refused.message, /mcp\.json/)
  } finally {
    await rm(bare.dataDir, { recursive: true, force: true })
  }
  const { dataDir, tools, runtime } = await createHarness()
  try {
    await writeFile(join(dataDir, 'mcp.json'), JSON.stringify({
      servers: [{ id: 'echo', command: process.execPath, args: ['-e', MCP_ECHO_SERVER] }],
    }), 'utf8')
    assert.equal((await runtime.install('mcp-connectors')).ok, true)
    const listed = await tools.get('mcp_list_tools').execute({}, {})
    assert.equal(listed.servers[0].id, 'echo')
    assert.equal(listed.servers[0].tools[0].name, 'echo')
    const called = await tools.get('mcp_call_tool').execute(
      { server: 'echo', tool: 'echo', arguments: { hello: 'world' } }, {})
    assert.equal(called.content, 'echo:{"hello":"world"}')
    await assert.rejects(
      tools.get('mcp_call_tool').execute({ server: 'nope', tool: 'echo' }, {}),
      /Unknown MCP server/,
    )
    await runtime.uninstall('mcp-connectors')
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('browser automation refuses without opt-in config; guarded when configured', async () => {
  const bare = await createHarness()
  try {
    const refused = await bare.runtime.install('browser-automation')
    assert.equal(refused.ok, false)
    assert.match(refused.message, /browser-automation\.json/)
  } finally {
    await rm(bare.dataDir, { recursive: true, force: true })
  }
  const { dataDir, tools, runtime } = await createHarness()
  try {
    await writeFile(join(dataDir, 'browser-automation.json'), JSON.stringify({ cdp: '127.0.0.1:9223' }), 'utf8')
    assert.equal((await runtime.install('browser-automation')).ok, true)
    await assert.rejects(
      tools.get('browser_navigate').execute({ url: 'http://192.168.1.5/' }, {}),
      /refuses private/,
    )
    await assert.rejects(
      tools.get('browser_navigate').execute({ url: 'ftp://example.com/' }, {}),
      /http\(s\)/,
    )
    await assert.rejects(
      tools.get('browser_evaluate').execute({ expression: '' }, {}),
      /needs an expression/,
    )
    await runtime.uninstall('browser-automation')
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('browser-pane installs as a client-side no-op', async () => {
  const { dataDir, tools, promptSections, runtime } = await createHarness()
  try {
    assert.equal((await runtime.install('browser-pane')).ok, true)
    assert.equal(tools.size, 0)
    assert.equal(promptSections.length, 0)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
