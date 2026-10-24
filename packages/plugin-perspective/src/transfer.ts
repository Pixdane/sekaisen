/**
 * Delegate body activation.
 *
 * Moves a controlled body's location, shared values, owned children and
 * runtime visibility to another body of the same root mind. The entire
 * transfer runs inside one transaction savepoint; preflight validates both
 * bodies before the first write.
 */

import type { Result } from '@sekaisen/core'
import type {
  FieldLens,
  LeafSchemaNode,
  LeafValueTypeMap,
  SchemaTransaction,
  StructLens,
} from '@sekaisen/plugin-schema'
import { encodePathKey } from '@sekaisen/plugin-world'
import type { FieldNode, StructInstance } from './graph.ts'
import { PerspectiveGraph as Graph, pathsEqual } from './graph.ts'
import { attemptPerspective, expectSchema, fail } from './internal.ts'
import { fieldLensAt, structLensAt } from './lenses.ts'
import type { ActivateDelegateOptions, PerspectiveError } from './types.ts'
import { hasLinkRole } from './visibility.ts'

/**
 * Move a controlled body: location, followed children and shared fields.
 *
 * Both bodies must resolve through `'delegate'` links to the same root mind
 * (otherwise `delegate_root_mismatch`). The source's parent container is
 * transferred to the destination and cleared from the source; fields marked
 * `sharedAcrossDelegates` are copied (including references), and an absent
 * optional source value clears an optional destination or resets its default.
 * If a required destination cannot represent absence, activation is rejected
 * before changing either body's location, shared values or children.
 *
 * Location is declared state, not merely a physically present link. When the
 * source has no parent (an absent optional parent or no `'parent'` field at
 * all), an optional destination parent is cleared so stale coordinates never
 * survive; a required or defaulted destination parent cannot represent that
 * absence and is rejected before any write. A source parent declaration that
 * cannot be cleared (required or defaulted) is likewise rejected before the
 * first write. A destination without any `'parent'` declaration simply keeps
 * its existing shape because there is no location slot to write or clear.
 *
 * Children are found through the canonical `'parent'` role predicate, so implicit
 * `exclusiveRole: 'parent'` declarations behave exactly like explicit
 * `linkRoles`; they are re-parented. Their declared `'owner'` links migrate
 * only targets equal to the source body: all scalar owner fields and
 * `linkList` entries are covered, unrelated co-owners stay intact, and changed
 * lists are deduplicated in first-occurrence order after replacement.
 * Transferred children may be hidden with `concealTransferredChildren` or
 * per-path `visibilityOverrides`; other runtime metadata is preserved.
 *
 * Equal source and destination paths are a successful no-op, including for
 * required location links. Transfer options do not change any state in that
 * case. For distinct bodies, parent writes reuse the populated single-target
 * slot selected during preflight, or the first declaration if all are absent.
 *
 * Every write runs inside one transaction savepoint. Any later schema or
 * perspective failure rolls back all location, shared-value, child and
 * visibility metadata writes made by this activation while preserving writes
 * made earlier in the same transaction, then reports the failure as a
 * `Result` instead of leaving a partially activated body.
 */
