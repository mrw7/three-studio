/**
 * Native plugin runtime for the standalone Studio.
 *
 * A plugin activates by adding tools and system-prompt sections to the live
 * agent context; uninstalling removes exactly what it added. Installed ids
 * persist in <data-home>/plugins.json.
 */
import { mkdir, readFile, readdir, rename, stat as statFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { CATALOG } from './catalog.mjs'

const promptSection = (sections, name, order, text) => {
  const section = { name, order, text }
  sections.push(section)
  return () => {
    const index = sections.indexOf(section)
    if (index >= 0) sections.splice(index, 1)
  }
}

const toolRegistration = (tools, definition) => {
  tools.set(definition.name, definition)
  return () => {
    if (tools.get(definition.name) === definition) tools.delete(definition.name)
  }
}

const textOutput = text => [{ type: 'text', text }]

const SKILL_SEED = `---
name: threejs-scene
description: Build clean, performant Three.js scenes in the Studio sandbox.
---

# Three.js scene skill

- Use the globals provided by the sandbox: THREE, scene, camera, renderer, clock, controls, onFrame.
- Keep the part count low and reuse geometries/materials.
- Prefer MeshStandardMaterial with modest roughness/metalness and one key light plus a soft fill.
- Set scene.background explicitly; dark studio backgrounds read well with a subtle rim light.
- Use onFrame for animation and keep it frame-rate independent where possible.
- Do not load external assets unless the user asks; procedural geometry and textures are safer.
`

const parseSkill = (text, file) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(text)
  if (match === null) {
    const name = file.replace(/\.md$/iu, '')
    return { name, description: '', body: text.trim(), file }
  }
  const frontmatter = match[1]
  const body = match[2].trim()
  const value = key => {
    const line = frontmatter.split(/\r?\n/u).find(item => item.trim().startsWith(`${key}:`))
    return line === undefined ? '' : line.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/gu, '')
  }
  return {
    name: value('name') || file.replace(/\.md$/iu, ''),
    description: value('description'),
    body,
    file,
  }
}

async function activateSkills(options) {
  const root = join(options.dataDir, 'skills')
  await mkdir(root, { recursive: true })
  const existing = await readdir(root).catch(() => [])
  const files = existing.filter(name => /\.md$/iu.test(name))
  if (files.length === 0) {
    await writeFile(join(root, 'threejs-scene.md'), SKILL_SEED, { mode: 0o600 })
    files.push('threejs-scene.md')
  }
  const skills = []
  for (const file of files) {
    try {
      const text = await readFile(join(root, file), 'utf8')
      const parsed = parseSkill(text, file)
      skills.push(parsed)
    } catch (error) { void error }
  }
  const list = skills.map(skill => `- ${skill.name}${skill.description === '' ? '' : `: ${skill.description}`}`)
    .join('\n')
  const removePrompt = promptSection(options.promptSections, 'studio:skills', 3000,
    `Studio skills are available. Call read_skill(name) before using one.\n${list}`)
  const removeTool = toolRegistration(options.tools, {
    name: 'read_skill',
    description: 'Read one Studio skill by name. Skills contain reusable, task-specific guidance.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string', description: 'Skill name from the available list.' } },
      required: ['name'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { name: { type: 'string' }, text: { type: 'string' } },
        required: ['name', 'text'],
      },
      render: (_args, value) => textOutput(value.text),
    },
    async execute(args) {
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      const skill = skills.find(item => item.name === name)
      if (skill === undefined) throw new Error(`Unknown skill: ${name}`)
      return { name: skill.name, text: skill.body }
    },
  })
  return () => { removePrompt(); removeTool() }
}

async function activatePlanning(options) {
  const removePrompt = promptSection(options.promptSections, 'studio:planning', 3050,
    'For multi-step or destructive work, call write_plan first with a short goal and concrete steps. '
    + 'Keep the plan small, then execute it. Do not use write_plan for a one-line answer.')
  const removeTool = toolRegistration(options.tools, {
    name: 'write_plan',
    description: 'Write a short plan the user can inspect before multi-step scene work.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: { type: 'string', description: 'One-sentence goal.' },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              title: { type: 'string' },
              detail: { type: 'string' },
            },
            required: ['title'],
          },
        },
      },
      required: ['goal', 'steps'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          goal: { type: 'string' },
          steps: { type: 'array', items: { type: 'object' } },
        },
        required: ['goal', 'steps'],
      },
      render: (_args, value) => textOutput(
        `Plan: ${value.goal}\n${value.steps.map((step, index) => `${index + 1}. ${step.title}${step.detail ? ` — ${step.detail}` : ''}`).join('\n')}`,
      ),
      presentationMeta: (_args, value) => ({ plan: value }),
    },
    async execute(args) {
      const goal = typeof args.goal === 'string' ? args.goal.trim().slice(0, 400) : ''
      const steps = Array.isArray(args.steps) ? args.steps : []
      if (goal === '' || steps.length === 0) throw new Error('write_plan needs a goal and at least one step.')
      return {
        goal,
        steps: steps.slice(0, 12).map(step => ({
          title: typeof step.title === 'string' ? step.title.trim().slice(0, 200) : '',
          ...(typeof step.detail === 'string' && step.detail.trim() !== ''
            ? { detail: step.detail.trim().slice(0, 800) } : {}),
        })),
      }
    },
  })
  return () => { removePrompt(); removeTool() }
}

async function activateTodo(options) {
  const removePrompt = promptSection(options.promptSections, 'studio:todo', 3070,
    'For multi-step work, keep a short todo list with todo_write and update it as you finish steps. '
    + 'Replace the whole list on every call.')
  const removeTool = toolRegistration(options.tools, {
    name: 'todo_write',
    description: 'Replace the short task checklist for the current work.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        todos: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { todos: { type: 'array', items: { type: 'object' } } },
        required: ['todos'],
      },
      render: (_args, value) => textOutput(value.todos.map(todo =>
        `${todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '▶' : '·'} ${todo.content}`).join('\n')),
    },
    async execute(args) {
      const todos = Array.isArray(args.todos) ? args.todos.slice(0, 20) : []
      return {
        todos: todos.map(todo => ({
          content: typeof todo.content === 'string' ? todo.content.trim().slice(0, 300) : '',
          status: ['pending', 'in_progress', 'completed'].includes(todo.status) ? todo.status : 'pending',
        })).filter(todo => todo.content !== ''),
      }
    },
  })
  return () => { removePrompt(); removeTool() }
}

async function activateSubagents(options) {
  const removePrompt = promptSection(options.promptSections, 'studio:subagents', 3100,
    'Use spawn_subagent for independent research, reviews or option comparisons. '
    + 'Give it a self-contained task and do not ask it to edit the scene.')
  const removeTool = toolRegistration(options.tools, {
    name: 'spawn_subagent',
    description: 'Run one independent research or review subagent and return its text result.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: { type: 'string', description: 'Self-contained task for the subagent.' },
        focus: { type: 'string', description: 'Optional focus or constraints.' },
      },
      required: ['task'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => textOutput(value.text),
    },
    async execute(args, exec) {
      const task = typeof args.task === 'string' ? args.task.trim().slice(0, 4000) : ''
      if (task === '') throw new Error('spawn_subagent needs a task.')
      const focus = typeof args.focus === 'string' ? args.focus.trim().slice(0, 1000) : ''
      const selection = typeof options.selectionOf === 'function'
        ? options.selectionOf(exec?.agent?.session?.id) : null
      const text = await options.runSubagent({
        prompt: focus === '' ? task : `${task}\n\nFocus: ${focus}`,
        selection,
        settings: options.modelSettings,
        signal: AbortSignal.timeout(90000),
        system: 'You are a focused research subagent for Three Studio, a 3D workbench. '
          + 'Answer only the assigned task, cite concrete facts, and keep the response under 800 words.',
      })
      return { text: text.trim() }
    },
  })
  return () => { removePrompt(); removeTool() }
}

const PRIVATE_HOST = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|::1$|\[::1\]$|.*\.local$)/iu
const privateAddress = hostname => PRIVATE_HOST.test(hostname)
  || /^172\.(1[6-9]|2[0-9]|3[01])\./u.test(hostname)

const privateIp = address => {
  const version = isIP(address)
  if (version === 4) {
    const parts = address.split('.').map(Number)
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127
      || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19))
      || parts[0] >= 224
  }
  if (version === 6) {
    const normalized = address.toLowerCase()
    return normalized === '::1' || normalized === '::'
      || normalized.startsWith('fe80:') || normalized.startsWith('fc')
      || normalized.startsWith('fd') || normalized.startsWith('ff')
      || normalized.startsWith('::ffff:127.')
      || normalized.startsWith('::ffff:10.')
      || normalized.startsWith('::ffff:192.168.')
  }
  return true
}

