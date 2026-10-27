/**
 * dsh-plugin-local-llm — Host half.
 *
 * What it adds: first-class provider routes for LLMs running on your own
 * machine — LM Studio, Ollama, and any OpenAI-compatible `chat/completions`
 * server (llama.cpp, vLLM, LocalAI, TGI, …) — so a local model can drive the
 * agent loop exactly like a hosted one, and the model appears in the Harness
 * model picker because the adapter implements `listModels`.
 *
 * Design notes, all verified against the installed Harness (0.2.1-rc.3):
 *
 * - `@deepseek-ai/dsh-llm` exposes the abstract `LlmAdapter` base class and
 *   `attributionHeaders()`. Only `stream(options)` is abstract; `listModels`
 *   and `resolveModel` are overridden here because the GUI requires catalog
 *   membership ("adapters intended for GUI use must implement `listModels`").
 * - The harness chunk vocabulary is emitted exactly as `dsh-llm` validates it:
 *   `block-start {index, blockType}`, `text-delta/reasoning-delta
 *   {index, text}`, `tool-call-delta {index, id, name?, argumentsDelta}`,
 *   `block-end {index, block}`, `usage`, and one terminal `finish`.
 * - The engines are declared in `registerConfigurableProviders`, keyed to this
 *   row's Config (`providers.<id>`), so each one is a card in the third-party
 *   provider list where a person repoints the endpoint or enables a disabled
 *   engine without editing YAML; `registerModelDiscovery` answers what a typed
 *   endpoint advertises. An id another adapter already owns is left with its
 *   owner instead of being claimed, because both directories are all-or-nothing.
 * - One operation, two callers: `scan`, `list`, `use`, and `ping` are plain
 *   functions used both by the `local_models` agent tool and by the Web
 *   routes the composer control calls.
 * - `webServer` and `agentDefaultModel` are optional services, opened with
 *   `ctx.inject`, so a terminal/SDK profile still gets the adapter and tool.
 */
/**
 * Harness packages are used when they are importable and stood in for when
 * they are not, so this row activates in either install layout. See
 * vendor/llm-contract.js for why a linked checkout cannot see `@deepseek-ai/*`
 * and what the stand-ins reproduce.
 */
import { LocalLlmAdapter, LocalLlmError, noAttributionHeaders } from './vendor/llm-contract.js'

const harness = await import('@deepseek-ai/dsh-llm').catch(() => null)
const schemastery = (await import('@deepseek-ai/schemastery').catch(() => null))?.default ?? null
// Volatile config fields arrive as cosmokit reactive cells, so reading a live
// value means unwrapping one first. Optional for the same reason as above.
const cosmokit = (await import('@deepseek-ai/cosmokit').catch(() => null))
const isVolatile = cosmokit?.isVolatile ?? ((value) => Boolean(value) && typeof value.get === 'function' && typeof value.set === 'function')

const LlmAdapter = harness?.LlmAdapter ?? LocalLlmAdapter
const LlmError = harness?.LlmError ?? LocalLlmError
const attributionHeaders = harness?.attributionHeaders ?? noAttributionHeaders

export const name = 'local-llm'

// `llm` and `tools` are the hard carriers: without the adapter registry the
// plugin does nothing at all, and the tool must exist on a cold boot.
export const inject = ['llm', 'tools']

/**
 * The Config schema is what makes these engines editable, and the rules are
 * stricter than they look. `settings` projects a form from **only** the fields
 * whose nearest schema node carries `meta.volatile` — those are the live fields
 * a provider card writes — and `mutate` refuses any path that does not lie
 * beneath a volatile node. A schema with no volatile field describes no form at
 * all, which is why the engines stayed out of the Models page even though the
 * directory listed them. pi-ai marks its `providers` map volatile for exactly
 * this reason: an endpoint can then be repointed without remounting the row.
 * Everything else here stays ordinary configuration — present in the patch,
 * preserved across a form write, not editable from the Models page.
 *
 * schemastery v3 composes by nesting lowercase factories (`Schema.object`,
 * `Schema.dict`, `Schema.natural`), but a volatile marker has no factory, so the
 * tree is declared in schemastery's own node form and handed to its constructor
 * — the same move `dsh-settings` itself makes with `new z(schema.toJSON())`.
 */
const VENDOR_VALUES = ['lmstudio', 'ollama', 'strata', 'lemonade', 'openai']

/**
 * LM Studio labels every row of its native listing by model *type*, and that is
 * the only field separating a row that can drive an agent from one that cannot.
 * A live server reports `llm` and `vlm` for its chat models, with `embeddings`
 * sitting in the same list — never the literal `model` a naive reading of the
 * shape would assume.
 */
const LM_STUDIO_CHAT_TYPES = new Set(['llm', 'vlm', 'ocr'])

function buildConfig(Schema) {
  if (typeof Schema?.object !== 'function' || typeof Schema?.dict !== 'function' || typeof Schema?.union !== 'function') return undefined
  // A node's `meta` is a live object on the instance a factory returns, so a
  // marker is attached by mutating it — which is also the only way to attach
  // one, since no factory takes a meta argument. Compose with the factories
  // rather than a raw node tree: a hand-written tree leaves bare nodes sitting
  // in `dict`, and `settings` calls `toJSON()` on every child it recurses into.
  const providers = Schema.dict(
    Schema.object({
      label: Schema.string(),
      vendor: Schema.union(VENDOR_VALUES.map((value) => Schema.const(value))),
      baseURL: Schema.string(),
      // Write-only: only the fact that one is set ever reaches a surface.
      apiKey: mark(Schema.string(), { role: 'secret' }),
      enabled: Schema.boolean(),
      baseURLEnv: Schema.array(Schema.string()),
      models: Schema.array(
        Schema.object({
          id: Schema.string(),
          name: Schema.string(),
          contextWindow: Schema.natural(),
          maxTokens: Schema.natural(),
        }),
      ),
    }),
  )
  providers.meta.volatile = true
  return Schema.object({
    apiKey: Schema.string(),
    probeTimeoutMs: Schema.natural(),
    scanTtlMs: Schema.natural(),
    maxTokens: Schema.natural(),
    providers,
  })
}

