/** Canonical plain-record guard for this package's untrusted SDK boundaries. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrows to the record itself, or `undefined` when the value is not one. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}