const assertPublicUrl = async target => {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('web_fetch only supports http(s) URLs.')
  }
  if (privateAddress(target.hostname)) throw new Error('web_fetch refuses private or local addresses.')
  const literal = target.hostname.replace(/^\[|\]$/gu, '')
  if (isIP(literal) !== 0) {
    if (privateIp(literal)) throw new Error('web_fetch refuses private or local addresses.')
    return
  }
  const addresses = await lookup(target.hostname, { all: true })
  if (addresses.length === 0 || addresses.some(entry => privateIp(entry.address))) {
    throw new Error('web_fetch refuses private or local addresses.')
  }
}

const safeFetch = async initial => {
  let target = initial
  for (let redirect = 0; redirect < 5; redirect += 1) {
    await assertPublicUrl(target)
    const response = await fetch(target.href, {
      redirect: 'manual',
      headers: { 'user-agent': 'ThreeStudio/0.1 (+local workbench)' },
      signal: AbortSignal.timeout(15000),
    })
    if (response.status < 300 || response.status >= 400) return response
    const location = response.headers.get('location')
    if (location === null) return response
    target = new URL(location, target.href)
  }
  throw new Error('web_fetch followed too many redirects.')
}

const decodeEntities = text => text
  .replace(/&nbsp;/giu, ' ')
  .replace(/&amp;/giu, '&')
  .replace(/&lt;/giu, '<')
  .replace(/&gt;/giu, '>')
  .replace(/&quot;/giu, '"')
  .replace(/&#39;/giu, "'")

const readableText = html => decodeEntities(html
  .replace(/<script[\s\S]*?<\/script>/giu, ' ')
  .replace(/<style[\s\S]*?<\/style>/giu, ' ')
  .replace(/<nav[\s\S]*?<\/nav>/giu, ' ')
  .replace(/<footer[\s\S]*?<\/footer>/giu, ' ')
  .replace(/<[^>]+>/gu, '\n')
  .replace(/[ \t]+/gu, ' ')
  .replace(/\n{3,}/gu, '\n\n')
  .trim())

async function activateWebFetch(options) {
  const removePrompt = promptSection(options.promptSections, 'studio:web-fetch', 3120,
    'Use web_fetch to read a specific public page when the user provides a URL or asks for reference material. '
    + 'Do not fetch private or local addresses.')
  const removeTool = toolRegistration(options.tools, {
    name: 'web_fetch',
    description: 'Fetch one public web page and return readable text.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Public http(s) URL.' },
        maxChars: { type: 'integer', minimum: 500, maximum: 30000 },
      },
      required: ['url'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['url', 'text'],
      },
      render: (_args, value) => textOutput(`${value.title === '' ? value.url : value.title}\n\n${value.text}`),
    },
    async execute(args) {
      let target
      try { target = new URL(String(args.url)) } catch (error) {
        throw new Error('web_fetch needs a valid URL.')
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error('web_fetch only supports http(s) URLs.')
      }
      const response = await safeFetch(target)
      if (!response.ok) throw new Error(`web_fetch received HTTP ${response.status}.`)
      const type = response.headers.get('content-type') || ''
      if (!/text|json|xml/iu.test(type)) throw new Error(`web_fetch cannot read ${type || 'this content type'}.`)
      const raw = (await response.text()).slice(0, 1024 * 1024)
      const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(raw)
      const title = titleMatch === null ? '' : decodeEntities(titleMatch[1]).replace(/\s+/gu, ' ').trim().slice(0, 200)
      const text = (type.includes('html') ? readableText(raw) : raw.trim())
        .slice(0, Math.min(30000, Math.max(500, Number(args.maxChars) || 12000)))
      return { url: response.url || target.href, title, text }
    },
  })
  return () => { removePrompt(); removeTool() }
}

// --- project memory ---------------------------------------------------------

const MEMORY_LIMITS = Object.freeze({
  entries: 200,
  keyLength: 64,
  valueLength: 2000,
  sectionChars: 4000,
})

const memoryLines = entries => {
  const rows = Object.entries(entries)
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
  const lines = []
  let used = 0
  for (const [key, entry] of rows) {
    const line = `- ${key}: ${entry.value}`
    if (used + line.length > MEMORY_LIMITS.sectionChars || lines.length >= 60) break
    lines.push(line)
    used += line.length
  }
  return lines.join('\n')
}

async function activateMemory(options) {
  const path = join(options.dataDir, 'memory.json')
  let store = { v: 1, entries: {} }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.v === 1
      && parsed.entries !== null && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries)) {
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (typeof key !== 'string' || key === '' || key.length > MEMORY_LIMITS.keyLength) continue
        if (entry === null || typeof entry !== 'object' || typeof entry.value !== 'string') continue
        store.entries[key] = { value: entry.value.slice(0, MEMORY_LIMITS.valueLength), updatedAt: Number(entry.updatedAt) || 0 }
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') void error
  }
  const section = { name: 'studio:memory', order: 3020, text: '' }
  options.promptSections.push(section)
  const refresh = () => {
    const lines = memoryLines(store.entries)
    section.text = 'Long-term project memory shared across sessions (memory plugin).\n'
      + (lines === '' ? 'No entries yet. Remember durable conventions with memory_write.'
        : `Entries (newest first):\n${lines}`)
  }
  refresh()
  const persist = async () => {
    const temp = `${path}.${Date.now()}.tmp`
    await writeFile(temp, JSON.stringify(store), { mode: 0o600 })
    await rename(temp, path)
  }
  const removePrompt = () => {
    const index = options.promptSections.indexOf(section)
    if (index >= 0) options.promptSections.splice(index, 1)
  }
  const removeWrite = toolRegistration(options.tools, {
    name: 'memory_write',
    description: 'Persist one project convention or preference for future sessions (shared per Studio home).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', description: 'Stable identifier, e.g. "material.palette" or "scene-conventions".' },
        value: { type: 'string', description: 'What to remember about this key.' },
      },
      required: ['key', 'value'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { key: { type: 'string' }, value: { type: 'string' }, total: { type: 'integer' } },
        required: ['key', 'value', 'total'],
      },
      render: (_args, value) => textOutput(`Remembered ${value.key}: ${value.value} (${value.total} entries total)`),
    },
    async execute(args) {
      const key = typeof args.key === 'string' ? args.key.trim().toLowerCase().slice(0, MEMORY_LIMITS.keyLength) : ''
      if (!/^[a-z0-9][a-z0-9 _:-]*$/u.test(key)) {
        throw new Error('memory_write needs a key of letters, digits, space, "_", ":" or "-" starting with a letter or digit.')
      }
      const value = typeof args.value === 'string' ? args.value.trim().slice(0, MEMORY_LIMITS.valueLength) : ''
      if (value === '') throw new Error('memory_write needs a non-empty value.')
      store.entries[key] = { value, updatedAt: Date.now() }
      const keys = Object.entries(store.entries).sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0))
      while (keys.length > MEMORY_LIMITS.entries) {
        delete store.entries[keys.shift()[0]]
      }
      await persist()
      refresh()
      return { key, value, total: Object.keys(store.entries).length }
    },
  })
  const removeForget = toolRegistration(options.tools, {
    name: 'memory_forget',
    description: 'Remove one project memory entry by key.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { key: { type: 'string' }, forgotten: { type: 'boolean' }, total: { type: 'integer' } },
        required: ['key', 'forgotten', 'total'],
      },
      render: (_args, value) => textOutput(value.forgotten
        ? `Forgot ${value.key} (${value.total} entries remain)`
        : `No memory entry named ${value.key}`),
    },
    async execute(args) {
      const key = typeof args.key === 'string' ? args.key.trim().toLowerCase() : ''
      const forgotten = delete store.entries[key]
      if (forgotten) {
        await persist()
        refresh()
      }
      return { key, forgotten, total: Object.keys(store.entries).length }
    },
  })
  return () => { removePrompt(); removeWrite(); removeForget() }
}

// --- project context files --------------------------------------------------

const CONTEXT_LIMITS = Object.freeze({
  agentsChars: 6000,
  readBytes: 128 * 1024,
  listEntries: 100,
})
const CONTEXT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]*$/u