export function activateDelegate(
  tx: SchemaTransaction,
  fromInstanceLens: StructLens,
  toInstanceLens: StructLens,
  options?: ActivateDelegateOptions,
): Result<void, PerspectiveError> {
  return attemptPerspective(() =>
    tx.atomic(() => {
      const fromPath = fromInstanceLens.path
      const toPath = toInstanceLens.path
      if (pathsEqual(fromPath, toPath)) return
      const graph = new Graph(tx)
      const fromRoot = graph.delegateRoot(fromPath)
      const toRoot = graph.delegateRoot(toPath)
      if (!pathsEqual(fromRoot, toRoot))
        fail({
          kind: 'delegate_root_mismatch',
          fromPath,
          toPath,
          fromRoot: encodePathKey(fromRoot),
          toRoot: encodePathKey(toRoot),
        })
      const from = graph.instance(fromPath)
      const to = graph.instance(toPath)
      if (from.kind === 'none' || to.kind === 'none') return
      const sourceFields = Object.entries(fromInstanceLens.schema.fields)
      for (const [name, spec] of sourceFields) {
        if (spec.metadata.sharedAcrossDelegates !== true) continue
        const targetSpec = toInstanceLens.schema.fields[name]
        if (targetSpec?.presence.mode !== 'required') continue
        const sourceField = from.value.fields.get(name)
        if (sourceField?.value.kind === 'some') continue
        fail({
          kind: 'schema_error',
          error: {
            kind: 'validation_failed',
            path: [...toPath, name],
            reason: 'cannot_delete_non_optional_node',
            detail: 'required shared field cannot represent the absent source value',
          },
        })
      }
      /*
       * Validate the whole location transfer before writing either body.
       * Both `fields` maps come from the Writer declarations, so declared
       * absence is distinguishable from a missing role without materializing
       * state, and physical presence decides only whether a value moves.
       */
      const fromParent = graph.singleRoleTarget(from.value, 'parent')
      const sourceParentField = parentField(from.value)
      const targetParentField = parentField(to.value)
      /** The source link that physically carries the location and its target. */
      const sourceLocation =
        fromParent.kind === 'some' && sourceParentField !== undefined
          ? { field: sourceParentField, target: fromParent.value }
          : undefined
      if (sourceLocation !== undefined) {
        if (sourceLocation.field.spec.presence.mode !== 'optional')
          fail({
            kind: 'schema_error',
            error: {
              kind: 'validation_failed',
              path: sourceLocation.field.path,
              reason: 'cannot_delete_non_optional_node',
              detail:
                'cannot clear a required or defaulted parent link while activating a delegate',
            },
          })
      } else if (targetParentField !== undefined) {
        if (targetParentField.spec.presence.mode !== 'optional')
          fail({
            kind: 'schema_error',
            error: {
              kind: 'validation_failed',
              path: targetParentField.path,
              reason: 'cannot_delete_non_optional_node',
              detail:
                'required or defaulted destination parent cannot represent an absent source location',
            },
          })
      }
      if (sourceLocation !== undefined) {
        if (targetParentField !== undefined)
          tx.set(fieldLensAt(tx, targetParentField.path), encodePathKey(sourceLocation.target))
        tx.delete(
          fieldLensAt(tx, sourceLocation.field.path) as FieldLens<
            LeafSchemaNode & { readonly presence: { readonly mode: 'optional' } }
          >,
        )
      } else if (targetParentField !== undefined) {
        tx.delete(
          fieldLensAt(tx, targetParentField.path) as FieldLens<
            LeafSchemaNode & { readonly presence: { readonly mode: 'optional' } }
          >,
        )
      }
      for (const [name, spec] of sourceFields) {
        if (spec.metadata.sharedAcrossDelegates !== true) continue
        const targetSpec = toInstanceLens.schema.fields[name]
        if (targetSpec === undefined) continue
        const sourceField = from.value.fields.get(name)
        const targetLens = fieldLensAt(tx, [...toPath, name])
        if (sourceField !== undefined && sourceField.value.kind === 'some') {
          const value = expectSchema(tx.get(fieldLensAt(tx, sourceField.path)))
          if (value.kind === 'some') tx.set(targetLens, value.value)
          continue
        }
        /*
         * Absence is shared state too: when the source no longer carries an
         * optional shared value, a stale copy on the destination must be
         * cleared instead of silently preserved. Required destinations were
         * rejected before any transfer; defaulted destinations reset to their
         * declaration's default rather than retaining a previous body's value.
         */
        if (targetSpec.presence.mode === 'optional')
          tx.delete(
            targetLens as FieldLens<
              LeafSchemaNode & { readonly presence: { readonly mode: 'optional' } }
            >,
          )
        else if (targetSpec.nodeKind === 'leaf' && targetSpec.presence.mode === 'defaulted')
          tx.set(
            targetLens,
            // Registered leaf defaults are validated against their value kind.
            targetSpec.presence.defaultValue as LeafValueTypeMap[LeafSchemaNode['valueKind']],
          )
      }
      const children = graph.childrenOf(fromPath)
      if (children.length === 0) return
      const fromKey = encodePathKey(fromPath)
      const toKey = encodePathKey(toPath)
      for (const child of children) {
        const childInstance = graph.instance(child)
        if (childInstance.kind === 'none') continue
        const childLens = structLensAt(tx, child)
        const movedParent = parentField(childInstance.value)
        if (movedParent !== undefined) tx.set(fieldLensAt(tx, movedParent.path), toKey)
        transferChildOwnership(tx, childInstance.value, fromKey, toKey, movedParent)
        const override = options?.visibilityOverrides?.[encodePathKey(child)]
        if (override !== undefined) tx.setInstanceMeta(childLens, { visibility: override })
        else if (options?.concealTransferredChildren === true)
          tx.setInstanceMeta(childLens, { visibility: 'self' })
      }
    }),
  )
}

/**
 * Select the exclusive parent slot, preferring a populated declaration.
 *
 * Writer-backed fields retain optional declarations without inventing values.
 * If every single-target parent is absent, the first declaration supplies the
 * location slot. Ownership must not use this policy: it is a multi-target
 * relation whose independent scalar/list edges are migrated separately.
 */
function parentField(instance: StructInstance): FieldNode | undefined {
  let absent: FieldNode | undefined
  for (const field of instance.fields.values()) {
    if (field.spec.valueKind !== 'str' || !hasLinkRole(field.spec, 'parent')) continue
    if (field.value.kind === 'some') return field
    absent ??= field
  }
  return absent
}

/**
 * Move only this carried child's declared owner edges naming the source body.
 *
 * Every scalar field is considered independently; an absent field or an edge
 * to a different co-owner is left untouched. A list is rewritten only if it
 * contains `fromKey`, then deduplicated in stable first-occurrence order after
 * replacement. Ownership implied by delegate/edge roles is not retargeted.
 * A combined parent/owner slot has already moved with the parent and is
 * skipped to avoid a redundant write. All writes retain leaf metadata and
 * participate in the enclosing activation savepoint.
 *
 * @param tx - Current atomic activation draft.
 * @param instance - Child snapshot captured before its parent was rewritten.
 * @param fromKey - Encoded source body path, not its delegation root.
 * @param toKey - Encoded destination body path.
 * @param movedParent - Parent slot already rewritten, possibly also an owner.
 */
function transferChildOwnership(
  tx: SchemaTransaction,
  instance: StructInstance,
  fromKey: string,
  toKey: string,
  movedParent: FieldNode | undefined,
): void {
  for (const field of instance.fields.values()) {
    if (field === movedParent || !hasLinkRole(field.spec, 'owner')) continue
    if (field.value.kind === 'none') continue
    const value = field.value.value
    if (field.spec.valueKind === 'str') {
      if (value === fromKey) tx.set(fieldLensAt(tx, field.path), toKey)
      continue
    }
    if (field.spec.valueKind !== 'list:str' || !Array.isArray(value) || !value.includes(fromKey))
      continue
    const seen = new Set<string>()
    const owners: string[] = []
    // Writer inspection validates the declared list:str before this snapshot.
    for (const owner of value as readonly string[]) {
      const target = owner === fromKey ? toKey : owner
      if (seen.has(target)) continue
      seen.add(target)
      owners.push(target)
    }
    tx.set(fieldLensAt(tx, field.path), owners)
  }
}
