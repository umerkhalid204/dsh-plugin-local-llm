/**
 * Dev-only dry run and offline test suite: exercises five catalog dialects, the
 * declared-catalog fallback, the provider-directory and discovery wiring, wire
 * conversion, SSE parsing and chunk emission against the fake servers in
 * test/fake-openai-server.mjs — no Harness, no local engines.
 *
 *   node test/dry-run.mjs
 *
 * It stages a throwaway tree first: `index.js` and `vendor/` are copied to
 * test/shim/pkg, and the files in test/shims are placed under
 * test/shim/node_modules/@deepseek-ai as stand-ins for `@deepseek-ai/dsh-llm`
 * and `@deepseek-ai/schemastery`, so the copy's bare specifiers resolve there.
 * Nothing in the shipped package or the workspace gains a `node_modules`, which
 * matters: a stand-in inside the checkout's own module chain would satisfy a
 * linked install and silently replace the real Harness module.
 *
 * The Harness itself validates the chunk vocabulary and the Config schema; these
 * shims cannot. What is checked here is behaviour and wiring.
 */
import { copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const shimRoot = join(here, 'shim')
rmSync(shimRoot, { recursive: true, force: true })

const scoped = join(shimRoot, 'node_modules', '@deepseek-ai')
for (const name of ['dsh-llm', 'schemastery']) {
  mkdirSync(join(scoped, name), { recursive: true })
  writeFileSync(
    join(scoped, name, 'package.json'),
    JSON.stringify({ name: `@deepseek-ai/${name}`, version: '0.0.0-dev-shim', type: 'module', main: 'index.js', exports: { '.': './index.js' } }, null, 2),
  )
  copyFileSync(join(here, 'shims', `${name}.js`), join(scoped, name, 'index.js'))
}

const pkg = join(shimRoot, 'pkg')
mkdirSync(pkg, { recursive: true })
copyFileSync(join(here, '..', 'index.js'), join(pkg, 'index.js'))
cpSync(join(here, '..', 'vendor'), join(pkg, 'vendor'), { recursive: true })

const mod = await import('./shim/pkg/index.js')
const { apply } = mod

const captured = { adapter: null, providers: [], directory: null, discovery: null, configured: [] }

const ctx = {
  fiber: { entry: { options: { id: 'local-llm' } } },
  llm: {
    registerAdapter(providers, adapter) {
      captured.adapter = adapter
      captured.providers = providers
      return { replace: (next) => { captured.providers = next } }
    },
    // A pre-existing owner of `ollama`, exactly like a hand-declared provider
    // called `strata` in a real profile.
    listConfigurableProviders: () => [{ provider: 'ollama', displayName: 'Ollama (someone else)', settingsNs: 'other-plugin', settingsPath: ['providers', 'ollama'] }],
    registerConfigurableProviders(entries) {
      captured.directory = entries
      return { replace: (next) => { captured.directory = next } }
    },
    registerModelDiscovery(settingsNs, discover) {
      captured.discovery = { settingsNs, discover }
      return () => {}
    },
    listProviders() {
      return captured.providers.map((id) => ({ id, name: id }))
    },
    fileRequestText(ref) {
      return `[file ${ref?.name ?? ''}]`
    },
  },
  tools: {
    register(definition) {
      captured.tool = definition
      return () => {}
    },
  },
  inject(deps, register) {
    const scope = { effect: (fn) => fn() }
    for (const dep of deps) scope[dep] = dep === 'settings' ? { configure: (policy) => captured.configured.push(policy) } : undefined
    if (deps.every((dep) => scope[dep] !== undefined)) register(scope)
  },
  effect(fn) {
    return fn()
  },
  get() {
    return undefined
  },
  logger: { info: () => {}, warn: () => {} },
}

// `providers` is marked volatile, which in the Loader means it reaches the
// plugin as a reactive cell rather than a plain map. Staging it that way here is
// deliberate: if the unwrap ever regressed, every engine would silently fall back
// to built-in defaults and the catalog assertions below would fail loudly.
const declaredProviders = {
  'local-openai': { enabled: true },
  strata: { models: [{ id: 'iq3_s', name: 'Qwen3.8-Flash-Next IQ3_S', contextWindow: 32768 }] },
}

apply(ctx, {
  providers: { get: () => declaredProviders, set: () => {} },
})

const adapter = captured.adapter
if (!adapter) throw new Error('apply() registered no adapter')

let failures = 0
const results = []
const check = (label, condition, detail) => {
  results.push(`${condition ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures += 1
}

const collect = async (options) => {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

// --- schema ---------------------------------------------------------------
const config = mod.Config
const providers = config?.dict?.providers
check('Config is declared', Boolean(config), config ? `type=${config.type}` : 'undefined')
// `settings` projects a form from volatile-marked fields only, and `mutate`
// refuses any path not beneath one, so this marker is what puts a provider card
// on the Models page at all.
check('providers is a dict marked volatile so a form exists and the path is writable',
  providers?.type === 'dict' && providers?.meta?.volatile === true,
  JSON.stringify(providers?.meta ?? null),
)
check('the volatile map types an engine row', ['label', 'vendor', 'baseURL', 'apiKey', 'enabled', 'baseURLEnv', 'models'].every((key) => providers?.inner?.dict?.[key]), Object.keys(providers?.inner?.dict ?? {}).join(', '))
check('vendor union names every engine', providers?.inner?.dict?.vendor?.list?.map((entry) => entry.value).join(',') === 'lmstudio,ollama,strata,lemonade,openai', providers?.inner?.dict?.vendor?.list?.map((entry) => entry.value).join(','))
check('an engine api key is write-only', providers?.inner?.dict?.apiKey?.meta?.role === 'secret', JSON.stringify(providers?.inner?.dict?.apiKey?.meta))
check('plain knobs stay ordinary config, not form fields', config?.dict?.probeTimeoutMs?.meta?.volatile === undefined && config?.dict?.apiKey?.meta?.volatile === undefined)
// `listModels` is the picker-facing shape: id, name, context, modalities. The
// richer vendor metadata — load state, quantization, tool and reasoning labels —
// is carried on the probe result that `local_models list` renders, so each
// assertion below targets the layer that actually holds the field.

// --- registration and ownership ------------------------------------------
check('claims unclaimed ids', ['lmstudio', 'strata', 'lemonade', 'local-openai'].every((id) => captured.providers.includes(id)), captured.providers.join(', '))
check('leaves a contested id to its owner', !captured.providers.includes('ollama'))
check('directory entry count matches claimed routes', captured.directory?.length === captured.providers.length, `${captured.directory?.length} vs ${captured.providers.length}`)
check(
  'directory points at this row config',
  captured.directory.every((entry) => entry.settingsNs === 'local-llm' && entry.settingsPath?.[0] === 'providers' && entry.defaultBaseURL?.startsWith('http')),
  captured.directory.map((entry) => `${entry.provider}:${entry.settingsNs}`).join(', '),
)
check('settings page policy is non-automatic', captured.configured.some((policy) => policy.auto === false))
check('discovery namespace matches the entry id', captured.discovery?.settingsNs === 'local-llm', captured.discovery?.settingsNs)

// --- catalog dialects -----------------------------------------------------
const strata = await adapter.listModels('strata')
const declared = strata.find((model) => model.id === 'iq3_s')
check('strata: declared catalog supplies name and context', declared?.contextWindow === 32768 && declared?.name === 'Qwen3.8-Flash-Next IQ3_S', JSON.stringify(declared))

const lemonade = await adapter.listModels('lemonade')
check('lemonade: vision label maps to an image input modality', lemonade.find((model) => model.id === 'LMX-Omni-52B-Halo')?.inputModalities?.includes('image'), JSON.stringify(lemonade.find((model) => model.id === 'LMX-Omni-52B-Halo')))
check('lemonade: non-chat deployments are excluded', !lemonade.some((model) => model.id === 'EmbeddingGemma-300M' || model.id === 'not-chat-deployed'), lemonade.map((model) => model.id).join(', '))
check('lemonade: max_context_window read', lemonade.find((model) => model.id === 'Qwen3-0.6B-GGUF')?.contextWindow === 40960)

const lmstudio = await adapter.listModels('lmstudio')
check('lmstudio: display name and context window read', lmstudio[0]?.name === 'Fake Coder 7B' && lmstudio[0]?.contextWindow === 32768, JSON.stringify(lmstudio[0]))
check('lmstudio: embedding-only rows are excluded', !lmstudio.some((model) => model.id === 'fake-embedder'), lmstudio.map((model) => model.id).join(', '))

const ollama = await adapter.listModels('ollama')
check('ollama: /api/show overrides the cheaper context length', ollama.find((model) => model.id === 'fake-coder-7b')?.contextWindow === 32768, JSON.stringify(ollama[0]))

const generic = await adapter.listModels('local-openai')
check('openai-compat: max_context_length read', generic.every((model) => model.contextWindow === 16384), JSON.stringify(generic))

const resolved = await adapter.resolveModel('lemonade', 'LMX-Omni-52B-Halo')
check('resolveModel reports context for compaction', resolved?.context?.contextWindow === 262144, JSON.stringify(resolved?.context))

// --- discovery ------------------------------------------------------------
const found = await captured.discovery.discover({ provider: 'lemonade', baseURL: 'http://127.0.0.1:13305/v1', api: 'openai-completions' })
check('discovery lists chat-capable models', Array.isArray(found) && found.length >= 2, found?.map((model) => model.id).join(', '))
const discoveryFailure = await captured.discovery.discover({ provider: 'lmstudio', baseURL: 'http://127.0.0.1:9/v1' }).then(() => null, (error) => error)
check('discovery reports a dead endpoint', discoveryFailure?.code === 'DISCOVERY_FAILED', discoveryFailure?.code ?? String(discoveryFailure))

// --- streaming ------------------------------------------------------------
const history = [
  { role: 'system', content: [{ type: 'text', text: 'You are a harness agent.' }] },
  { role: 'user', content: [{ type: 'text', text: 'Read the config, then TOOLTEST.' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool-call', callId: 'call_1', name: 'read', arguments: { file_path: 'config.yaml' } }] },
  { role: 'tool', toolCallId: 'call_1', isError: false, content: [{ type: 'text', text: 'timeout: 30' }] },
  { role: 'user', content: [{ type: 'text', text: 'TOOLTEST now' }] },
]
const tools = [{ name: 'get_weather', description: 'Report the weather for a city.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }]

const text = await collect({ provider: 'strata', model: 'iq3_s', messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }], maxTokens: 64 })
check('text stream: block lifecycle and finish', text[0]?.type === 'block-start' && text.at(-1)?.type === 'finish' && text.at(-1)?.reason?.kind === 'stop', text.map((chunk) => chunk.type).join(','))
check('text stream: deltas reassemble', text.find((chunk) => chunk.type === 'block-end')?.block?.text === 'pong')
check('text stream: usage forwarded', text.some((chunk) => chunk.type === 'usage' && chunk.usage?.totalTokens > 0))

const call = await collect({ provider: 'lemonade', model: 'Qwen3-0.6B-GGUF', messages: history, tools, maxTokens: 128 })
const endedCall = call.find((chunk) => chunk.type === 'block-end')?.block
check('tool call: split arguments reassembled', endedCall?.type === 'tool-call' && endedCall.arguments === '{"city":"Doha"}', JSON.stringify(endedCall))
check('tool call: finish reason is tool-calls', call.at(-1)?.reason?.kind === 'tool-calls', call.at(-1)?.reason?.kind)

const truncated = await collect({ provider: 'local-openai', model: 'fake-vision-11b', messages: [{ role: 'user', content: [{ type: 'text', text: 'HALFTOKEN' }] }] })
check('length finish surfaces', truncated.at(-1)?.reason?.kind === 'length', truncated.at(-1)?.reason?.kind)

const unknown = await adapter.listModels('nope').then(() => null, (error) => error)
check('unowned route rejected', unknown?.code === 'NO_ADAPTER', unknown?.code)

console.log(results.join('\n'))
console.log(failures ? `\n${failures} check(s) failed` : `\nall ${results.length} checks passed`)
process.exit(failures ? 1 : 0)
