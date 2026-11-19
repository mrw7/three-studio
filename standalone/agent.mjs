/**
 * Provider adapters and the tool-calling loop for the standalone Studio.
 *
 * Two wire families are supported: OpenAI-compatible chat completions and the
 * Anthropic Messages API. Session history stays provider-neutral so a Session
 * can switch models without losing its transcript.
 */

const SYSTEM_PROMPT = [
  'You are Three Studio, an AI-native 3D workbench.',
  'Create or replace the live scene with the three_scene tool. Use workbench_proposal for changes the user should preview and approve.',
  'Keep replies concise. Never claim a scene changed unless a tool result confirms it.',
].join('\n')

const MAX_TOOL_ROUNDS = 8
const MAX_TOOL_RESULT_CHARS = 12000

const asToolsOpenAI = tools => [...tools.values()].map(tool => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
}))

const asToolsAnthropic = tools => [...tools.values()].map(tool => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.parameters,
}))

const textOf = content => Array.isArray(content)
  ? content.filter(block => block !== null && typeof block === 'object' && block.type === 'text')
      .map(block => block.text).join('')
  : ''

function toOpenAIMessages(system, history) {
  const messages = [{ role: 'system', content: system }]
  for (const message of history) {
    if (message.role === 'user') {
      messages.push({ role: 'user', content: message.text })
    } else if (message.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: message.text === '' ? null : message.text,
        ...(Array.isArray(message.toolCalls) && message.toolCalls.length > 0
          ? { tool_calls: message.toolCalls.map(call => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })) }
          : {}),
      })
    } else if (message.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.resultText,
      })
    }
  }
  return messages
}

function toAnthropicMessages(history) {
  const messages = []
  for (const message of history) {
    if (message.role === 'user') {
      messages.push({ role: 'user', content: [{ type: 'text', text: message.text }] })
    } else if (message.role === 'assistant') {
      const content = []
      if (message.text !== '') content.push({ type: 'text', text: message.text })
      for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args })
      }
      if (content.length > 0) messages.push({ role: 'assistant', content })
    } else if (message.role === 'tool') {
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.resultText,
          ...(message.isError === true ? { is_error: true } : {}),
        }],
      })
    }
  }
  return messages
}

/** Human-readable transport detail from a failed provider fetch. */
const fetchFailure = (provider, endpoint, error) => {
  const cause = error !== null && typeof error === 'object' ? error.cause : undefined
  const detail = cause !== null && typeof cause === 'object'
    && (typeof cause.code === 'string' || typeof cause.message === 'string')
    ? (typeof cause.code === 'string' && cause.code !== '' ? cause.code : cause.message)
    : error instanceof Error && error.message !== '' ? error.message : 'network error'
  return `${provider.name} request failed (${detail}) · ${endpoint}`
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * Local gateways (LiteLLM and similar) intermittently reset the first
 * connection attempt. Retry transport failures briefly; HTTP error statuses
 * are the provider's answer and are never retried.
 */
async function fetchWithRetry(endpoint, init, provider) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(endpoint, init)
    } catch (error) {
      if (init.signal !== undefined && init.signal.aborted) throw error
      lastError = error
      if (attempt < 2) await sleep(250 * (attempt + 1))
    }
  }
  throw new Error(fetchFailure(provider, endpoint, lastError))
}

async function readSSE(response, onEvent) {
  if (response.body === null) throw new Error('Provider returned no body.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const processBlock = async block => {
    const lines = block.split('\n')
    const eventName = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? 'message'
    const data = lines.filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim()).join('\n')
    if (data !== '') await onEvent(eventName, data)
  }
  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    // Providers and local gateways use both LF and CRLF SSE framing.
    buffer = buffer.replace(/\r\n/gu, '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      await processBlock(block)
      boundary = buffer.indexOf('\n\n')
    }
    if (done) break
  }
  // A few gateways omit the final blank line. Do not lose the last delta.
  buffer += decoder.decode()
  buffer = buffer.replace(/\r\n/gu, '\n')
  if (buffer.trim() !== '') await processBlock(buffer)
}