function mark(node, meta) {
  if (node?.meta) Object.assign(node.meta, meta)
  return node
}

export const Config = schemastery ? buildConfig(schemastery) : undefined

const ROUTES = {
  scan: '/local-llm/api/scan',
  act: '/local-llm/api/act',
}

/**
 * Engine defaults, each with the endpoint that vendor actually serves:
 * LM Studio Dev 1234, Ollama 11434, Strata 8080 (its documented local
 * default), Lemonade 13305. `local-openai` covers llama.cpp/vLLM/LocalAI/TGI
 * and is off by default so two engines never claim the same port; a llama.cpp
 * server on 8080 belongs to `strata` until you say otherwise.
 *
 * `models` is a hand-written catalog used when a server advertises nothing
 * useful — Strata's model listing is not documented, so a declared id list is
 * the reliable path there, and `local_models use` works from it.
 */
const DEFAULT_PROVIDERS = {
  lmstudio: { label: 'LM Studio', vendor: 'lmstudio', baseURL: 'http://127.0.0.1:1234/v1', baseURLEnv: ['LMSTUDIO_BASE_URL'] },
  ollama: { label: 'Ollama', vendor: 'ollama', baseURL: 'http://127.0.0.1:11434/v1', baseURLEnv: ['OLLAMA_BASE_URL'] },
  strata: { label: 'Strata', vendor: 'strata', baseURL: 'http://127.0.0.1:8080/v1', baseURLEnv: ['STRATA_BASE_URL', 'STRATA_URL'] },
  lemonade: { label: 'Lemonade', vendor: 'lemonade', baseURL: 'http://127.0.0.1:13305/v1', baseURLEnv: ['LEMONADE_BASE_URL', 'LEMONADE_SERVER_URL'] },
  'local-openai': { label: 'Local OpenAI-compatible', vendor: 'openai', baseURL: 'http://127.0.0.1:8081/v1', baseURLEnv: ['DSH_LOCAL_OPENAI_BASE_URL'], enabled: false },
}

const MAX_BODY = 1 << 16

/**
 * Inline image transport is not implemented by this version: an image block is
 * rendered to the model as a named placeholder. `resolveModel` still reports
 * `inputModalities` for vision servers so the metadata is honest, and the
 * placeholder text tells the model the bytes were not sent.
 */
const VISION_INPUT = false

/** `agentDefaultModel` is an optional service: read it, never assume it. */
function defaultModelOf(ctx) {
  return (typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : ctx.agentDefaultModel) ?? undefined
}

