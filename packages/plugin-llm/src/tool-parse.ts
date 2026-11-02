import type { Result } from '@sekaisen/core'
import { err, InvariantError, ok } from '@sekaisen/core'
import { assertToolSchema, decodeNodeValue, validateSchemaNode } from './tool-decode.ts'
import {
  formatIssues,
  isRecord,
  readOwn,
  rootTypeName,
  wellFormedPreview,
} from './tool-internal.ts'
import type {
  InferToolOutput,
  NeutralToolDefinition,
  ToolObjectNode,
  ToolValidationError,
} from './tool-types.ts'

/** OpenAI/Anthropic-compatible tool name pattern and length limit. */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Fully validate a neutral tool definition before any wire normalization.
 *
 * Handwritten ASTs are supported: every node invariant (modifier flags,
 * constraint ordering, forbidden optional/default children, discriminator
 * structure, default-value conformance, cycles) is checked here.
 */
export function validateToolDefinition(tool: NeutralToolDefinition): Result<void, string> {
  const definition: unknown = tool
  if (!isRecord(definition)) return err('tool definition must be an object')

  const name = readOwn(definition, 'name')
  if (!name.present || typeof name.value !== 'string' || name.value.length === 0) {
    return err('tool.name must be a non-empty string')
  }
  if (!name.value.isWellFormed()) return err('tool.name must be well-formed Unicode')
  if (!TOOL_NAME_PATTERN.test(name.value)) {
    return err(
      `tool.name ${JSON.stringify(name.value)} must match ${TOOL_NAME_PATTERN.source} (1-64 ASCII letters, digits, "_" or "-")`,
    )
  }

  const description = readOwn(definition, 'description')
  if (!description.present || typeof description.value !== 'string') {
    return err('tool.description must be a string')
  }
  if (!description.value.isWellFormed()) {
    return err('tool.description must be well-formed Unicode')
  }

  const parameters = readOwn(definition, 'parameters')
  if (!parameters.present || !isRecord(parameters.value)) {
    return err('tool.parameters must be a schema node object')
  }
  if (parameters.value.kind !== 'obj') {
    return err('tool.parameters must be an object schema node (t.obj)')
  }
  if (parameters.value.isNullable === true) {
    return err('tool.parameters may not be nullable')
  }
  if (parameters.value.isOptional === true || parameters.value.hasDefault === true) {
    return err('tool.parameters must be a required object schema without a default')
  }
  const structureError = validateSchemaNode(parameters.value, ['parameters'])
  if (structureError !== null) return err(structureError)
  return ok(undefined)
}

/**
 * Parse raw model-produced tool arguments with zero exceptions for bad input.
 *
 * An invalid schema is a program defect and throws `InvariantError`; malformed
 * JSON and value mismatches return `Err(ToolValidationError)`.
 */
export function parseToolArguments<S extends ToolObjectNode>(
  schema: S,
  rawArgumentsJson: string,
): Result<InferToolOutput<S>, ToolValidationError> {
  if (typeof rawArgumentsJson !== 'string') {
    throw new InvariantError('parseToolArguments expects the raw JSON string produced by the model')
  }
  assertToolSchema(schema, ['schema'])
  const rootKind: string = schema.kind
  if (rootKind !== 'obj') {
    throw new InvariantError('parseToolArguments requires an object root schema')
  }
  if (schema.isNullable) {
    throw new InvariantError('parseToolArguments requires a non-nullable root schema')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawArgumentsJson)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message.toWellFormed() : 'invalid JSON'
    return err({
      kind: 'malformed_json',
      rawPreview: wellFormedPreview(rawArgumentsJson, 160),
      detail,
    })
  }

  if (!isRecord(parsed)) {
    return err({ kind: 'root_not_object', receivedType: rootTypeName(parsed) })
  }

  const decoded = decodeNodeValue(schema, parsed, [])
  if (!decoded.ok) return err({ kind: 'schema_mismatch', issues: decoded.issues })
  return ok(decoded.value as InferToolOutput<S>)
}

/** Render a validation error as a single model-facing correction message. */
export function formatToolValidationFeedback(error: ToolValidationError): string {
  switch (error.kind) {
    case 'malformed_json':
      return [
        `Tool arguments were not valid JSON (${error.detail}).`,
        'Re-emit a single JSON object that matches the tool schema.',
        `Raw arguments preview: ${error.rawPreview}`,
      ].join(' ')
    case 'root_not_object':
      return [
        `Tool arguments must be a single JSON object, received ${error.receivedType}.`,
        'Re-emit a JSON object that matches the tool schema.',
      ].join(' ')
    case 'schema_mismatch':
      return ['Tool arguments did not match the tool schema:', formatIssues(error.issues)].join(
        '\n',
      )
    default:
      return 'Tool arguments did not match the tool schema.'
  }
}
