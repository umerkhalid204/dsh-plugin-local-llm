/**
 * Dev-only fake inference servers, one dialect per local engine, used by
 * `node test/dry-run.mjs`. It exists so the catalog parsing in index.js can be
 * exercised without installing LM Studio, Ollama, Strata, Lemonade or llama.cpp.
 *
 *   PORT=1234  ENGINE=lmstudio node test/fake-openai-server.mjs
 *   PORT=11434 ENGINE=ollama   node test/fake-openai-server.mjs
 *   PORT=8080  ENGINE=strata   node test/fake-openai-server.mjs
 *   PORT=13305 ENGINE=lemonade node test/fake-openai-server.mjs
 *   PORT=8081  ENGINE=openai   node test/fake-openai-server.mjs
 *
 * Chat behaviour the dry run depends on: a prompt containing `TOOLTEST` streams
 * a split tool call, `HALFTOKEN` stops with finish_reason `length`, and anything
 * else streams `pong`. Every request prints a one-line summary of the payload it
 * received, which is what proves the wire conversion actually happened.
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8080)
const ENGINE = process.env.ENGINE ?? 'openai'

const send = (res, status, body) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function catalog(res) {
  if (ENGINE === 'lemonade') {
    // Lemonade keys its registry by label: only `chat` deployments can be a
    // brain, and context sizes arrive as `max_context_window`.
    const data = [
      { id: 'Qwen3-0.6B-GGUF', labels: ['llamacpp', 'chat', 'tool-calling'], max_context_window: 40960, downloaded: true, size: 529157632, supports: { stream: true } },
      { id: 'LMX-Omni-52B-Halo', labels: ['llamacpp', 'chat', 'vision', 'tool-calling', 'tts'], max_context_window: 262144, downloaded: true, size: 16000000000, supports: { stream: true } },
      { id: 'EmbeddingGemma-300M', labels: ['llamacpp', 'embeddings'], max_context_window: 2048, downloaded: true, size: 300000000 },
      { id: 'not-chat-deployed', labels: ['llamacpp', 'transcription'], max_context_window: 8192, downloaded: true, size: 1000000 },
    ]
    return send(res, 200, { data })
  }
  if (ENGINE === 'strata') {
    // Strata's model listing is not a documented contract: answer the OpenAI
    // shape with bare ids so the declared-catalog fallback in the plugin is what
    // supplies names and context windows.
    return send(res, 200, { object: 'list', data: [{ id: 'iq3_s' }, { id: 'q2_0' }] })
  }
  if (ENGINE === 'lmstudio') {
    const data = [
      { id: 'fake-coder-7b', display_name: 'Fake Coder 7B', type: 'model', state: 'loaded', quantization: 'Q4_K_M', max_context_length: 32768, architecture: { modality: 'text' } },
      { id: 'fake-vision-11b', display_name: 'Fake Vision 11B', type: 'model', state: 'not-loaded', quantization: 'Q8_0', max_context_length: 16384, architecture: { modality: 'mmproj' } },
      { id: 'fake-embedder', display_name: 'Fake Embedder', type: 'embeddings', state: 'loaded', max_context_length: 8192 },
    ]
    return send(res, 200, { data })
  }
  if (ENGINE === 'ollama') {
    const models = [
      { name: 'fake-coder-7b', details: { quantization_level: 'Q4_K_M', context_length: 4096 } },
      { name: 'fake-vision-11b', details: { quantization_level: 'Q8_0', context_length: 4096 } },
    ]
    return send(res, 200, { models })
  }
  // Generic OpenAI-compatible: context windows arrive under a non-default key.
  return send(res, 200, {
    object: 'list',
    data: [
      { id: 'fake-coder-7b', name: 'Fake Coder 7B', max_context_length: 16384 },
      { id: 'fake-vision-11b', name: 'Fake Vision 11B', max_context_length: 16384 },
    ],
    meta: { server_version: 'fake-llama.cpp/1.0' },
  })
}

function ollamaShow(res, name) {
  const info = { 'general.architecture': 'qwen2' }
  info['qwen2.context_length'] = name === 'fake-vision-11b' ? 16384 : 32768
  if (name === 'fake-vision-11b') info['qwen2.mmproj'] = true
  return send(res, 200, { model_info: info, parameters: 'qwen2', license: 'MIT' })
}

const sseEvent = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)

function chatCompletion(res, payload) {
  const prompt = JSON.stringify(payload.messages ?? [])
  const wantsTool = prompt.includes('TOOLTEST') && (payload.tools?.length ?? 0) > 0
  const halfToken = prompt.includes('HALFTOKEN')
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'close',
    'transfer-encoding': 'chunked',
  })

  if (wantsTool) {
    sseEvent(res, { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_fake_1', function: { name: 'get_weather', arguments: '' } }] } }] })
    for (const part of ['{"city"', ':', '"Doha"}']) {
      sseEvent(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: part } }] } }] })
    }
    sseEvent(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 } })
    res.write('data: [DONE]\n\n')
    return res.end()
  }

  const text = halfToken ? 'trunc' : 'pong'
  const pieces = text.split('')
  sseEvent(res, { choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })
  for (const piece of pieces) sseEvent(res, { choices: [{ index: 0, delta: { content: piece } }] })
  sseEvent(res, {
    choices: [{ index: 0, delta: {}, finish_reason: halfToken ? 'length' : 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: pieces.length, total_tokens: 12 + pieces.length },
  })
  res.write('data: [DONE]\n\n')
  res.end()
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = url.pathname

  if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) return catalog(res)
  if (req.method === 'GET' && path === '/api/v0/models') return catalog(res)
  if (req.method === 'GET' && path === '/api/tags') return catalog(res)
  if (req.method === 'GET' && path === '/v1/health') return send(res, 200, { status: 'ok', engine: ENGINE })

  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    let payload = {}
    try {
      payload = raw ? JSON.parse(raw) : {}
    } catch {
      return send(res, 400, { error: { message: 'invalid json' } })
    }
    if (req.method === 'POST' && path === '/api/show') return ollamaShow(res, payload.name ?? '')
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
      const summary = {
        model: payload.model,
        stream: payload.stream,
        roles: (payload.messages ?? []).map((message) => message.role).join('+'),
        tool_names: (payload.tools ?? []).map((tool) => tool.function?.name ?? tool.name).join(','),
        max_tokens: payload.max_tokens,
      }
      console.log(`[${ENGINE}] chat/completions`, JSON.stringify(summary))
      return chatCompletion(res, payload)
    }
    return send(res, 404, { error: { message: `fake ${ENGINE} server has no ${req.method} ${path}` } })
  })
})

server.listen(PORT, '127.0.0.1', () => console.log(`fake ${ENGINE} server on http://127.0.0.1:${PORT}`))