function normalizeOptions(config = {}) {
  const given = unwrapVolatile(config.providers) ?? {}
  const engines = []
  for (const [id, fallback] of Object.entries(DEFAULT_PROVIDERS)) {
    const declared = given[id]
    const merged = { ...fallback, ...(declared && typeof declared === 'object' ? pruneUndefined(declared) : {}) }
    if (merged.enabled === false) continue
    if (typeof merged.baseURL !== 'string' || !merged.baseURL) continue
    engines.push({
      id,
      label: typeof merged.label === 'string' && merged.label ? merged.label : id,
      vendor: typeof merged.vendor === 'string' ? merged.vendor : 'openai',
      baseURL: resolveBaseUrl(merged),
      baseURLEnv: Array.isArray(merged.baseURLEnv) ? merged.baseURLEnv : [],
      apiKey: typeof merged.apiKey === 'string' && merged.apiKey ? merged.apiKey : undefined,
      models: (Array.isArray(merged.models) ? merged.models : [])
        .filter((model) => model && typeof model.id === 'string' && model.id)
        .map((model) => ({
          id: model.id,
          ...(model.name ? { name: model.name } : {}),
          ...(Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
        })),
    })
  }
  return {
    engines,
    scanTtlMs: numberOr(config.scanTtlMs, 15000),
    probeTimeoutMs: numberOr(config.probeTimeoutMs, 2500),
    requestTimeoutMs: numberOr(config.requestTimeoutMs, 180000),
    maxTokens: numberOr(config.maxTokens, 0),
    // Local servers ignore the key but most OpenAI-compatible stacks still
    // require an Authorization header to exist.
    apiKey: typeof config.apiKey === 'string' && config.apiKey ? config.apiKey : 'dsh-local',
  }
}

/** A field whose schema node carries `meta.volatile` is handed to the plugin as a
 * cosmokit reactive cell rather than a plain value, so reading a live value means
 * reading through the cell first. */
function unwrapVolatile(value) {
  return isVolatile(value) ? unwrapVolatile(value.get()) : value
}

function pruneUndefined(value) {
  const out = {}
  for (const [key, entry] of Object.entries(value)) if (entry !== undefined) out[key] = entry
  return out
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function resolveBaseUrl(engine) {
  for (const name of engine.baseURLEnv ?? []) {
    const fromEnv = process.env[name]
    if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim().replace(/\/+$/, '')
  }
  return String(engine.baseURL).replace(/\/+$/, '')
}

// ---------------------------------------------------------------------------
// HTTP helpers (global fetch; Node 20+ ships it in the Host process)
// ---------------------------------------------------------------------------

async function httpJson(url, { method = 'GET', body, headers = {}, timeoutMs = 5000, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true })
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: { accept: 'application/json', ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}${text ? `: ${text.slice(0, 240)}` : ''}`)
    return text ? JSON.parse(text) : {}
  } finally {
    clearTimeout(timer)
  }
}

function originOf(baseUrl) {
  try {
    return new URL(baseUrl).origin
  } catch {
    return baseUrl.replace(/^(https?:\/\/[^/]+).*$/, '$1')
  }
}

function joinUrl(baseUrl, path) {
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
}

// ---------------------------------------------------------------------------
// Vendor catalogs: richer than /v1/models (load state, context, quantization)
// ---------------------------------------------------------------------------

async function probeEngine(engine, options, signal) {
  const result = {
    id: engine.id,
    label: engine.label,
    vendor: engine.vendor,
    baseURL: engine.baseURL,
    alive: false,
    server: undefined,
    models: [],
    error: undefined,
  }
  try {
    const auth = { authorization: `Bearer ${engine.apiKey ?? options.apiKey}` }
    if (engine.vendor === 'ollama') {
      const tags = await httpJson(`${originOf(engine.baseURL)}/api/tags`, { headers: auth, timeoutMs: options.probeTimeoutMs, signal })
      result.alive = true
      const names = Array.isArray(tags.models) ? tags.models : []
      result.server = 'Ollama'
      result.models = names.slice(0, 40).map((entry) => ({
        id: entry.name,
        name: entry.name,
        quantization: entry.details?.quantization_level,
        contextWindow: entry.details?.context_length,
        loaded: undefined,
      }))
      // `capability` and the real context length live in /api/show per model.
      for (const model of result.models.slice(0, 8)) {
        try {
          const show = await httpJson(`${originOf(engine.baseURL)}/api/show`, {
            method: 'POST',
            body: { name: model.id },
            headers: auth,
            timeoutMs: options.probeTimeoutMs,
            signal,
          })
          const info = show.model_info ?? {}
          const architecture = info['general.architecture']
          if (architecture && typeof info[`${architecture}.context_length`] === 'number') model.contextWindow = info[`${architecture}.context_length`]
          model.vision = Object.keys(info).some((key) => key.endsWith('.mmproj') && info[key])
        } catch {
          /* keep the cheaper catalog entry */
        }
      }
      result.models = applyCatalogFallback(engine, result.models)
      return result
    }
    if (engine.vendor === 'lmstudio') {
      // The native listing carries what `/v1/models` does not: load state,
      // quantization, the context window the harness needs to price a request,
      // and the type filter above. Vision is the `vlm` type itself; tool support
      // is a capability, not a separate listing.
      const listed = await httpJson(`${originOf(engine.baseURL)}/api/v0/models`, { headers: auth, timeoutMs: options.probeTimeoutMs, signal })
      result.alive = true
      result.server = 'LM Studio'
      result.models = (Array.isArray(listed.data) ? listed.data : [])
        .filter((entry) => typeof entry?.id === 'string' && entry.id && (entry.type === undefined || LM_STUDIO_CHAT_TYPES.has(entry.type)))
        // A resident model answers without first loading weights, so lead with it.
        .sort((a, b) => Number(b.state === 'loaded') - Number(a.state === 'loaded'))
        .slice(0, 40)
        .map((entry) => ({
          id: entry.id,
          name: entry.display_name || entry.id,
          loaded: entry.state === 'loaded',
          ...(entry.state ? { state: entry.state } : {}),
          ...(entry.quantization ? { quantization: entry.quantization } : {}),
          ...(positiveInt(entry.max_context_length) ? { contextWindow: positiveInt(entry.max_context_length) } : {}),
          ...(entry.type === 'vlm' ? { vision: true } : {}),
          ...(Array.isArray(entry.capabilities) && entry.capabilities.includes('tool_use') ? { toolCalling: true } : {}),
        }))
      result.models = applyCatalogFallback(engine, result.models)
      return result
    }
    if (engine.vendor === 'strata') {
      // Strata answers the OpenAI listing, but its payload shape is not part of
      // its documented contract, so anything it does not describe comes from the
      // hand-written `models` list in this plugin's config.
      const listed = await httpJson(joinUrl(engine.baseURL, '/models'), { headers: auth, timeoutMs: options.probeTimeoutMs, signal })
      result.alive = true
      result.server = 'Strata'
      result.models = applyCatalogFallback(engine, normalizeOpenAiListing(listed))
      return result
    }
    if (engine.vendor === 'lemonade') {
      // Lemonade lists its registry with capability labels and context sizes.
      // Only `chat`-deployed models can drive an agent; `show_all=false` keeps
      // the catalog to what is actually downloaded.
      const listed = await httpJson(`${joinUrl(engine.baseURL, '/models')}?show_all=false`, { headers: auth, timeoutMs: options.probeTimeoutMs, signal })
      result.alive = true
      result.server = 'Lemonade'
      const data = Array.isArray(listed.data) ? listed.data : []
      result.models = data
        .filter((model) => typeof model?.id === 'string' && isChatCapable(model))
        .slice(0, 40)
        .map((model) => ({
          id: model.id,
          name: model.id,
          ...(positiveInt(model.context_length) ?? positiveInt(model.max_context_window) ? { contextWindow: positiveInt(model.context_length) ?? positiveInt(model.max_context_window) } : {}),
          ...(hasLabel(model, 'vision') ? { vision: true } : {}),
          ...(hasLabel(model, 'tool-calling') ? { toolCalling: true } : {}),
          ...(hasLabel(model, 'reasoning') ? { reasoning: true } : {}),
        }))
      result.models = applyCatalogFallback(engine, result.models)
      return result
    }
    const listed = await httpJson(joinUrl(engine.baseURL, '/models'), { headers: auth, timeoutMs: options.probeTimeoutMs, signal })
    result.alive = true
    result.server = listed.meta?.server_version ? String(listed.meta.server_version) : undefined
    result.models = applyCatalogFallback(engine, normalizeOpenAiListing(listed))
    return result
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    result.models = applyCatalogFallback(engine, result.models)
    return result
  }
}

function normalizeOpenAiListing(body) {
  const data = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
  return data
    .filter((entry) => typeof entry?.id === 'string' && entry.id)
    .slice(0, 40)
    .map((entry) => {
      const context = positiveInt(entry.context_window) ?? positiveInt(entry.contextWindow) ?? positiveInt(entry.max_context_length)
      return {
        id: entry.id,
        name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
        ...(context ? { contextWindow: context } : {}),
      }
    })
}

/**
 * A hand-declared `models` list fills in for a server that advertises nothing
 * (Strata's listing is undocumented) and supplies the numbers a server lists
 * without: the harness needs a context window to price and compact a request.
 */
function applyCatalogFallback(engine, models) {
  if (!engine.models?.length) return models
  const declared = new Map(engine.models.map((model) => [model.id, model]))
  const merged = models.map((model) => {
    const extra = declared.get(model.id)
    if (!extra) return model
    return {
      ...model,
      // A declared name reads better in a picker than a bare id, so it wins
      // over the id-derived one the listing produced.
      ...(extra.name ? { name: extra.name } : {}),
      ...(!model.contextWindow && extra.contextWindow ? { contextWindow: extra.contextWindow } : {}),
    }
  })
  if (merged.length) return merged
  return engine.models.map((model) => ({ ...model, name: model.name ?? model.id }))
}

function hasLabel(model, label) {
  return Array.isArray(model.labels) && model.labels.includes(label)
}

/** Lemonade's deployment labels pick the endpoint; only `chat` can be a brain. */
function isChatCapable(model) {
  if (!Array.isArray(model.labels) || model.labels.length === 0) return true
  return model.labels.includes('chat')
}

function positiveInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

// ---------------------------------------------------------------------------
// Harness messages -> OpenAI chat wire
// ---------------------------------------------------------------------------

function blocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
}

function blockText(block, { vision }) {
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : ''
    case 'file': {
      const name = block.attachment?.name ?? 'file'
      return `[attached file: ${name}]`
    }
    case 'image':
      return vision ? undefined : `[attached image: ${block.attachment?.name ?? 'image'}]`
    default:
      return ''
  }
}

function toChatMessages(messages, { vision }) {
  const system = []
  const out = []
  for (const message of messages ?? []) {
    if (!message || message.role === 'developer') continue
    const blocks = blocksOf(message.content)
    if (message.role === 'system') {
      for (const block of blocks) {
        const text = blockText(block, { vision: false })
        if (text) system.push(text)
      }
      continue
    }
    if (message.role === 'tool') {
      const parts = []
      for (const block of blocks) {
        const text = blockText(block, { vision })
        parts.push(text === undefined ? `[image ${block.attachment?.name ?? ''} omitted: this model route does not declare image input]` : text)
      }
      out.push({ role: 'tool', tool_call_id: message.toolCallId ?? '', content: parts.join('\n') })
      continue
    }
    if (message.role === 'assistant') {
      const texts = []
      const calls = []
      for (const block of blocks) {
        if (block.type === 'text') texts.push(block.text ?? '')
        else if (block.type === 'tool-call') {
          const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})
          calls.push({ id: block.callId ?? block.id ?? `call_${calls.length}`, type: 'function', function: { name: block.name, arguments: args } })
        }
      }
      const entry = { role: 'assistant', content: texts.join('') }
      if (calls.length) entry.tool_calls = calls
      out.push(entry)
      continue
    }
    // user, plus request-only user inputs (same content vocabulary, no id)
    const parts = []
    let hasRichPart = false
    for (const block of blocks) {
      if (block.type === 'image' && vision) {
        hasRichPart = true
        parts.push({ type: 'text', text: `[image ${block.attachment?.name ?? ''}: inline image transport is not implemented by this adapter version]` })
        continue
      }
      const text = blockText(block, { vision })
      if (text) parts.push({ type: 'text', text })
    }
    if (!hasRichPart) {
      const joined = parts.map((part) => part.text).join('')
      out.push({ role: 'user', content: joined })
      continue
    }
    out.push({ role: 'user', content: parts })
  }
  if (system.length) out.unshift({ role: 'system', content: system.join('\n\n') })
  return out
}

function toChatTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description ?? '', parameters: tool.parameters ?? { type: 'object', properties: {} } },
  }))
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

class LocalOpenAiAdapter extends LlmAdapter {
  constructor(engines, options, cache) {
    super()
    this.engines = engines
    this.byProvider = new Map(engines.map((engine) => [engine.id, engine]))
    this.options = options
    this.cache = cache
  }

  engine(provider) {
    const engine = this.byProvider.get(provider)
    if (!engine) throw new LlmError(`local-llm does not own provider route "${provider}"`, 'NO_ADAPTER')
    return engine
  }

  providerInfo(provider) {
    const engine = this.engine(provider)
    return { id: provider, name: `${engine.label} (local)` }
  }

  async listModels(provider) {
    const engine = this.engine(provider)
    const scanned = await this.cache.scan(engine, provider)
    return scanned.models.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.vision ? { inputModalities: ['text', 'image'] } : {}),
    }))
  }

  async resolveModel(provider, model, signal) {
    const engine = this.engine(provider)
    const scanned = await this.cache.scan(engine, provider, signal)
    const known = scanned.models.find((entry) => entry.id === model)
    const contextWindow = known?.contextWindow && Number.isInteger(known.contextWindow) && known.contextWindow > 0 ? known.contextWindow : undefined
    return {
      provider,
      id: model,
      name: known?.name ?? model,
      ...(contextWindow ? { context: { contextWindow } } : {}),
      ...(contextWindow ? { defaultMaxTokens: Math.min(4096, Math.floor(contextWindow / 4)) } : {}),
      ...(known?.vision ? { inputModalities: ['text', 'image'] } : {}),
    }
  }

  /** One provider attempt: streaming chat completion projected onto harness chunks. */
  async *stream(options) {
    const engine = this.engine(options.provider)
    const payload = {
      model: options.model,
      messages: toChatMessages(options.messages, { vision: VISION_INPUT }),
      stream: true,
      stream_options: { include_usage: true },
    }
    const declared = toChatTools(options.tools)
    if (declared) payload.tools = declared
    const maxTokens = options.maxTokens ?? this.options.maxTokens
    if (maxTokens) payload.max_tokens = maxTokens
    if (typeof options.temperature === 'number') payload.temperature = options.temperature
    if (Array.isArray(options.stop) && options.stop.length) payload.stop = options.stop

    const response = await fetch(joinUrl(engine.baseURL, '/chat/completions'), {
      method: 'POST',
      signal: options.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${engine.apiKey ?? this.options.apiKey}`,
        ...attributionHeaders(),
      },
      body: JSON.stringify(payload),
    }).catch((error) => {
      throw new LlmError(`local-llm: ${engine.label} at ${engine.baseURL} is unreachable: ${error instanceof Error ? error.message : error}`, 'UNREACHABLE')
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new LlmError(`local-llm: ${engine.label} rejected ${options.model}: HTTP ${response.status}${detail ? ` ${detail.slice(0, 400)}` : ''}`, response.status === 429 ? 'RATE_LIMIT' : response.status === 401 || response.status === 403 ? 'AUTH' : 'PROVIDER_ERROR')
    }

    const open = new Map() // harness block kind -> { index, text }
    const calls = new Map() // native tool-call slot -> { index, id, name, args }
    let nextIndex = 0
    let usage
    let finishReason

    const openBlock = function* (kind) {
      const existing = open.get(kind)
      if (existing) return existing
      const entry = { index: nextIndex++, text: '' }
      open.set(kind, entry)
      yield { type: 'block-start', index: entry.index, blockType: kind }
      return entry
    }

    const closeBlocks = function* () {
      for (const [kind, entry] of open) {
        if (kind === 'text') yield { type: 'block-end', index: entry.index, block: { type: 'text', text: entry.text } }
        else yield { type: 'block-end', index: entry.index, block: { type: 'reasoning', text: entry.text } }
      }
      open.clear()
      for (const entry of calls.values()) {
        yield {
          type: 'block-end',
          index: entry.index,
          block: { type: 'tool-call', callId: entry.id, name: entry.name ?? '', arguments: entry.args },
        }
      }
      calls.clear()
    }

    const handleEvent = function* (raw) {
      const trimmed = raw.trim()
      if (!trimmed.startsWith('data:')) return
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') return
      let event
      try {
        event = JSON.parse(data)
      } catch {
        return
      }
      if (event.usage) {
        usage = {
          inputTokens: event.usage.prompt_tokens ?? event.usage.input_tokens ?? 0,
          outputTokens: event.usage.completion_tokens ?? event.usage.output_tokens ?? 0,
          totalTokens: event.usage.total_tokens ?? 0,
        }
      }
      if (event.choices?.[0]?.finish_reason) finishReason = event.choices[0].finish_reason
      const delta = event.choices?.[0]?.delta
      if (!delta) return
      const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : ''
      if (reasoning) {
        const block = yield* openBlock('reasoning')
        block.text += reasoning
        yield { type: 'reasoning-delta', index: block.index, text: reasoning }
      }
      if (typeof delta.content === 'string' && delta.content) {
        const block = yield* openBlock('text')
        block.text += delta.content
        yield { type: 'text-delta', index: block.index, text: delta.content }
      }
      for (const toolCall of delta.tool_calls ?? []) {
        const slot = toolCall.index ?? 0
        let entry = calls.get(slot)
        if (!entry) {
          entry = { index: nextIndex++, id: toolCall.id ?? `call_${slot}`, name: undefined, args: '' }
          calls.set(slot, entry)
          yield { type: 'block-start', index: entry.index, blockType: 'tool-call' }
        }
        if (toolCall.id) entry.id = toolCall.id
        const name = typeof toolCall.function?.name === 'string' && toolCall.function.name ? toolCall.function.name : undefined
        if (name && entry.name === undefined) entry.name = name
        const argumentsDelta = typeof toolCall.function?.arguments === 'string' ? toolCall.function.arguments : ''
        yield { type: 'tool-call-delta', index: entry.index, id: entry.id, ...(entry.name === undefined ? {} : { name: entry.name }), argumentsDelta }
        entry.args += argumentsDelta
      }
    }

    // Node exposes the response body as an async-iterable web stream.
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary
        for (;;) {
          boundary = buffer.search(/\r?\n\r?\n/)
          if (boundary === -1) break
          const separator = buffer.slice(boundary).match(/\r?\n\r?\n/)[0]
          const event = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + separator.length)
          for (const part of event.split(/\r?\n/)) yield* handleEvent(part)
        }
      }
      buffer += decoder.decode()
      if (buffer.trim()) for (const part of buffer.split(/\r?\n/)) yield* handleEvent(part)
    } finally {
      reader.releaseLock?.()
    }

    yield* closeBlocks()
    if (usage) yield { type: 'usage', usage }
    // The wire says `length`; the harness taxonomy is `max-tokens` (its
    // FinishReasonMap has no `length`), and a consumer that relies on that kind
    // to notice a truncated reply would never see one otherwise.
    const kind = finishReason === 'length' ? 'max-tokens' : finishReason === 'tool_calls' || finishReason === 'function_call' ? 'tool-calls' : 'stop'
    yield { type: 'finish', reason: { kind } }
  }
}