async function activateContextFiles(options) {
  const root = join(options.dataDir, 'context')
  await mkdir(root, { recursive: true })
  const section = { name: 'studio:context', order: 3010, text: '' }
  options.promptSections.push(section)
  const refresh = async () => {
    let agents = ''
    try {
      agents = (await readFile(join(root, 'AGENTS.md'), 'utf8')).slice(0, CONTEXT_LIMITS.agentsChars)
    } catch (error) { void error }
    const files = (await readdir(root).catch(() => [])).filter(name => CONTEXT_NAME.test(name) && name !== 'AGENTS.md')
    section.text = 'Project context (context plugin). User-provided files live in the context directory.\n'
      + (files.length === 0 ? '' : `Files: ${files.slice(0, 20).join(', ')}\n`)
      + 'Read them with read_context_file(name); list_context_files() refreshes this list.\n'
      + (agents === '' ? 'No AGENTS.md yet.'
        : `AGENTS.md conventions:\n${agents.trim()}`)
  }
  await refresh()
  const removePrompt = () => {
    const index = options.promptSections.indexOf(section)
    if (index >= 0) options.promptSections.splice(index, 1)
  }
  const removeList = toolRegistration(options.tools, {
    name: 'list_context_files',
    description: 'List user-provided project context files (names and sizes).',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { files: { type: 'array', items: { type: 'object' } } },
        required: ['files'],
      },
      render: (_args, value) => textOutput(value.files.length === 0
        ? 'No context files.'
        : value.files.map(file => `- ${file.name} (${file.bytes} bytes)`).join('\n')),
    },
    async execute() {
      const names = (await readdir(root).catch(() => [])).filter(name => CONTEXT_NAME.test(name))
      const files = []
      for (const name of names.sort()) {
        try {
          const stat = await statFile(join(root, name))
          if (stat.isFile()) files.push({ name, bytes: stat.size })
        } catch (error) { void error }
        if (files.length >= CONTEXT_LIMITS.listEntries) break
      }
      await refresh()
      return { files }
    },
  })
  const removeRead = toolRegistration(options.tools, {
    name: 'read_context_file',
    description: 'Read one text file from the project context directory.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { name: { type: 'string', description: 'File name from list_context_files.' } },
      required: ['name'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { name: { type: 'string' }, text: { type: 'string' }, truncated: { type: 'boolean' } },
        required: ['name', 'text'],
      },
      render: (_args, value) => textOutput(`${value.name}${value.truncated === true ? ' (truncated)' : ''}\n\n${value.text}`),
    },
    async execute(args) {
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (!CONTEXT_NAME.test(name) || name.includes('..')) {
        throw new Error('read_context_file needs a plain file name from the context directory (no paths).')
      }
      const buffer = await readFile(join(root, name)).catch(() => {
        throw new Error(`Unknown context file: ${name}`)
      })
      if (buffer.includes(0)) throw new Error(`${name} looks binary; only text files are supported.`)
      const text = buffer.toString('utf8')
      const truncated = Buffer.byteLength(text) > CONTEXT_LIMITS.readBytes
      return { name, text: text.slice(0, CONTEXT_LIMITS.readBytes), truncated }
    },
  })
  return () => { removePrompt(); removeList(); removeRead() }
}

// --- action cards -----------------------------------------------------------

async function activateActionCards(options) {
  const removePrompt = promptSection(options.promptSections, 'studio:action-cards', 3130,
    'When concrete next steps exist, end the reply with one propose_actions call offering up to four '
    + 'ready-to-send follow-ups. Each action needs a short label and a complete prompt the user can send as-is.')
  const removeTool = toolRegistration(options.tools, {
    name: 'propose_actions',
    description: 'Offer the user clickable follow-up actions; clicking fills the composer with the prompt.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        actions: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              label: { type: 'string', description: 'Short button label (verb first).' },
              prompt: { type: 'string', description: 'Complete instruction the user can send unchanged.' },
              note: { type: 'string', description: 'Optional one-line explanation.' },
            },
            required: ['label', 'prompt'],
          },
        },
      },
      required: ['actions'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { actions: { type: 'array', items: { type: 'object' } } },
        required: ['actions'],
      },
      render: (_args, value) => textOutput(value.actions.map(action =>
        `• ${action.label}${action.note === undefined ? '' : ` — ${action.note}`}\n  ${action.prompt}`).join('\n')),
      presentationMeta: (_args, value) => ({ actions: value.actions }),
    },
    async execute(args) {
      const raw = Array.isArray(args.actions) ? args.actions.slice(0, 6) : []
      const actions = raw.map(action => {
        const label = typeof action?.label === 'string' ? action.label.trim().slice(0, 80) : ''
        const prompt = typeof action?.prompt === 'string' ? action.prompt.trim().slice(0, 1000) : ''
        if (label === '' || prompt === '') return null
        const note = typeof action?.note === 'string' && action.note.trim() !== ''
          ? { note: action.note.trim().slice(0, 200) } : {}
        return { label, prompt, ...note }
      }).filter(action => action !== null)
      if (actions.length === 0) throw new Error('propose_actions needs at least one action with a label and a prompt.')
      return { actions }
    },
  })
  return () => { removePrompt(); removeTool() }
}

// --- deliverables -----------------------------------------------------------

const DELIVERABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]*\.(txt|md|markdown|json|js|mjs|cjs|glsl|vert|frag|obj|mtl|csv|html?|ya?ml|toml|xml|svg|py|log)$/iu
const DELIVERABLE_LIMITS = Object.freeze({
  textBytes: 256 * 1024,
  cardChars: 8000,
})

async function activateDeliverables(options) {
  const root = join(options.dataDir, 'deliverables')
  await mkdir(root, { recursive: true })
  const removePrompt = promptSection(options.promptSections, 'studio:deliverables', 3140,
    'When you produce a concrete file for the user (script, config, notes, shader), hand it over with '
    + 'save_deliverable instead of only pasting it into chat. Text files only; exports like GLB/PNG '
    + 'are made from the preview pane by the user.')
  const removeTool = toolRegistration(options.tools, {
    name: 'save_deliverable',
    description: 'Save one text deliverable to disk and show it as a card the user can copy.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'File name with a text extension, e.g. "bake-lighting.js".' },
        text: { type: 'string', description: 'Full file content.' },
        note: { type: 'string', description: 'Optional one-line summary shown on the card.' },
      },
      required: ['name', 'text'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string' },
          bytes: { type: 'integer' },
          path: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['name', 'bytes', 'path'],
      },
      render: (_args, value) => textOutput(`Delivered ${value.name} (${value.bytes} bytes) → ${value.path}`),
      presentationMeta: (_args, value) => ({ deliverable: value }),
    },
    async execute(args, exec) {
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (!DELIVERABLE_NAME.test(name) || name.length > 120) {
        throw new Error('save_deliverable needs a plain file name with a text extension (letters, digits, space, "_", "-", ".", "(", ")").')
      }
      const text = typeof args.text === 'string' ? args.text : ''
      if (text.trim() === '') throw new Error('save_deliverable needs non-empty text.')
      if (Buffer.byteLength(text) > DELIVERABLE_LIMITS.textBytes) {
        throw new Error(`save_deliverable is limited to ${String(DELIVERABLE_LIMITS.textBytes)} bytes.`)
      }
      const session = typeof exec?.agent?.session?.id === 'string' && /^[A-Za-z0-9-]+$/u.test(exec.agent.session.id)
        ? exec.agent.session.id : 'shared'
      const dir = join(root, session)
      await mkdir(dir, { recursive: true })
      const target = join(dir, name)
      const temp = `${target}.${Date.now()}.tmp`
      await writeFile(temp, text, { mode: 0o600 })
      await rename(temp, target)
      const bytes = Buffer.byteLength(text)
      const note = typeof args.note === 'string' && args.note.trim() !== ''
        ? args.note.trim().slice(0, 200) : ''
      return {
        name,
        bytes,
        path: `deliverables/${session}/${name}`,
        ...(note === '' ? {} : { note }),
        // The card offers copy/preview for small files only.
        ...(text.length <= DELIVERABLE_LIMITS.cardChars ? { text } : {}),
      }
    },
  })
  return () => { removePrompt(); removeTool() }
}

// --- voice input ------------------------------------------------------------

// Voice input is a client-side capability: the composer shows a dictation
// button when this plugin is installed and the browser exposes
// SpeechRecognition. There is nothing to add to the agent context.
async function activateVoiceInput() {
  return () => {}
}

// --- shared plugin-route and workspace helpers ------------------------------

