/**
 * Dev-only stand-in for `@deepseek-ai/dsh-llm`, installed into the throwaway
 * module tree by test/dry-run.mjs. The real package is not reachable from a
 * plugin installed into a profile, and reproducing its names here keeps the dry
 * run honest about which half of index.js is being exercised.
 *
 * The base class reproduces the pieces the `llm` service expects an adapter to
 * carry, including `prepareCall`, which the real adapter normally inherits.
 */

export class LlmError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.name = 'LlmError'
    this.code = code
  }
}

export class LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: provider }
  }

  providerRetryPolicy(_provider) {
    return undefined
  }

  imageRequestPricing(_provider, _model) {
    return undefined
  }

  imageRequestTarget(_provider, _model, image) {
    return { width: image?.width ?? 0, height: image?.height ?? 0, maxBytes: image?.bytes ?? 0 }
  }

  listModels(_provider) {
    return Promise.resolve([])
  }

  resolveModel(provider, model, _signal) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  async * stream(_options) {
    throw new LlmError('this adapter implements no stream()', 'NO_ADAPTER')
  }
}

/** Identifies a Harness request to a provider; here only a marker for tests. */
export function attributionHeaders() {
  return { 'x-user-agent': 'dsh-dev-shim' }
}