// ---------------------------------------------------------------------------
// Scan cache (one operation, two callers: tool + Web route)
// ---------------------------------------------------------------------------

function createScanCache(adapters, options) {
  let cache = { at: 0, engines: [] }
  const scan = async (engine, provider, signal) => {
    const now = Date.now()
    const hit = cache.engines.find((entry) => entry.id === engine.id && now - cache.at < options.scanTtlMs)
    if (hit) return hit
    const fresh = await probeEngine(engine, options, signal)
    cache = { at: now, engines: [...cache.engines.filter((entry) => entry.id !== engine.id), fresh] }
    return fresh
  }
  return {
    scan,
    async all() {
      const now = Date.now()
      if (cache.engines.length && now - cache.at < options.scanTtlMs) return { at: cache.at, engines: cache.engines, cached: true }
      const engines = await Promise.all(options.engines.map((engine) => probeEngine(engine, options)))
      cache = { at: Date.now(), engines }
      return { at: cache.at, engines, cached: false }
    },
    invalidate() {
      cache = { at: 0, engines: [] }
    },
  }
}

/**
 * Answer a configuration surface's draft: it holds an endpoint the person just
 * typed and asks what runs there. Nothing here reads or stores settings or
 * credentials — the surface owns those, and this returns candidate metadata it
 * may offer for adoption.
 */