const routeRegistration = (routes, method, path, handler) => {
  const entry = { method, path, handler }
  routes.push(entry)
  return () => {
    const index = routes.indexOf(entry)
    if (index >= 0) routes.splice(index, 1)
  }
}

const WORKSPACE_TEXT_EXT = /\.(txt|md|markdown|json|js|mjs|cjs|glsl|vert|frag|obj|mtl|csv|html?|css|ya?ml|toml|xml|svg|py|log|usda|fbxascii)$/iu
const WORKSPACE_IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|ico)$/iu
const WORKSPACE_BLOCKED = /(^|\.)credentials\.json$/iu

// Resolve one workspace-relative path under the Studio home. Refuses
// traversal, absolute paths and the credentials store before touching disk.
const resolveWorkspacePath = (dataDir, relative) => {
  if (typeof relative !== 'string' || relative.trim() === '') {
    throw new Error('A workspace path is required.')
  }
  const parts = relative.split('/').flatMap(piece => piece.split('\\')).filter(piece => piece !== '' && piece !== '.')
  if (parts.some(piece => piece === '..')) {
    throw new Error('Workspace paths must stay inside the Studio home directory.')
  }
  if (parts.length === 0) return dataDir
  if (parts.some(piece => WORKSPACE_BLOCKED.test(piece))) {
    throw new Error('Credentials are not part of the workspace.')
  }
  return join(dataDir, ...parts)
}

const workspaceMime = name => {
  if (/\.md$/iu.test(name)) return 'text/markdown'
  if (WORKSPACE_IMAGE_EXT.test(name)) {
    if (/\.png$/iu.test(name)) return 'image/png'
    if (/\.jpe?g$/iu.test(name)) return 'image/jpeg'
    if (/\.webp$/iu.test(name)) return 'image/webp'
    if (/\.gif$/iu.test(name)) return 'image/gif'
    if (/\.bmp$/iu.test(name)) return 'image/bmp'
    return 'image/x-icon'
  }
  if (/\.svg$/iu.test(name)) return 'image/svg+xml'
  if (/\.html?$/iu.test(name)) return 'text/html'
  if (/\.json$/iu.test(name)) return 'application/json'
  if (/\.css$/iu.test(name)) return 'text/css'
  return 'text/plain'
}

// --- file browser (batch B) -------------------------------------------------

const FILE_BROWSER_LIMITS = Object.freeze({ readBytes: 128 * 1024, imageBytes: 2 * 1024 * 1024 })

async function activateFileBrowser(options) {
  const removePrompt = promptSection(options.promptSections, 'studio:file-browser', 3150,
    'Workspace awareness: list_workspace_files(dir) browses the Studio home (context/, deliverables/, skills/, scenes/); '
    + 'read_workspace_file(path) reads bounded text files. Never touch credentials.')
  const listDirectory = async dir => {
    const root = resolveWorkspacePath(options.dataDir, dir === '' ? '.' : dir)
    const names = await readdir(root, { withFileTypes: true }).catch(() => {
      throw new Error(`Unknown workspace directory: ${dir === '' ? '(home)' : dir}`)
    })
    const entries = []
    for (const item of names) {
      if (WORKSPACE_BLOCKED.test(item.name)) continue
      if (item.isDirectory()) entries.push({ name: item.name, kind: 'dir' })
      else if (item.isFile()) {
        const stat = await statFile(join(root, item.name)).catch(() => null)
        entries.push({ name: item.name, kind: 'file', bytes: stat === null ? 0 : stat.size })
      }
      if (entries.length >= 200) break
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
    return { dir, entries }
  }
  const removeList = toolRegistration(options.tools, {
    name: 'list_workspace_files',
    description: 'List files and subdirectories inside one Studio home directory (default: the home root).',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { dir: { type: 'string', description: 'Relative directory such as "deliverables" or "".' } },
      required: [],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { dir: { type: 'string' }, entries: { type: 'array', items: { type: 'object' } } },
        required: ['dir', 'entries'],
      },
      render: (_args, value) => textOutput(value.entries.length === 0
        ? `${value.dir === '' ? '(home)' : value.dir} is empty`
        : `${value.dir === '' ? '(home)' : value.dir}:\n${value.entries.map(entry =>
          `${entry.kind === 'dir' ? 'd' : '-'} ${entry.name}${entry.kind === 'file' ? ` (${entry.bytes} B)` : ''}`).join('\n')}`),
    },
    execute: args => listDirectory(typeof args.dir === 'string' ? args.dir : ''),
  })
  const removeRead = toolRegistration(options.tools, {
    name: 'read_workspace_file',
    description: 'Read one bounded text file from the Studio home.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { path: { type: 'string', description: 'Workspace-relative file path.' } },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { path: { type: 'string' }, text: { type: 'string' }, truncated: { type: 'boolean' } },
        required: ['path', 'text'],
      },
      render: (_args, value) => textOutput(`${value.path}${value.truncated === true ? ' (truncated)' : ''}\n\n${value.text}`),
    },
    async execute(args) {
      const target = resolveWorkspacePath(options.dataDir, typeof args.path === 'string' ? args.path : '')
      const buffer = await readFile(target).catch(() => {
        throw new Error(`Unknown workspace file: ${String(args.path)}`)
      })
      if (buffer.includes(0)) throw new Error(`${String(args.path)} looks binary; only text files can be read.`)
      const text = buffer.toString('utf8')
      const truncated = Buffer.byteLength(text) > FILE_BROWSER_LIMITS.readBytes
      return { path: String(args.path), text: text.slice(0, FILE_BROWSER_LIMITS.readBytes), truncated }
    },
  })
  // UI routes for the Files panel; absent unless this plugin is installed.
  const removeRouteList = Array.isArray(options.pluginRoutes)
    ? routeRegistration(options.pluginRoutes, 'GET', '/api/plugins/file-browser/list', async (request, url) => {
      try {
        return Response.json(await listDirectory(url.searchParams.get('dir') ?? ''))
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : 'Failed.' }, { status: 400 })
      }
    })
    : () => {}
  const removeRouteContent = Array.isArray(options.pluginRoutes)
    ? routeRegistration(options.pluginRoutes, 'GET', '/api/plugins/file-browser/content', async (request, url) => {
      const path = url.searchParams.get('path') ?? ''
      try {
        const target = resolveWorkspacePath(options.dataDir, path)
        const buffer = await readFile(target)
        const name = path.split('/').pop() ?? path
        if (WORKSPACE_IMAGE_EXT.test(name) && buffer.byteLength <= FILE_BROWSER_LIMITS.imageBytes) {
          return Response.json({
            kind: 'image', name, mime: workspaceMime(name),
            dataUrl: `data:${workspaceMime(name)};base64,${buffer.toString('base64')}`,
          })
        }
        if (buffer.includes(0)) {
          return Response.json({ kind: 'unsupported', name, reason: 'binary' })
        }
        const text = buffer.toString('utf8')
        return Response.json({
          kind: 'text', name, mime: workspaceMime(name),
          text: text.slice(0, 256 * 1024), truncated: Buffer.byteLength(text) > 256 * 1024,
        })
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : 'Failed.' }, { status: 400 })
      }
    })
    : () => {}
  return () => {
    removePrompt(); removeList(); removeRead(); removeRouteList(); removeRouteContent()
  }
}

// Document preview is the viewer half of the Files panel; the client shows
// preview affordances when it is installed. Nothing to add to the agent
// context.
async function activateDocumentPreview() {
  return () => {}
}

// --- background jobs (batch C) ----------------------------------------------

const JOB_LIMITS = Object.freeze({ concurrent: 20, textChars: 4000 })