async function streamOpenAI(provider, key, model, system, history, tools, onText, signal, maxTokens = 8192) {
  const endpoint = `${provider.baseURL.replace(/\/+$/u, '')}/chat/completions`
  const response = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: toOpenAIMessages(system, history),
      tools: asToolsOpenAI(tools),
      tool_choice: 'auto',
      max_tokens: maxTokens,
      stream: true,
    }),
    signal,
  }, provider)
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Provider ${response.status}: ${body.slice(0, 500)}`)
  }
  let text = ''
  const calls = new Map()
  await readSSE(response, async (eventName, data) => {
    if (data === '[DONE]') return
    let payload
    try { payload = JSON.parse(data) } catch (error) { return }
    const delta = payload?.choices?.[0]?.delta
    if (delta === undefined || delta === null) return
    if (typeof delta.content === 'string' && delta.content !== '') {
      text += delta.content
      onText(delta.content)
    }
    for (const part of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = Number.isInteger(part.index) ? part.index : 0
      let call = calls.get(index)
      if (call === undefined) {
        call = { id: '', name: '', arguments: '' }
        calls.set(index, call)
      }
      if (typeof part.id === 'string' && part.id !== '') call.id = part.id
      if (typeof part.function?.name === 'string') call.name += part.function.name
      if (typeof part.function?.arguments === 'string') call.arguments += part.function.arguments
    }
  })
  return {
    text,
    toolCalls: [...calls.values()].map(call => {
      let args = {}
      try { args = call.arguments === '' ? {} : JSON.parse(call.arguments) } catch (error) {
        args = { __parseError: String(call.arguments).slice(0, 500) }
      }
      return { id: call.id, name: call.name, args }
    }).filter(call => call.name !== ''),
  }
}

async function streamAnthropic(provider, key, model, system, history, tools, onText, signal, maxTokens = 8192) {
  const endpoint = `${provider.baseURL.replace(/\/+$/u, '')}/messages`
  const response = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: toAnthropicMessages(history),
      tools: asToolsAnthropic(tools),
      stream: true,
    }),
    signal,
  }, provider)
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Provider ${response.status}: ${body.slice(0, 500)}`)
  }
  let text = ''
  const calls = new Map()
  let activeIndex = null
  await readSSE(response, async (eventName, data) => {
    let payload
    try { payload = JSON.parse(data) } catch (error) { return }
    if (payload?.type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
      activeIndex = payload.index
      calls.set(payload.index, { id: payload.content_block.id, name: payload.content_block.name, arguments: '' })
    } else if (payload?.type === 'content_block_delta') {
      if (payload.delta?.type === 'text_delta' && typeof payload.delta.text === 'string') {
        text += payload.delta.text
        onText(payload.delta.text)
      } else if (payload.delta?.type === 'input_json_delta' && activeIndex !== null) {
        const call = calls.get(activeIndex)
        if (call !== undefined && typeof payload.delta.partial_json === 'string') {
          call.arguments += payload.delta.partial_json
        }
      }
    } else if (payload?.type === 'content_block_stop') {
      activeIndex = null
    }
  })
  return {
    text,
    toolCalls: [...calls.values()].map(call => {
      let args = {}
      try { args = call.arguments === '' ? {} : JSON.parse(call.arguments) } catch (error) {
        args = { __parseError: String(call.arguments).slice(0, 500) }
      }
      return { id: call.id, name: call.name, args }
    }).filter(call => call.name !== ''),
  }
}

/**
 * Run one prompt turn and its tool loop.
 * @param options - session state, model settings, tools and event sinks.
 */
