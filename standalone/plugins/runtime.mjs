/**
 * Native plugin runtime for the standalone Studio.
 *
 * A plugin activates by adding tools and system-prompt sections to the live
 * agent context; uninstalling removes exactly what it added. Installed ids
 * persist in <data-home>/plugins.json.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
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

const IMPLEMENTATIONS = {
  skills: activateSkills,
  planning: activatePlanning,
  todo: activateTodo,
  subagents: activateSubagents,
  'web-fetch': activateWebFetch,
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
