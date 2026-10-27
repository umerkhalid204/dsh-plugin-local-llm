/**
 * Dev-only stand-in for `@deepseek-ai/schemastery`, installed into the
 * throwaway module tree by test/dry-run.mjs.
 *
 * It mirrors the names and shapes of the real v3 builder — `Schema` is a
 * function carrying lowercase factories, and a built node is a plain
 * descriptor — so that index.js calling a method that does not exist fails here
 * the way it would inside the Harness. A permissive proxy would hide exactly the
 * mistake this needs to catch. It validates nothing; validation lives in the
 * Loader.
 */

const node = (kind, extra) => ({ kind, ...extra })

const Schema = Object.assign(function Schema() {}, {
  any: () => node('any'),
  string: () => node('string'),
  number: () => node('number'),
  natural: () => node('number', { meta: { step: 1, min: 0 } }),
  boolean: () => node('boolean'),
  const: (value) => node('const', { value }),
  union: (list) => node('union', { of: list }),
  array: (inner) => node('array', { inner }),
  dict: (inner) => node('dict', { inner }),
  object: (properties) => node('object', { properties }),
})

export default Schema
