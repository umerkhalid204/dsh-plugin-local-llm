/**
 * Local stand-ins for the two pieces this plugin otherwise imports from the
 * Harness, so it activates in every install layout.
 *
 * Why this file exists: Node resolves bare specifiers from the *real* path of
 * the importing file. A plugin installed from a package sits in the profile's
 * `node_modules`, where the `@deepseek-ai/*` siblings are visible. A plugin
 * linked from a source checkout (the usual development layout) resolves from
 * that checkout instead, where they are not — the import fails and the row
 * does not activate. The adapter is therefore written against this contract
 * and upgraded to the real classes when they are importable.
 *
 * Only `prepareCall`/`stream`/`listModels`/`resolveModel`/`providerInfo` are
 * load-bearing for the `llm` service; `prepareCall` is the piece the base class
 * normally supplies, reproduced here exactly as the service expects it.
 */

export class LocalLlmError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.name = 'LlmError'
    this.code = code
  }
}

export class LocalLlmAdapter {
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
    throw new LocalLlmError('this adapter implements no stream()', 'NO_ADAPTER')
  }
}

/**
 * Attribution headers identify a Harness request to a provider. A local server
 * on your own machine has no use for them, so their absence changes nothing;
 * when the real module is importable its implementation is used instead.
 */
export function noAttributionHeaders() {
  return {}
}