export async function runAgent(options) {
  const {
    session, settings, tools, promptSections, emit, emitChunk, signal, selection: override,
  } = options
  const selection = override ?? session.selection ?? {}
  const providerId = typeof selection.provider === 'string' ? selection.provider : ''
  const provider = settings.providerOf(providerId)
  if (provider === undefined) {
    throw new Error(providerId === ''
      ? 'No model provider configured. Add one in Settings.' : `Unknown model provider: ${providerId}`)
  }
  const key = settings.keyOf(providerId)
  if (key === undefined) throw new Error(`Add an API key for ${provider.name} in Settings.`)
  const modelId = typeof selection.model === 'string' && selection.model !== ''
    ? selection.model : provider.models[0]?.id
  if (modelId === undefined) throw new Error(`Provider ${provider.name} has no models.`)
  const system = [SYSTEM_PROMPT, ...promptSections.map(section => section.text)]
    .filter(text => typeof text === 'string' && text !== '')
    .join('\n\n')
  const history = Array.isArray(session.history) ? session.history : []
  const stream = provider.api === 'anthropic-messages' ? streamAnthropic : streamOpenAI
  const completeCanceledCalls = calls => {
    for (const call of calls) {
      history.push({
        role: 'tool', toolCallId: call.id, name: call.name,
        resultText: 'Tool call canceled before execution.', isError: true,
      })
    }
  }
  let round = 0
  while (round < MAX_TOOL_ROUNDS) {
    if (signal?.aborted) return
    round += 1
    const result = await stream(provider, key, modelId, system, history, tools, emitChunk, signal)
    if (signal?.aborted) return
    const text = result.text.trim()
    if (result.toolCalls.length === 0) {
      if (text !== '') {
        history.push({ role: 'assistant', text })
        emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] }, interrupted: false } })
      }
      return
    }
    history.push({ role: 'assistant', text, toolCalls: result.toolCalls })
    if (text !== '') {
      emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] }, interrupted: false } })
    }
    for (let index = 0; index < result.toolCalls.length; index += 1) {
      if (signal?.aborted) {
        completeCanceledCalls(result.toolCalls.slice(index))
        return
      }
      const call = result.toolCalls[index]
      const tool = tools.get(call.name)
      emit({ type: 'tool/call', data: { callId: call.id, name: call.name, args: call.args } })
      if (tool === undefined) {
        const message = `Unknown tool: ${call.name}`
        emit({
          type: 'tool/result',
          data: {
            message: { toolCallId: call.id, isError: true, content: [{ type: 'text', text: message }] },
            meta: null,
            error: { reason: message },
          },
        })
        history.push({
          role: 'tool', toolCallId: call.id, name: call.name,
          resultText: message, isError: true,
        })
        continue
      }
      try {
        if (call.args.__parseError !== undefined) throw new Error('Tool arguments were not valid JSON.')
        const value = await tool.execute(call.args, { agent: { session: { id: session.id } } })
        const meta = typeof tool.output?.presentationMeta === 'function'
          ? tool.output.presentationMeta(call.args, value) : null
        const rendered = typeof tool.output?.render === 'function' ? tool.output.render(call.args, value) : null
        const content = Array.isArray(rendered) && rendered.length > 0
          ? rendered : [{ type: 'text', text: JSON.stringify(value) }]
        const resultText = JSON.stringify(value).slice(0, MAX_TOOL_RESULT_CHARS)
        emit({
          type: 'tool/result',
          data: { message: { toolCallId: call.id, isError: false, content }, meta, error: null },
        })
        history.push({ role: 'tool', toolCallId: call.id, name: call.name, resultText, isError: false })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        emit({
          type: 'tool/result',
          data: {
            message: { toolCallId: call.id, isError: true, content: [{ type: 'text', text: message }] },
            meta: null,
            error: { reason: message },
          },
        })
        history.push({
          role: 'tool', toolCallId: call.id, name: call.name,
          resultText: message, isError: true,
        })
      }
    }
  }
  emit({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'Stopped after too many tool rounds.' }] }, interrupted: true },
  })
}

/**
 * Run a one-shot subagent completion with the same provider credentials.
 * @param options - prompt, model selection, settings and cancellation.
 * @returns the subagent's text.
 */
export async function runSubagent(options) {
  const { prompt, settings, selection, signal, system, maxTokens = 8192 } = options
  const providerId = selection !== null && typeof selection === 'object'
    && typeof selection.provider === 'string' ? selection.provider : ''
  const provider = settings.providerOf(providerId)
  if (provider === undefined) {
    throw new Error(providerId === ''
      ? 'No model provider configured. Add one in Settings.' : `Unknown model provider: ${providerId}`)
  }
  const key = settings.keyOf(providerId)
  if (key === undefined) throw new Error(`Add an API key for ${provider.name} in Settings.`)
  const modelId = selection !== null && typeof selection === 'object'
    && typeof selection.model === 'string' && selection.model !== ''
    ? selection.model : provider.models[0]?.id
  if (modelId === undefined) throw new Error(`Provider ${provider.name} has no models.`)
  const stream = provider.api === 'anthropic-messages' ? streamAnthropic : streamOpenAI
  const result = await stream(
    provider,
    key,
    modelId,
    typeof system === 'string' && system !== '' ? system : SYSTEM_PROMPT,
    [{ role: 'user', text: prompt }],
    new Map(),
    () => {},
    signal,
    maxTokens,
  )
  return result.text
}

export { textOf }
