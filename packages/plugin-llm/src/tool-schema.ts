/**
 * Public surface of the zero-dependency tool argument algebra.
 *
 * Everything documented in design 02 is exported from this module: the closed
 * AST, fluent `t.*` builders, compile-time inference, definition validation,
 * zero-throw argument parsing, and the seven-dialect static normalizer.
 */

export { t } from './tool-builders.ts'
export type { NormalizeToolSchemasOptions } from './tool-normalize.ts'
export { normalizeToolSchemas } from './tool-normalize.ts'
export {
  formatToolValidationFeedback,
  parseToolArguments,
  validateToolDefinition,
} from './tool-parse.ts'
export type * from './tool-types.ts'