async function activateBackgroundJobs(options) {
  const jobs = new Map()
  let nextJobId = 0
  const removePrompt = promptSection(options.promptSections, 'studio:background-jobs', 3160,
    'Long research or verification can run detached: start_background_job(task) returns immediately; '
    + 'poll check_background_job(id) in later turns instead of blocking the reply.')
  const removeStart = toolRegistration(options.tools, {
    name: 'start_background_job',
    description: 'Start one detached research/verification job and return its id immediately.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        task: { type: 'string', description: 'Self-contained task for the background job.' },
        focus: { type: 'string' },
      },
      required: ['task'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { id: { type: 'integer' }, status: { type: 'string' } },
        required: ['id', 'status'],
      },
      render: (_args, value) => textOutput(`Background job #${String(value.id)} started (${value.status}).`),
    },
    async execute(args, exec) {
      const running = [...jobs.values()].filter(job => job.status === 'running').length
      if (running >= JOB_LIMITS.concurrent) {
        throw new Error(`Too many running jobs (limit ${String(JOB_LIMITS.concurrent)}); check existing ones first.`)
      }
      const task = typeof args.task === 'string' ? args.task.trim().slice(0, 4000) : ''
      if (task === '') throw new Error('start_background_job needs a task.')
      const focus = typeof args.focus === 'string' ? args.focus.trim().slice(0, 1000) : ''
      nextJobId += 1
      const id = nextJobId
      const job = { id, task, status: 'running', startedAt: Date.now(), text: '' }
      jobs.set(id, job)
      const selection = typeof options.selectionOf === 'function'
        ? options.selectionOf(exec?.agent?.session?.id) : null
      void Promise.resolve().then(async () => {
        try {
          const text = await options.runSubagent({
            prompt: focus === '' ? task : `${task}\n\nFocus: ${focus}`,
            selection,
            settings: options.modelSettings,
            signal: AbortSignal.timeout(180000),
            system: 'You are a detached background researcher for Three Studio. '
              + 'Answer only the assigned task with concrete findings, under 1000 words.',
          })
          job.status = 'done'
          job.text = text.trim().slice(0, 8192)
        } catch (error) {
          job.status = 'error'
          job.text = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
        }
      })
      return { id, status: job.status }
    },
  })
  const removeCheck = toolRegistration(options.tools, {
    name: 'check_background_job',
    description: 'Check one background job by id; done jobs return their findings.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { id: { type: 'integer', minimum: 1 } },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { id: { type: 'integer' }, status: { type: 'string' }, text: { type: 'string' } },
        required: ['id', 'status'],
      },
      render: (_args, value) => textOutput(`Job #${String(value.id)} ${value.status}${value.text ? `\n${value.text}` : ''}`),
    },
    async execute(args) {
      const id = Number(args.id)
      const job = jobs.get(id)
      if (job === undefined) throw new Error(`Unknown background job: ${String(id)}`)
      return {
        id,
        status: job.status,
        ...(job.text === '' ? {} : { text: job.text.slice(0, JOB_LIMITS.textChars) }),
      }
    },
  })
  return () => { removePrompt(); removeStart(); removeCheck() }
}

// --- scheduled tasks (batch C) -----------------------------------------------

const SCHEDULE_LIMITS = Object.freeze({ items: 10, minMinutes: 5, maxMinutes: 1440 })

