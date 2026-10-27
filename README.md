# dsh-plugin-local-llm

Run the agent on models **served by your own machine**. The plugin registers
local inference engines as ordinary Harness provider routes, so a local model is
picked in the composer's model selector exactly like a hosted one, and each
engine is declared as a configurable third-party provider.

## Engines it knows

| Provider id   | Default endpoint                  | Catalog dialect                                                            |
| ------------- | --------------------------------- | -------------------------------------------------------------------------- |
| `lmstudio`    | `http://127.0.0.1:1234/v1`        | LM Studio (`/api/v0/models` enrichment: load state, quantization, vision)  |
| `ollama`      | `http://127.0.0.1:11434/v1`       | Ollama (`/api/tags` plus per-model sizes and quantization)                 |
| `strata`      | `http://127.0.0.1:8080/v1`        | [Strata](https://github.com/Niko1221/Strata) (packs named by quantization) |
| `lemonade`    | `http://127.0.0.1:13305/v1`       | [Lemonade Server](https://lemonade-server.ai/) (labels: `chat`, `vision`, `tool-calling`, `reasoning`) |
| `local-openai`| `http://127.0.0.1:8081/v1`        | llama.cpp server, vLLM, LocalAI, TGI, anything OpenAI-compatible — **off by default** so two engines never fight over one port |

All five speak OpenAI-compatible `/v1/chat/completions`; what differs is how a
model list is described. Strata's listing is not a documented contract, so
`providers.strata.models` declares the packs you serve (names and context
windows), and that declaration fills whatever the server leaves out.

## Install

Build a package from this checkout and install that, rather than the directory:

```sh
npm pack --pack-destination dist     # -> dist/dsh-plugin-local-llm-<version>.tgz
```

Then in the Harness: **Settings → Plugins → Install bundle**, and point it at the
`.tgz`. A bundle is a patch layer over the Loader entry list, so if you prefer
declaring it, add one row to `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: local-llm
      name: 'dsh-plugin-local-llm'
```

The row id `local-llm` is what its config, settings namespace and `/local-llm/api`
routes are keyed by; `name` is the package specifier, whose version comes from
what you installed. Installing a **package** is the supported layout — only then
can the plugin resolve its own dependencies, which is what gives it a settings
form (see below).

## Use it

```
local_models scan                       # what is up, and what it can serve
local_models use provider=strata model=iq3_s
local_models ping provider=lemonade model=Qwen3-0.6B-GGUF
local_models settings                   # can a settings surface edit these engines?
```

`use` writes the profile's default model, so new sessions start on that route.
Any registered route is accepted — including one owned by another adapter.

## Settings: what it takes to appear on the Models page

Being registered is not enough. A provider shows up as a card only when three
things line up, and each one cost a debugging round to learn:

1. **The directory entry.** `providers.<id>` in this row's config is the single
   source of truth for an engine: endpoint, the `baseURLEnv` names allowed to
   override it, `apiKey`, `enabled`, and a hand-declared `models` catalog. The
   plugin declares each engine in the configurable-provider directory with
   `settingsNs: local-llm` and `settingsPath: ["providers", <id>]` — the address
   a provider card reads and writes.
2. **A described settings namespace.** `settings.describe()` enumerates *active*
   plugin entries whose `Config` is a schemastery instance, so the schema has to
   be importable from the **installed** package — see the install layouts below.
   The row also calls `settings.configure({ auto: false })`, because the Models
   page renders its card; without that you would get a duplicate auto-generated
   page beside it.
3. **A `meta.volatile` marker.** This is the one that is easy to miss: the
   settings service builds a form from *only* the fields whose nearest schema
   node carries `meta.volatile`, returns no descriptor at all when nothing is
   marked, and `mutate` refuses any write path that does not lie beneath a
   volatile node. `providers` is marked, which is also what lets an endpoint be
   repointed without remounting the row — so `index.js` re-reads the live config
   before scanning, discovering or answering the tool. The plain knobs
   (`probeTimeoutMs`, `scanTtlMs`, `maxTokens`, the default `apiKey`) are
   deliberately *not* volatile: they are honoured at activation, and a form would
   imply otherwise.

schemastery v3 has no factory for a marker, but a node's `meta` is a live object
on the instance a factory returns, so it is attached by mutation. Compose with the
factories rather than handing the constructor a raw node tree: `settings` calls
`toJSON()` on every child it recurses into, and a hand-written tree leaves bare
nodes sitting in `dict`, which throws inside `describe()` and takes the whole
settings document down with it.

Two install layouts behave differently:

- **Installed as a package** (tarball or registry) — the copy lives at
  `~/.dsh/profiles/<profile>/node_modules/dsh-plugin-local-llm`, where its
  declared dependencies resolve. This is the layout you want:
  `npm pack --pack-destination ..\pkg-out`, then install the `.tgz`.
- **Linked from a source checkout** (`install_bundle` pointed at the directory) —
  Node resolves bare imports from the checkout, where no `@deepseek-ai/*`
  packages exist. The plugin still activates because `index.js` treats the
  Harness modules as optional and falls back to `vendor/llm-contract.js`, but
  `Config` stays undefined, so no generated fields appear and endpoint edits go
  through the profile patch (`~/.dsh/profiles/<profile>/cordis.patch.yml`).

Both were observed in one profile: linked, the engines were claimed, scanned,
pinged and listed in the provider directory while `Config` reported `absent`;
packed, the same sources resolved the dependency.

## Provider ids are contested territory

Provider ids are global, and both the adapter registry and the configurable-provider
directory are all-or-nothing registrations. So this plugin claims an id only when
nothing else owns it and reports the rest:

```
served by local-llm: lmstudio, ollama, lemonade | left to another owner: strata@http://127.0.0.1:8080/v1
```

If you declared `strata` yourself (for instance as a pi-ai provider), that owner
keeps serving it — which is what keeps an existing brain working — and this
plugin still scans, pings and selects that endpoint. To hand the route to this
engine, delete the other provider declaration and reload the profile.

## Development notes

- `node --check index.js`; ESM, no build step.
- `node test/dry-run.mjs` runs 30 offline checks, including that `providers` is a
  dict marked volatile, that an engine api key is declared secret, and that the
  staged config reaches the plugin as a reactive cell (so a regression in reading
  through one fails loudly instead of silently falling back to defaults). It stages a throwaway tree
  first: the runtime sources are copied to `test/shim/pkg` and the stand-ins in
  `test/shims/` are placed at `test/shim/node_modules/@deepseek-ai/{dsh-llm,schemastery}`,
  so the copy's bare imports resolve there and nothing in the package or the
  workspace gains a `node_modules` (`test/shim/` is gitignored). That staging
  matters: a stand-in inside the checkout's own module chain would satisfy a
  linked install and silently replace the real Harness module.
- `test/shims/schemastery.js` mirrors the real v3 surface — `Schema` is a callable
  class, the factories are lowercase statics that nest rather than chain, and a
  node's `meta` is a live object you mutate — so calling a builder method that
  does not exist fails offline rather than at activation.
- Five fake servers, one per catalog dialect, back the suite and can be run by
  hand: `PORT=1234 ENGINE=lmstudio node test/fake-openai-server.mjs`, with
  `ENGINE=lmstudio|ollama|strata|lemonade|openai`. They also answer
  `/v1/chat/completions`: a prompt containing `TOOLTEST` streams a split tool
  call, `HALFTOKEN` ends with finish_reason `length`.
- Host code hot-reloads on a plugin off/on toggle. `package.json` and
  `cordis.patch.yml` changes need a reinstall.
- There is no Client half: no composer-dock line and no chip. Local models appear
  only in the model selector and in Settings.

## Configuration reference

```yaml
- insert:
    - id: local-llm
      name: 'dsh-plugin-local-llm'
      config:
        probeTimeoutMs: 2500      # per listing request
        scanTtlMs: 15000          # reuse a scan for this long
        maxTokens: 0              # 0 = leave the cap to the server
        apiKey: 'dsh-local'       # default bearer
        providers:
          lemonade:
            baseURL: 'http://192.168.1.20:13305/v1'
            apiKey: 'set when that server exports LEMONADE_API_KEY'
          local-openai:
            enabled: true
            baseURL: 'http://127.0.0.1:8080/v1'
```

MIT licensed; see [LICENSE](LICENSE).
