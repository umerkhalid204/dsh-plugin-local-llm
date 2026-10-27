/**
 * Dev-only stand-in for `@deepseek-ai/schemastery`, installed into the
 * throwaway module tree by test/dry-run.mjs.
 *
 * It mirrors the real v3 shape closely enough to be a trap for the mistakes that
 * matter: `Schema` is a callable class, an instance exposes its node fields
 * directly (`type`, `meta`, `dict`, `inner`, `list`), the constructor accepts a
 * bare node tree — which is how a `meta.volatile` marker gets attached, since no
 * factory sets one — `toJSON()` returns the `{ uid, refs }` registry form, and
 * the lowercase factories are the only builders that exist, so calling anything
 * else throws here the way it would at activation inside the Harness. It
 * validates nothing; validation lives in the Loader.
 */
export default class Schema {
  constructor(node) {
    this.uid = 0
    this.refs = { 0: node }
    Object.assign(this, node)
  }

  toJSON() {
    return { uid: this.uid, refs: this.refs }
  }

  static any = () => new Schema({ type: 'any', meta: {} })
  static string = () => new Schema({ type: 'string', meta: {} })
  static number = () => new Schema({ type: 'number', meta: {} })
  static natural = () => new Schema({ type: 'number', meta: { step: 1, min: 0 } })
  static boolean = () => new Schema({ type: 'boolean', meta: {} })
  static const = (value) => new Schema({ type: 'const', value, meta: {} })
  static union = (list) => new Schema({ type: 'union', list: list.map((entry) => entry.refs[entry.uid]), meta: {} })
  static array = (inner) => new Schema({ type: 'array', inner: inner.refs[inner.uid], meta: { default: [] } })
  static dict = (inner) => new Schema({ type: 'dict', inner: inner.refs[inner.uid], meta: { default: {} } })
  static object = (dict) => {
    const nodes = {}
    for (const [key, value] of Object.entries(dict)) nodes[key] = value.refs[value.uid]
    return new Schema({ type: 'object', dict: nodes, meta: { default: {} } })
  }
}