async function activateScheduledTasks(options) {
  const path = join(options.dataDir, 'schedules.json')
  let store = { v: 1, items: [] }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.items)) {
      store.items = parsed.items.filter(item => item !== null && typeof item === 'object'
        && typeof item.id === 'string' && typeof item.prompt === 'string'
        && Number.isFinite(item.everyMinutes)).slice(0, SCHEDULE_LIMITS.items)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') void error
  }
  const persist = async () => {
    const temp = `${path}.${Date.now()}.tmp`
    await writeFile(temp, JSON.stringify(store), { mode: 0o600 })
    await rename(temp, path)
  }
  const removePrompt = promptSection(options.promptSections, 'studio:scheduled-tasks', 3170,
    `Recurring work can be scheduled with schedule_prompt(prompt, everyMinutes) — it fires into this session's chat. `
    + `Ask the user before creating a schedule; show list_schedules output when schedules exist.`)
  const scheduleNext = item => item.lastFired + item.everyMinutes * 60000
  const timer = options.submitPrompt === undefined ? null : setInterval(async () => {
    const now = Date.now()
    let changed = false
    for (const item of [...store.items]) {
      if (scheduleNext(item) > now) continue
      item.lastFired = now
      changed = true
      // Fired prompts target the session that created the schedule only.
      try { await options.submitPrompt(item.sessionId, item.prompt) } catch (error) { void error }
    }
    if (changed) await persist().catch(() => {})
  }, options.scheduleTickMs === undefined ? 30000 : Math.max(50, options.scheduleTickMs))
  if (timer !== null) timer.unref?.()
  const removeSchedule = toolRegistration(options.tools, {
    name: 'schedule_prompt',
    description: 'Schedule a recurring prompt into this session. Ask the user first.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        prompt: { type: 'string' },
        everyMinutes: { type: 'integer', minimum: SCHEDULE_LIMITS.minMinutes, maximum: SCHEDULE_LIMITS.maxMinutes },
      },
      required: ['prompt', 'everyMinutes'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { id: { type: 'string' }, everyMinutes: { type: 'integer' }, total: { type: 'integer' } },
        required: ['id', 'everyMinutes', 'total'],
      },
      render: (_args, value) => textOutput(`Scheduled ${value.id}: every ${String(value.everyMinutes)} min (${value.total} total).`),
    },
    async execute(args, exec) {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim().slice(0, 2000) : ''
      const everyMinutes = Number(args.everyMinutes)
      if (prompt === '') throw new Error('schedule_prompt needs a prompt.')
      if (!Number.isInteger(everyMinutes) || everyMinutes < SCHEDULE_LIMITS.minMinutes || everyMinutes > SCHEDULE_LIMITS.maxMinutes) {
        throw new Error(`everyMinutes must be ${String(SCHEDULE_LIMITS.minMinutes)}–${String(SCHEDULE_LIMITS.maxMinutes)}.`)
      }
      if (store.items.length >= SCHEDULE_LIMITS.items) {
        throw new Error(`Schedule limit reached (${String(SCHEDULE_LIMITS.items)}); cancel one first.`)
      }
      const sessionId = typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : ''
      if (sessionId === '') throw new Error('schedule_prompt needs an active session.')
      const item = {
        id: `sched-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
        sessionId, prompt, everyMinutes,
        createdAt: Date.now(), lastFired: Date.now(),
      }
      store.items.push(item)
      await persist()
      return { id: item.id, everyMinutes, total: store.items.length }
    },
  })
  const removeListSchedules = toolRegistration(options.tools, {
    name: 'list_schedules',
    description: 'List scheduled recurring prompts with their intervals.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { items: { type: 'array', items: { type: 'object' } } },
        required: ['items'],
      },
      render: (_args, value) => textOutput(value.items.length === 0 ? 'No schedules.'
        : value.items.map(item => `- ${item.id}: every ${String(item.everyMinutes)} min — ${item.prompt.slice(0, 120)}`).join('\n')),
    },
    async execute() {
      return { items: store.items.map(item => ({
        id: item.id, everyMinutes: item.everyMinutes, prompt: item.prompt, sessionId: item.sessionId,
      })) }
    },
  })
  const removeCancel = toolRegistration(options.tools, {
    name: 'cancel_schedule',
    description: 'Cancel one scheduled prompt by id.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { id: { type: 'string' }, cancelled: { type: 'boolean' }, total: { type: 'integer' } },
        required: ['id', 'cancelled', 'total'],
      },
      render: (_args, value) => textOutput(value.cancelled
        ? `Cancelled ${value.id} (${value.total} remain)` : `No schedule named ${value.id}`),
    },
    async execute(args) {
      const id = typeof args.id === 'string' ? args.id : ''
      const index = store.items.findIndex(item => item.id === id)
      if (index >= 0) {
        store.items.splice(index, 1)
        await persist()
      }
      return { id, cancelled: index >= 0, total: store.items.length }
    },
  })
  return () => {
    if (timer !== null) clearInterval(timer)
    removePrompt(); removeSchedule(); removeListSchedules(); removeCancel()
  }
}

// --- hooks (batch C) ---------------------------------------------------------

const HOOK_LIMITS = Object.freeze({ notes: 5, noteChars: 200, sectionChars: 1000 })

async function activateHooks(options) {
  // hooks.json is user-authored on purpose: hooks inject context, and the
  // agent must never be able to write its own triggers.
  const path = join(options.dataDir, 'hooks.json')
  let hooks = []
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.hooks)) {
      hooks = parsed.hooks.filter(hook => hook !== null && typeof hook === 'object'
        && hook.event === 'turn-end' && typeof hook.say === 'string')
        .map(hook => ({ event: 'turn-end', say: hook.say.trim().slice(0, HOOK_LIMITS.noteChars) }))
        .slice(0, 20)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') void error
  }
  const notes = []
  const section = { name: 'studio:hooks', order: 3180, text: '' }
  options.promptSections.push(section)
  const refresh = () => {
    section.text = hooks.length === 0
      ? 'Automation hooks are active but none are configured.'
      : `Automation hooks fired since the last turn (user-configured):\n${notes.slice(-HOOK_LIMITS.notes).join('\n')}`
    if (notes.length === 0) {
      section.text = 'Automation hooks are configured. Their notes appear here after the events they watch fire.'
    }
  }
  refresh()
  const unsubscribe = typeof options.subscribe === 'function'
    ? options.subscribe('turn-end', () => {
      for (const hook of hooks) {
        if (notes.length >= HOOK_LIMITS.notes) notes.shift()
        notes.push(hook.say)
      }
      refresh()
    })
    : () => {}
  const removeList = toolRegistration(options.tools, {
    name: 'list_hooks',
    description: 'List the user-configured automation hooks (read-only).',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { hooks: { type: 'array', items: { type: 'object' } } },
        required: ['hooks'],
      },
      render: (_args, value) => textOutput(value.hooks.length === 0
        ? 'No hooks configured in ~/.three-studio/hooks.json.'
        : value.hooks.map(hook => `- on ${hook.event}: ${hook.say}`).join('\n')),
    },
    async execute() {
      return { hooks: hooks.map(hook => ({ event: hook.event, say: hook.say })) }
    },
  })
  return () => {
    unsubscribe()
    const index = options.promptSections.indexOf(section)
    if (index >= 0) options.promptSections.splice(index, 1)
    removeList()
  }
}

// --- web search (batch D) ----------------------------------------------------

const SEARCH_LIMITS = Object.freeze({ count: 8, snippetChars: 400, titleChars: 160 })

const loadSearchConfig = async dataDir => {
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, 'search.json'), 'utf8'))
    if (parsed !== null && typeof parsed === 'object') {
      return {
        provider: typeof parsed.provider === 'string' ? parsed.provider : 'duckduckgo',
        key: typeof parsed.key === 'string' ? parsed.key : '',
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') void error
  }
  return { provider: 'duckduckgo', key: '' }
}

const stripTags = text => decodeEntities(text.replace(/<[^>]+>/gu, ''))

async function searchDuckDuckGo(query, count) {
  const target = new URL('https://html.duckduckgo.com/html/')
  target.searchParams.set('q', query)
  const response = await safeFetch(target)
  if (!response.ok) throw new Error(`DuckDuckGo returned HTTP ${String(response.status)}.`)
  const html = (await response.text()).slice(0, 512 * 1024)
  const results = []
  const pattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/giu
  for (let match = pattern.exec(html); match !== null && results.length < count; match = pattern.exec(html)) {
    let url = decodeEntities(match[1])
    // DuckDuckGo wraps destinations in /l/?uddg=<encoded>.
    const wrapped = /[?&]uddg=([^&]+)/u.exec(url)
    if (wrapped !== null) url = decodeURIComponent(wrapped[1])
    const title = stripTags(match[2]).replace(/\s+/gu, ' ').trim().slice(0, SEARCH_LIMITS.titleChars)
    if (title === '' || !/^https?:\/\//iu.test(url)) continue
    results.push({ title, url, snippet: '' })
  }
  // Snippets follow each result link in their own block.
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/giu)]
    .map(match => stripTags(match[1]).replace(/\s+/gu, ' ').trim().slice(0, SEARCH_LIMITS.snippetChars))
  results.forEach((result, index) => {
    if (snippets[index] !== undefined) result.snippet = snippets[index]
  })
  return results
}

async function searchTavily(query, count, key) {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: count }),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`Tavily returned HTTP ${String(response.status)}.`)
  const data = await response.json()
  return (Array.isArray(data.results) ? data.results : []).slice(0, count).map(item => ({
    title: String(item.title ?? '').slice(0, SEARCH_LIMITS.titleChars),
    url: String(item.url ?? ''),
    snippet: String(item.content ?? '').slice(0, SEARCH_LIMITS.snippetChars),
  })).filter(item => item.url.startsWith('http'))
}

async function searchBrave(query, count, key) {
  const target = new URL('https://api.search.brave.com/res/v1/web/search')
  target.searchParams.set('q', query)
  target.searchParams.set('count', String(count))
  const response = await fetch(target, {
    headers: { accept: 'application/json', 'x-subscription-token': key },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`Brave returned HTTP ${String(response.status)}.`)
  const data = await response.json()
  const rows = Array.isArray(data.web?.results) ? data.web.results : []
  return rows.slice(0, count).map(item => ({
    title: String(item.title ?? '').slice(0, SEARCH_LIMITS.titleChars),
    url: String(item.url ?? ''),
    snippet: String(item.description ?? '').slice(0, SEARCH_LIMITS.snippetChars),
  })).filter(item => item.url.startsWith('http'))
}

async function runSearchQuery(config, query, count) {
  if (config.provider === 'tavily') {
    if (config.key === '') throw new Error('Tavily needs a key in ~/.three-studio/search.json.')
    return searchTavily(query, count, config.key)
  }
  if (config.provider === 'brave') {
    if (config.key === '') throw new Error('Brave needs a key in ~/.three-studio/search.json.')
    return searchBrave(query, count, config.key)
  }
  return searchDuckDuckGo(query, count)
}

async function activateWebSearch(options) {
  const removePrompt = promptSection(options.promptSections, 'studio:web-search', 3190,
    'web_search(query) finds current public pages; follow up with web_fetch on the best URLs.')
  const removeTool = toolRegistration(options.tools, {
    name: 'web_search',
    description: 'Search the public web and return titled links with snippets.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string' },
        count: { type: 'integer', minimum: 1, maximum: SEARCH_LIMITS.count },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { query: { type: 'string' }, results: { type: 'array', items: { type: 'object' } } },
        required: ['query', 'results'],
      },
      render: (_args, value) => textOutput(value.results.length === 0
        ? `No results for: ${value.query}`
        : value.results.map(result => `- ${result.title}\n  ${result.url}${result.snippet === '' ? '' : `\n  ${result.snippet}`}`).join('\n')),
    },
    async execute(args) {
      const query = typeof args.query === 'string' ? args.query.trim().slice(0, 400) : ''
      if (query === '') throw new Error('web_search needs a query.')
      const count = Math.min(SEARCH_LIMITS.count, Math.max(1, Number(args.count) || 5))
      const config = await loadSearchConfig(options.dataDir)
      const results = await runSearchQuery(config, query, count)
      return { query, results }
    },
  })
  return () => { removePrompt(); removeTool() }
}

// --- deep research (batch D) -------------------------------------------------

const RESEARCH_LIMITS = Object.freeze({ queries: 3, pages: 4, pageChars: 4000, summaryChars: 4000 })

async function activateDeepResearch(options) {
  const removePrompt = promptSection(options.promptSections, 'studio:deep-research', 3200,
    'For open questions that need multiple sources, call deep_research(question) once instead of '
    + 'chaining web_search and web_fetch yourself; it fans out, reads pages and synthesizes with sources.')
  const removeTool = toolRegistration(options.tools, {
    name: 'deep_research',
    description: 'Research one question across several public sources and return a sourced synthesis.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        question: { type: 'string' },
        aspects: { type: 'array', maxItems: RESEARCH_LIMITS.queries - 1, items: { type: 'string' } },
      },
      required: ['question'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { question: { type: 'string' }, summary: { type: 'string' }, sources: { type: 'array', items: { type: 'object' } } },
        required: ['question', 'summary', 'sources'],
      },
      render: (_args, value) => textOutput(`${value.summary}\n\nSources:\n${value.sources.map(source => `- ${source.url}`).join('\n')}`),
    },
    async execute(args) {
      const question = typeof args.question === 'string' ? args.question.trim().slice(0, 1000) : ''
      if (question === '') throw new Error('deep_research needs a question.')
      const aspects = (Array.isArray(args.aspects) ? args.aspects : [])
        .filter(aspect => typeof aspect === 'string' && aspect.trim() !== '')
        .map(aspect => aspect.trim().slice(0, 300)).slice(0, RESEARCH_LIMITS.queries - 1)
      const config = await loadSearchConfig(options.dataDir)
      const queries = [question, ...aspects].slice(0, RESEARCH_LIMITS.queries)
      const pages = []
      const seenUrls = new Set()
      for (const query of queries) {
        let results = []
        try { results = await runSearchQuery(config, query, 5) } catch (error) { void error }
        for (const result of results) {
          if (pages.length >= RESEARCH_LIMITS.pages) break
          if (seenUrls.has(result.url)) continue
          seenUrls.add(result.url)
          try {
            const response = await safeFetch(new URL(result.url))
            if (!response.ok) continue
            const type = response.headers.get('content-type') || ''
            if (!/text|json|xml/iu.test(type)) continue
            const raw = (await response.text()).slice(0, 512 * 1024)
            const text = (type.includes('html') ? readableText(raw) : raw.trim())
              .slice(0, RESEARCH_LIMITS.pageChars)
            pages.push({ url: response.url || result.url, title: result.title, snippet: result.snippet, text })
          } catch (error) { void error }
        }
      }
      if (pages.length === 0) throw new Error('deep_research found no readable sources for this question.')
      const material = pages.map(page => `## ${page.title || page.url}\n${page.url}\n${page.text}`).join('\n\n')
      const text = await options.runSubagent({
        prompt: `Research question: ${question}\n\nSource material from the public web:\n\n${material}`,
        settings: options.modelSettings,
        signal: AbortSignal.timeout(120000),
        system: 'You are a research synthesizer for Three Studio. Answer the question using ONLY the '
          + 'provided source material, cite concrete facts per claim, note disagreements, under 800 words.',
      })
      return {
        question,
        summary: text.trim().slice(0, RESEARCH_LIMITS.summaryChars),
        sources: pages.map(page => ({ url: page.url, title: page.title })),
      }
    },
  })
  return () => { removePrompt(); removeTool() }
}

