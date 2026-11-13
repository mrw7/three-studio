import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPluginRuntime } from './runtime.mjs'

const createHarness = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'three-studio-plugins-'))
  const tools = new Map()
  const promptSections = []
  const runtime = await createPluginRuntime({
    dataDir,
    tools,
    promptSections,
    modelSettings: {},
    runSubagent: async () => 'subagent result',
    selectionOf: () => null,
  })
  return { dataDir, tools, promptSections, runtime }
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
    const unavailable = await runtime.install('scheduled-tasks')
    assert.equal(unavailable.ok, false)
    assert.deepEqual(runtime.installed().sort(), ['subagents', 'web-fetch'])
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