async function discoverDraft(options, request, signal) {
  const baseURL = String(request.baseURL ?? '').trim().replace(/\/+$/, '')
  if (!baseURL) throw new LlmError('local-llm discovery needs a baseURL to interrogate', 'DISCOVERY_FAILED')
  const known = options.engines.find((engine) => engine.id === request.provider)
  const vendor = known?.vendor ?? (/ollama/i.test(String(request.api ?? '')) ? 'ollama' : 'openai')
  const scanned = await probeEngine(
    { id: request.provider ?? 'draft', label: request.provider ?? 'draft', vendor, baseURL, baseURLEnv: [], apiKey: request.apiKey ?? undefined, models: [] },
    { ...options, probeTimeoutMs: 8000 },
    signal,
  )
  if (!scanned.alive) {
    throw new LlmError(`local-llm could not read a model list at ${baseURL}: ${scanned.error ?? 'the server answered no usable catalog'}`, 'DISCOVERY_FAILED')
  }
  return scanned.models.map((model) => ({
    id: model.id,
    ...(model.name ? { name: model.name } : {}),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.vision ? { inputModalities: ['text', 'image'] } : {}),
  }))
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const options = normalizeOptions(config)
  if (options.engines.length === 0) {
    ctx.logger?.warn?.('local-llm: no engines configured; the plugin registers nothing')
    return
  }

  /**
   * The settings address of this row's Config. A configuration surface holds
   * the namespace from the provider directory and writes an engine's endpoint
   * into the path beside it, so `providers.<id>.baseURL` here is exactly what
   * the Models page edits.
   */
  const settingsNs = ctx.fiber?.entry?.options?.id ?? 'local-llm'

  /**
   * `providers` is volatile, so the Models page can rewrite an endpoint without
   * remounting this row — and nothing would notice unless the values the adapter
   * and scan cache closed over are refreshed from the live config. Both hold this
   * same `options` object and the same `engines` array, so refreshing in place
   * reaches them; the provider *ids* themselves are fixed until the row remounts,
   * because the adapter registry has no per-route replacement.
   */
  function liveOptions() {
    const fresh = normalizeOptions(ctx.fiber?.config ?? config)
    options.engines.length = 0
    options.engines.push(...fresh.engines)
    Object.assign(options, {
      scanTtlMs: fresh.scanTtlMs,
      probeTimeoutMs: fresh.probeTimeoutMs,
      requestTimeoutMs: fresh.requestTimeoutMs,
      maxTokens: fresh.maxTokens,
      apiKey: fresh.apiKey,
    })
    return options
  }

  // Both the adapter registry and the provider directory are all-or-nothing, so
  // an id another plugin already owns is left to its owner instead of being
  // claimed (which would throw, in this plugin or in the one that mounts after
  // it). A hand-declared pi-ai provider called `strata` is the common case.
  const ownedRoutes = new Set(ctx.llm.listProviders().map((entry) => entry.id))
  const declaredProviders = new Set((ctx.llm.listConfigurableProviders?.() ?? []).map((entry) => entry.provider))
  const isShadowed = (engine) => ownedRoutes.has(engine.id) || declaredProviders.has(engine.id)
  const claimable = options.engines.filter((engine) => !isShadowed(engine))
  const shadowed = options.engines.filter(isShadowed)
  const ownership = {
    servedByThisPlugin: claimable.map((engine) => engine.id),
    ownedElsewhere: shadowed.map((engine) => ({ id: engine.id, baseURL: engine.baseURL, why: 'another adapter or provider directory owns this id, so its route stays with them' })),
  }

  const cache = createScanCache(null, options)
  const adapter = new LocalOpenAiAdapter(options.engines, options, cache)

  if (claimable.length) {
    ctx.effect(() => ctx.llm.registerAdapter(claimable.map((engine) => engine.id), adapter), 'local-llm: provider adapters')
    // The third-party provider directory: this is what makes each engine an
    // option to add and edit in Settings instead of a YAML exercise.
    ctx.effect(() => ctx.llm.registerConfigurableProviders(claimable.map((engine) => ({
      provider: engine.id,
      displayName: engine.label,
      settingsNs,
      settingsPath: ['providers', engine.id],
      declared: true,
      defaultBaseURL: engine.baseURL,
      ...(engine.baseURLEnv.length ? { baseURLEnv: engine.baseURLEnv } : {}),
    }))), 'local-llm: configurable provider directory')
  }

  // Discovery is keyed by namespace, not provider, because a provider being
  // added has no route to name yet: the surface sends a draft endpoint and this
  // answers with what that endpoint advertises.
  ctx.effect(() => ctx.llm.registerModelDiscovery(settingsNs, (request, signal) => discoverDraft(liveOptions(), request, signal)), 'local-llm: model discovery')

  // The Models page owns this plugin's form; a second auto-generated one would
  // show the same provider fields twice.
  ctx.inject(['settings'], (scope) => {
    scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber))
  })

  for (const engine of shadowed) {
    ctx.logger?.warn?.(`local-llm: provider "${engine.id}" is already owned by another adapter, so its route and settings entry are left to that owner. Its endpoint is still scanned, pinged and selectable here; to hand the route to this engine, delete the other provider declaration and reload.`)
  }

  /** Shared implementation behind the tool and the Web route. */
  async function act(action, args = {}) {
    liveOptions()
    switch (action) {
      case 'scan': {
        cache.invalidate()
        const scanned = await cache.all()
        return { ok: true, kind: 'scan', ...scanned }
      }
      case 'list': {
        const scanned = await cache.all()
        return {
          ok: true,
          kind: 'list',
          cached: scanned.cached,
          scannedAt: scanned.at,
          routes: ctx.llm.listProviders().map((provider) => provider.id),
          localRoutes: options.engines.map((engine) => ({ id: engine.id, label: engine.label, vendor: engine.vendor, baseURL: engine.baseURL })),
          engines: scanned.engines,
          ownership,
          settingsNs,
          selection: defaultModelOf(ctx)?.currentSelection?.(),
        }
      }
      case 'status': {
        const directory = (ctx.llm.listConfigurableProviders?.() ?? []).filter((entry) => entry.settingsNs === settingsNs)
        return {
          ok: true,
          kind: 'status',
          routes: ctx.llm.listProviders().map((provider) => provider.id),
          endpoints: options.engines.map((engine) => ({ id: engine.id, label: engine.label, vendor: engine.vendor, baseURL: engine.baseURL })),
          // What a configuration surface sees: each entry here is a card in the
          // third-party provider list, editable at `providers.<id>`.
          settingsDirectory: directory.map((entry) => ({
            provider: entry.provider,
            displayName: entry.displayName,
            settingsPath: entry.settingsPath,
            defaultBaseURL: entry.defaultBaseURL,
          })),
          ownership,
          settingsNs,
          selection: defaultModelOf(ctx)?.currentSelection?.(),
          note: 'status performs no probing; use scan or list for liveness',
        }
      }
      case 'settings': {
        // Read-only answer to the question a user actually asks: can a settings
        // surface see these providers, and where would its edits land?
        const service = typeof ctx.get === 'function' ? ctx.get('settings') : ctx.settings
        if (!service) return { ok: false, error: 'this profile has no settings service; configure this row in its profile patch' }
        const descriptors = (service.describe?.({ redactSecrets: true }) ?? []).filter((entry) => entry.ns === settingsNs)
        return {
          ok: true,
          kind: 'settings',
          settingsNs,
          visibleToSettingsSurface: descriptors.length > 0,
          // What the surface actually keys its forms by, and what this fiber
          // offers as an id: kept in the diagnostic because getting this pair
          // wrong silently detaches the provider cards from their fields.
          allNamespaces: (service.describe?.({ redactSecrets: true }) ?? []).map((entry) => entry.ns).slice(0, 40),
          fiberIds: {
            entryOptionsId: ctx.fiber?.entry?.options?.id,
            entryId: ctx.fiber?.entry?.id,
            entryPatchId: ctx.fiber?.entry?.patchId,
            fiberKeys: Object.keys(ctx.fiber ?? {}),
            entryKeys: Object.keys(ctx.fiber?.entry ?? {}),
          },
          descriptors: descriptors.map((entry) => ({
            ns: entry.ns,
            autoGenerate: entry.autoGenerate,
            hasSchema: Boolean(entry.schema),
            revision: entry.revision,
            value: entry.value,
          })),
          directory: (ctx.llm.listConfigurableProviders?.() ?? [])
            .filter((entry) => entry.settingsNs === settingsNs)
            .map((entry) => ({ provider: entry.provider, displayName: entry.displayName, settingsPath: entry.settingsPath, defaultBaseURL: entry.defaultBaseURL })),
          patchPath: service.prepareDocument ? await service.prepareDocument() : undefined,
        }
      }
      case 'use': {
        const provider = String(args.provider ?? '')
        const model = String(args.model ?? '')
        // Any registered route is selectable, not only the local ones: the same
        // action is how a user (or the agent) moves a session back to a hosted
        // provider afterwards.
        const registered = ctx.llm.listProviders().map((entry) => entry.id)
        if (!registered.includes(provider)) {
          return { ok: false, error: `provider "${provider}" has no registered adapter route; try: ${registered.join(', ')}` }
        }
        if (!model) return { ok: false, error: 'use needs a model id' }
        const scanner = defaultModelOf(ctx)
        if (!scanner) return { ok: false, error: 'this profile has no agentDefaultModel service; choose the model in the composer instead' }
        const before = scanner.currentSelection()
        const next = { provider, model, ...(args.reasoningEffort ? { reasoningEffort: String(args.reasoningEffort) } : {}) }
        await scanner.saveSelection(next)
        return { ok: true, kind: 'use', before, after: scanner.currentSelection(), note: 'the default model for new sessions is saved; the current session keeps its own composer selection' }
      }
      case 'ping': {
        const provider = String(args.provider ?? '')
        const engine = options.engines.find((entry) => entry.id === provider)
        if (!engine) return { ok: false, error: `unknown local provider "${provider}"; try: ${options.engines.map((entry) => entry.id).join(', ')}` }
        let model = String(args.model ?? '')
        if (!model) {
          const scanned = await cache.scan(engine, provider)
          model = scanned.models?.[0]?.id ?? ''
          if (!model) return { ok: false, error: `${engine.label} at ${engine.baseURL} advertises no models${scanned.error ? ` (${scanned.error})` : ''}`, provider, model: '' }
        }
        const prompt = typeof args.prompt === 'string' && args.prompt ? args.prompt : 'Reply with exactly one word: pong'
        const started = Date.now()
        const text = []
        const reasoning = []
        let usage
        let finish
        try {
          for await (const chunk of ctx.llm.stream({
            provider,
            model,
            maxTokens: numberOr(args.maxTokens, 64) || undefined,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          })) {
            if (chunk.type === 'text-delta') text.push(chunk.text)
            // A reasoning model spends the whole output budget on its thinking
            // channel before any answer token arrives, so an empty `text` beside
            // a `length` finish is normally that and not a broken connection.
            // Report what did stream rather than implying nothing worked.
            else if (chunk.type === 'reasoning-delta') reasoning.push(chunk.text)
            else if (chunk.type === 'usage') usage = chunk.usage
            else if (chunk.type === 'finish') finish = chunk.reason
          }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error), provider, model }
        }
        const reasoningText = reasoning.join('')
        return {
          ok: finish?.kind !== 'error',
          kind: 'ping',
          provider,
          model,
          ms: Date.now() - started,
          text: text.join('').slice(0, 400),
          ...(text.length === 0 && reasoningText ? { reasoningChars: reasoningText.length, reasoning: reasoningText.slice(0, 240) } : {}),
          usage,
          finish,
        }
      }
      default:
        return { ok: false, error: `unknown action "${action}"; use scan | list | status | use | ping` }
    }
  }

  ctx.effect(() => ctx.tools.register({
    name: 'local_models',
    description:
      'Discover and use local-LLM engine routes registered by the local-llm plugin: lmstudio, ollama, strata, lemonade, and local-openai (llama.cpp, vLLM, LocalAI, TGI, or any OpenAI-compatible chat-completions server). '
      + 'Each engine is also a configurable provider entry in Settings, so a person can point it at another port or enable a disabled one without editing YAML. '
      + 'action=scan re-probes every enabled endpoint, action=list reports endpoints plus models (load state, context window, quantization and capability labels where the server reports them) and which ids this plugin owns versus who else does, '
      + 'action=status lists registered provider routes and the saved default model without probing, action=settings reports whether a settings surface can see this plugin\u2019s provider entries and where its edits would land, action=use saves {provider, model} as the default for new sessions (any registered route, local or hosted), '
      + 'action=ping streams one tiny completion through the Harness llm service to prove the route works end to end. '
      + 'These routes are usable as the agent brain: pick one in the composer model picker.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['scan', 'list', 'status', 'settings', 'use', 'ping'] },
        provider: { type: 'string', description: 'Provider route id for use/ping, for example "lmstudio" or "ollama".' },
        model: { type: 'string', description: 'Exact model id for use/ping.' },
        prompt: { type: 'string', description: 'Optional prompt for ping (default asks for one word).' },
        maxTokens: { type: 'number', description: 'Optional output cap for ping.' },
        reasoningEffort: { type: 'string', description: 'Optional reasoning effort for use, when the model declares one.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: summarize(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        return plain(await act(args?.action ?? 'list', args ?? {}))
      } catch (error) {
        return plain({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'local-llm: local_models tool')

  whenAvailable(ctx, ['webServer'], (scope) => scope.webServer.register({
    kind: 'exact',
    path: ROUTES.scan,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      const force = new URL(req.url ?? ROUTES.scan, 'http://local').searchParams.get('force') === '1'
      try {
        return sendJson(res, 200, plain(force ? await act('scan') : await act('list')))
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }, 'local-llm: scan route'))

  whenAvailable(ctx, ['webServer'], (scope) => scope.webServer.register({
    kind: 'exact',
    path: ROUTES.act,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      let body = {}
      try {
        const raw = await readBody(req)
        body = raw ? JSON.parse(raw) : {}
      } catch {
        return sendJson(res, 400, { ok: false, error: 'body must be JSON' })
      }
      if (typeof body.action !== 'string') return sendJson(res, 400, { ok: false, error: 'action is required' })
      try {
        return sendJson(res, 200, plain(await act(body.action, body)))
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }, 'local-llm: act route'))

  ctx.logger?.info?.(`local-llm: provider routes ${options.engines.map((engine) => `${engine.id}@${engine.baseURL}`).join(', ')}`)
}

// ---------------------------------------------------------------------------
// Plumbing shared with the Web routes
// ---------------------------------------------------------------------------

function summarize(value) {
  if (!value) return 'local-llm returned nothing'
  if (value.ok === false) return `local-llm failed: ${value.error ?? 'unknown error'}`
  switch (value.kind) {
    case 'ping':
      return `ping ${value.provider}/${value.model}: ${value.ms}ms finish=${value.finish?.kind ?? 'none'}${value.usage ? ` tokens ${value.usage.inputTokens}->${value.usage.outputTokens}` : ''} -> ${value.text || (value.reasoningChars ? `(thought for ${value.reasoningChars} chars and hit the cap before answering; raise maxTokens) ${value.reasoning ?? ''}` : '(no text)')}`
    case 'settings':
      return [
        `settings namespace: ${value.settingsNs}`,
        `visible to the settings surface: ${value.visibleToSettingsSurface}`,
        ...value.descriptors.map((entry) => `descriptor: auto-page=${entry.autoGenerate} schema=${entry.hasSchema} revision=${entry.revision}`),
        `directory entries: ${value.directory.map((entry) => `${entry.provider} at ${(entry.settingsPath ?? []).join('.')}`).join(', ') || 'none'}`,
        `namespaces the surface describes: ${(value.allNamespaces ?? []).join(', ') || 'none'}`,
        `fiber ids: ${JSON.stringify(value.fiberIds ?? {})}`,
        `profile patch: ${value.patchPath ?? 'unknown'}`,
      ].join('\n')
    case 'use':
      return `default model saved: ${value.after?.provider}/${value.after?.model} (was ${value.before?.provider}/${value.before?.model}). ${value.note ?? ''}`
    case 'status':
      return [
        `routes: ${value.routes.join(', ')}`,
        `endpoints: ${value.endpoints.map((entry) => `${entry.id}[${entry.vendor}]=${entry.baseURL}`).join('  ')}`,
        ownershipLine(value),
        value.settingsDirectory ? `in the Settings provider directory: ${value.settingsDirectory.map((entry) => `${entry.provider}@${entry.defaultBaseURL}`).join(', ') || 'nothing declared'}` : '',
        `default model: ${value.selection ? `${value.selection.provider}/${value.selection.model}` : 'none reported'}`,
        value.note ?? '',
      ].filter(Boolean).join('\n')
    case 'scan':
    case 'list': {
      const lines = value.engines.map((engine) => `${engine.alive ? 'up  ' : 'down'} ${engine.label} (${engine.vendor}) ${engine.baseURL}${engine.error ? ` (${engine.error})` : ''}${engine.models?.length ? ` — ${engine.models.map(describeModel).join('; ')}` : ''}`)
      const extras = [ownershipLine(value)]
      if (value.routes) extras.push(`routes: ${value.routes.join(', ')}`)
      if (value.selection) extras.push(`default model: ${value.selection.provider}/${value.selection.model}`)
      return [...lines, ...extras].filter(Boolean).join('\n')
    }
    default:
      return `local-llm ok: ${JSON.stringify(value).slice(0, 400)}`
  }
}

function describeModel(model) {
  const bits = [model.id]
  if (model.loaded === false) bits.push('(not loaded)')
  else if (model.loaded === true) bits.push('(loaded)')
  if (model.contextWindow) bits.push(`ctx ${model.contextWindow}`)
  if (model.quantization) bits.push(model.quantization)
  if (model.vision) bits.push('vision')
  if (model.toolCalling) bits.push('tools')
  if (model.reasoning) bits.push('reasoning')
  return bits.join(' ')
}

/** Which ids this plugin drives, and which it deliberately left to their owner. */
function ownershipLine(value) {
  const ownership = value.ownership
  if (!ownership) return ''
  const parts = [`served by local-llm: ${ownership.servedByThisPlugin.join(', ') || 'none'}`]
  if (ownership.ownedElsewhere.length) {
    parts.push(`left to another owner: ${ownership.ownedElsewhere.map((entry) => `${entry.id}@${entry.baseURL}`).join(', ')}`)
  }
  return parts.join(' | ')
}

function whenAvailable(ctx, deps, register, label) {
  if (typeof ctx.inject === 'function') {
    ctx.inject(deps, (scope) => {
      scope.effect(() => register(scope), label)
    })
    return
  }
  const scope = {}
  for (const dep of deps) {
    scope[dep] = ctx.get(dep)
    if (!scope[dep]) {
      ctx.logger?.warn?.(`local-llm: no ${dep} carrier; the Web routes are not registered`)
      return
    }
  }
  ctx.effect(() => register(scope), label)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value ?? null)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** Tool results must be lossless JSON. */
function plain(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null))
  } catch {
    return { ok: false, error: 'local-llm returned a non-serializable result' }
  }
}