// --- MCP connectors (batch E) -------------------------------------------------

const MCP_LIMITS = Object.freeze({ servers: 8, callTimeoutMs: 30000, initTimeoutMs: 8000 })

class McpStdioClient {
  constructor(server, dataDir) {
    this.server = server
    this.dataDir = dataDir
    this.child = null
    this.buffer = ''
    this.nextId = 0
    this.pending = new Map()
    this.tools = []
  }

  ensureChild() {
    if (this.child !== null && this.child.exitCode === null) return this.ready
    if (this.child !== null) { this.dispose(); }
    this.child = spawn(this.server.command, this.server.args ?? [], {
      cwd: this.dataDir,
      env: { ...process.env, ...(this.server.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.buffer = ''
    this.pending = new Map()
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => this.consume(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', () => {}) // Never echo server stderr: it may carry secrets.
    this.child.on('exit', () => {
      for (const { reject } of this.pending.values()) reject(new Error(`MCP server "${this.server.id}" exited.`))
      this.pending.clear()
    })
    this.ready = this.handshake()
    return this.ready
  }

  consume(chunk) {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line !== '') {
        try {
          const message = JSON.parse(line)
          if (typeof message.id === 'number' || typeof message.id === 'string') {
            const waiter = this.pending.get(message.id)
            if (waiter !== undefined) {
              this.pending.delete(message.id)
              if (message.error !== undefined) waiter.reject(new Error(String(message.error.message ?? 'MCP error')))
              else waiter.resolve(message.result)
            }
          }
        } catch (error) { void error }
      }
      newline = this.buffer.indexOf('\n')
    }
  }

  request(method, params, timeoutMs) {
    this.nextId += 1
    const id = this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP ${method} timed out after ${String(timeoutMs)} ms.`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      // Newline-delimited JSON per the MCP stdio transport.
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  async handshake() {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'three-studio', version: '0.1' },
    }, MCP_LIMITS.initTimeoutMs)
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const list = await this.request('tools/list', {}, MCP_LIMITS.initTimeoutMs)
    this.tools = (Array.isArray(list?.tools) ? list.tools : []).slice(0, 64).map(tool => ({
      name: String(tool.name ?? ''),
      description: String(tool.description ?? '').slice(0, 400),
    })).filter(tool => tool.name !== '')
  }

  call(toolName, arguments_) {
    return this.ensureChild().then(() => this.request('tools/call', {
      name: toolName,
      arguments: arguments_ === undefined || arguments_ === null || typeof arguments_ !== 'object' ? {} : arguments_,
    }, MCP_LIMITS.callTimeoutMs))
  }

  dispose() {
    if (this.child !== null) {
      try { this.child.kill() } catch (error) { void error }
      this.child = null
    }
  }
}

async function activateMcpConnectors(options) {
  // mcp.json is user-authored: the agent gets no tool that writes it, so it
  // can never add connectors on its own.
  let servers = []
  try {
    const parsed = JSON.parse(await readFile(join(options.dataDir, 'mcp.json'), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.servers)) {
      servers = parsed.servers.filter(item => item !== null && typeof item === 'object'
        && typeof item.id === 'string' && /^[a-z0-9][a-z0-9_-]*$/iu.test(item.id)
        && typeof item.command === 'string' && item.command !== ''
        && (item.args === undefined || Array.isArray(item.args)))
        .slice(0, MCP_LIMITS.servers)
        .map(item => ({
          id: item.id,
          command: item.command,
          args: (item.args ?? []).filter(arg => typeof arg === 'string'),
          env: item.env !== null && typeof item.env === 'object' && !Array.isArray(item.env)
            ? Object.fromEntries(Object.entries(item.env).filter(([, value]) => typeof value === 'string')) : {},
        }))
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') void error
  }
  if (servers.length === 0) {
    throw new Error('MCP connectors need ~/.three-studio/mcp.json with a "servers" list '
      + '({ id, command, args?, env? }). Create it by hand, then install again.')
  }
  const clients = new Map(servers.map(server => [server.id, new McpStdioClient(server, options.dataDir)]))
  const removePrompt = promptSection(options.promptSections, 'studio:mcp', 3210,
    `MCP servers configured: ${servers.map(server => server.id).join(', ')}. `
    + 'mcp_list_tools() shows their tools; mcp_call_tool(server, tool, arguments) invokes one. '
    + 'Connector config is user-owned and read-only.')
  const removeList = toolRegistration(options.tools, {
    name: 'mcp_list_tools',
    description: 'List the tools exposed by the configured MCP servers.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { servers: { type: 'array', items: { type: 'object' } } },
        required: ['servers'],
      },
      render: (_args, value) => textOutput(value.servers.map(server =>
        `${server.id}:\n${server.tools.length === 0 ? '  (no tools)' : server.tools.map(tool => `  - ${tool.name}: ${tool.description}`).join('\n')}`).join('\n')),
    },
    async execute() {
      const rows = []
      for (const [id, client] of clients) {
        try {
          await client.ensureChild()
          rows.push({ id, tools: client.tools })
        } catch (error) {
          rows.push({ id, tools: [], error: error instanceof Error ? error.message.slice(0, 200) : 'unavailable' })
        }
      }
      return { servers: rows }
    },
  })
  const removeCall = toolRegistration(options.tools, {
    name: 'mcp_call_tool',
    description: 'Invoke one tool on a configured MCP server.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        server: { type: 'string' },
        tool: { type: 'string' },
        arguments: { type: 'object' },
      },
      required: ['server', 'tool'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { server: { type: 'string' }, tool: { type: 'string' }, content: { type: 'string' } },
        required: ['server', 'tool', 'content'],
      },
      render: (_args, value) => textOutput(`MCP ${value.server}.${value.tool}:\n${value.content}`),
    },
    async execute(args) {
      const serverId = typeof args.server === 'string' ? args.server : ''
      const client = clients.get(serverId)
      if (client === undefined) throw new Error(`Unknown MCP server: ${serverId}`)
      const tool = typeof args.tool === 'string' ? args.tool : ''
      const result = await client.call(tool, args.arguments)
      const content = (Array.isArray(result?.content) ? result.content : [])
        .map(part => typeof part?.text === 'string' ? part.text : JSON.stringify(part ?? null))
        .join('\n').slice(0, 8000)
      return { server: serverId, tool, content: content === '' ? '(empty result)' : content }
    },
  })
  return () => {
    for (const client of clients.values()) client.dispose()
    removePrompt(); removeList(); removeCall()
  }
}

// --- browser automation (batch E) ---------------------------------------------

const BROWSER_AUTOMATION_DEFAULT = Object.freeze({ cdp: '127.0.0.1:9222' })

class CdpClient {
  constructor(cdpUrl) {
    this.cdpUrl = cdpUrl
    this.socket = null
    this.nextId = 0
    this.pending = new Map()
    this.events = new Map()
  }

  async connect() {
    if (this.socket !== null && this.socket.readyState === 1) return
    const version = await fetch(`http://${this.cdpUrl}/json/version`, { signal: AbortSignal.timeout(4000) })
      .then(response => response.json())
    const wsUrl = typeof version.webSocketDebuggerUrl === 'string' ? version.webSocketDebuggerUrl : null
    if (wsUrl === null) throw new Error('The CDP endpoint exposes no browser WebSocket.')
    if (this.socket !== null) { try { this.socket.close() } catch (error) { void error } }
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl)
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('Could not open the CDP WebSocket.')), { once: true })
      this.socket = socket
      socket.addEventListener('message', event => {
        let message = null
        try { message = JSON.parse(String(event.data)) } catch (error) { void error }
        if (message === null) return
        if (typeof message.id === 'number' && this.pending.has(message.id)) {
          const waiter = this.pending.get(message.id)
          this.pending.delete(message.id)
          if (message.error !== undefined) waiter.reject(new Error(String(message.error.message ?? 'CDP error')))
          else waiter.resolve(message.result)
          return
        }
        if (typeof message.method === 'string') {
          const listeners = this.events.get(message.method)
          if (listeners !== undefined) for (const listener of [...listeners]) listener(message.params ?? {})
        }
      })
    })
  }

  send(method, params = {}, timeoutMs = 15000) {
    this.nextId += 1
    const id = this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out.`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  waitFor(event, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const listeners = this.events.get(event) ?? []
      this.events.set(event, listeners)
      const listener = params => {
        clearTimeout(timer)
        listeners.splice(listeners.indexOf(listener), 1)
        resolve(params)
      }
      const timer = setTimeout(() => {
        listeners.splice(listeners.indexOf(listener), 1)
        resolve({}) // Load events are best-effort; never hang the tool call.
      }, timeoutMs)
      listeners.push(listener)
    })
  }

  dispose() {
    if (this.socket !== null) {
      try { this.socket.close() } catch (error) { void error }
      this.socket = null
    }
  }
}

async function activateBrowserAutomation(options) {
  // User-authored opt-in: create browser-automation.json after starting a
  // local Chrome with --remote-debugging-port. The agent cannot enable this.
  let config = null
  try {
    const parsed = JSON.parse(await readFile(join(options.dataDir, 'browser-automation.json'), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.cdp === 'string' && parsed.cdp !== '') {
      config = { cdp: parsed.cdp.replace(/^https?:\/\//iu, '') }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') void error
  }
  if (config === null) {
    throw new Error('Browser automation is opt-in: start Chrome with --remote-debugging-port=9222 and create '
      + '~/.three-studio/browser-automation.json ({ "cdp": "127.0.0.1:9222" }), then install again.')
  }
  const client = new CdpClient(config.cdp)
  const removePrompt = promptSection(options.promptSections, 'studio:browser-automation', 3220,
    'browser_navigate, browser_screenshot and browser_evaluate drive the user\'s local Chrome over CDP. '
    + 'Public http(s) targets only; the user opted in by configuring the endpoint.')
  const assertCdpTarget = async target => {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error('Browser automation only opens http(s) URLs.')
    }
    if (privateAddress(target.hostname)) {
      throw new Error('Browser automation refuses private or local addresses.')
    }
    if (isIP(target.hostname.replace(/^\[|\]$/gu, '')) === 0) {
      const addresses = await lookup(target.hostname, { all: true }).catch(() => [])
      if (addresses.some(entry => privateIp(entry.address))) {
        throw new Error('Browser automation refuses private or local addresses.')
      }
    } else if (privateIp(target.hostname.replace(/^\[|\]$/gu, ''))) {
      throw new Error('Browser automation refuses private or local addresses.')
    }
    await client.connect()
  }
  const removeNavigate = toolRegistration(options.tools, {
    name: 'browser_navigate',
    description: 'Open one public URL in the automated browser tab.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { url: { type: 'string' }, title: { type: 'string' } },
        required: ['url', 'title'],
      },
      render: (_args, value) => textOutput(`Opened ${value.url}${value.title === '' ? '' : ` — ${value.title}`}`),
    },
    async execute(args) {
      const target = new URL(String(args.url))
      await assertCdpTarget(target)
      const loaded = client.waitFor('Page.loadEventFired')
      await client.send('Page.enable')
      await client.send('Page.navigate', { url: target.href })
      await loaded
      const evaluated = await client.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
      return { url: target.href, title: String(evaluated?.result?.value ?? '').slice(0, 200) }
    },
  })
  const removeScreenshot = toolRegistration(options.tools, {
    name: 'browser_screenshot',
    description: 'Capture the automated tab as PNG and store it in the workspace.',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { path: { type: 'string' }, bytes: { type: 'integer' } },
        required: ['path', 'bytes'],
      },
      render: (_args, value) => textOutput(`Screenshot saved to ${value.path} (${String(value.bytes)} B).`),
    },
    async execute() {
      await client.connect()
      const capture = await client.send('Page.captureScreenshot', { format: 'png' })
      const buffer = Buffer.from(String(capture.data), 'base64')
      const dir = join(options.dataDir, 'browser-captures')
      await mkdir(dir, { recursive: true })
      const name = `capture-${Date.now()}.png`
      await writeFile(join(dir, name), buffer, { mode: 0o600 })
      return { path: `browser-captures/${name}`, bytes: buffer.byteLength }
    },
  })
  const removeEvaluate = toolRegistration(options.tools, {
    name: 'browser_evaluate',
    description: 'Evaluate one JavaScript expression in the automated tab and return its JSON value.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      render: (_args, value) => textOutput(value.value),
    },
    async execute(args) {
      const expression = typeof args.expression === 'string' ? args.expression.slice(0, 8000) : ''
      if (expression.trim() === '') throw new Error('browser_evaluate needs an expression.')
      await client.connect()
      const evaluated = await client.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      }, 20000)
      if (evaluated?.exceptionDetails !== undefined) {
        throw new Error(`Evaluation failed: ${String(evaluated.exceptionDetails.exception?.description ?? 'error').slice(0, 400)}`)
      }
      const value = evaluated?.result?.value
      return { value: JSON.stringify(value ?? null).slice(0, 8000) }
    },
  })
  return () => {
    client.dispose()
    removePrompt(); removeNavigate(); removeScreenshot(); removeEvaluate()
  }
}

// Browser pane is a client-side capability: a user-driven sandboxed web panel.
// The server adds nothing to the agent context.
async function activateBrowserPane() {
  return () => {}
}

const IMPLEMENTATIONS = {
  skills: activateSkills,
  planning: activatePlanning,
  todo: activateTodo,
  subagents: activateSubagents,
  'web-fetch': activateWebFetch,
  memory: activateMemory,
  'context-files': activateContextFiles,
  'action-cards': activateActionCards,
  deliverables: activateDeliverables,
  'voice-input': activateVoiceInput,
  'file-browser': activateFileBrowser,
  'document-preview': activateDocumentPreview,
  'background-jobs': activateBackgroundJobs,
  'scheduled-tasks': activateScheduledTasks,
  hooks: activateHooks,
  'web-search': activateWebSearch,
  'deep-research': activateDeepResearch,
  'mcp-connectors': activateMcpConnectors,
  'browser-automation': activateBrowserAutomation,
  'browser-pane': activateBrowserPane,
}

export async function createPluginRuntime(options) {
  const installedPath = join(options.dataDir, 'plugins.json')
  const active = new Map()
  let installed = []
  try {
    const parsed = JSON.parse(await readFile(installedPath, 'utf8'))
    if (Array.isArray(parsed.installed)) installed = parsed.installed.filter(id => typeof id === 'string')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const persist = async () => {
    await writeFile(installedPath, JSON.stringify({ installed: [...active.keys()] }, null, 2), { mode: 0o600 })
  }
  const install = async id => {
    if (active.has(id)) return { ok: true, installed: [...active.keys()] }
    const activator = IMPLEMENTATIONS[id]
    if (activator === undefined) return { ok: false, message: 'This plugin is not available yet.' }
    try {
      const dispose = await activator(options)
      active.set(id, dispose)
      await persist()
      return { ok: true, installed: [...active.keys()] }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }
  const uninstall = async id => {
    const dispose = active.get(id)
    if (dispose !== undefined) {
      try { dispose() } catch (error) { void error }
      active.delete(id)
      await persist()
    }
    return { ok: true, installed: [...active.keys()] }
  }
  for (const id of installed) {
    if (IMPLEMENTATIONS[id] === undefined) continue
    try {
      const dispose = await IMPLEMENTATIONS[id](options)
      active.set(id, dispose)
    } catch (error) { void error }
  }
  return {
    install,
    uninstall,
    catalog: () => CATALOG.map(entry => Object.assign({}, entry, { installed: active.has(entry.id) })),
    installed: () => [...active.keys()],
  }
}
