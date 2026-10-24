import { afterEach, describe, expect, test } from 'bun:test'
import { NONE, some } from '@sekaisen/core'
import { s } from '@sekaisen/plugin-schema'
import { encodePathKey } from '@sekaisen/plugin-world'
import { PerspectiveFixture, unwrap } from './perspective-fixture'

const fixtures: PerspectiveFixture[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.driver.close()
})

/** Give each metadata transition its own real World/Schema/Perspective history. */
function setup() {
  const fixture = new PerspectiveFixture()
  fixtures.push(fixture)
  return fixture
}

describe('perspective audited runtime field visibility', () => {
  test('runtime ref blocks live projection, inspection, memory, corpus and retelling but explicit leaf knowledge works', () => {
    const f = setup()
    f.seed('room', 'room')
    const target = f.at('note').$.text.path
    const hidden = f.commit('hide a statically public field before anyone learns it', (tx) => {
      tx.setWithMeta(f.at('note').$.text, 'RUNTIME_REF_SECRET_1', { visibility: 'ref' })
      unwrap(f.perspective.grantKnowledge(tx, f.at('bob'), f.at('note').path))
      unwrap(f.perspective.syncScope(tx, f.at('room')))
      expect(
        f.perspective.propagateKnowledge(tx, f.at('alice'), f.at('bob'), target),
      ).toMatchObject({ ok: false, error: { kind: 'not_authorized' } })
    })
    for (const observer of [f.at('alice'), f.at('bob')]) {
      expect(f.perspective.inspect(hidden.id, observer, [target])).toMatchObject({
        ok: false,
        error: { kind: 'not_authorized' },
      })
      expect(JSON.stringify(unwrap(f.perspective.projectView(hidden.id, observer)))).not.toContain(
        'RUNTIME_REF_SECRET_1',
      )
      expect(
        unwrap(f.perspective.listSearchableCorpus(hidden.id, observer)).find(
          (entry) => encodePathKey(entry.path) === encodePathKey(target),
        ),
      ).toBeUndefined()
    }
    const publicView = unwrap(f.perspective.projectScopePublic(hidden.id, f.at('room')))
    expect(publicView.instances[f.key('note')]?.fields.text).toBeUndefined()
    const learned = f.commit('explicitly teach only Alice the hidden leaf', (tx) => {
      unwrap(f.perspective.grantKnowledge(tx, f.at('alice'), target))
    })
    expect(unwrap(f.perspective.inspect(learned.id, f.at('alice'), [target]))[0]).toMatchObject({
      value: 'RUNTIME_REF_SECRET_1',
      sourceKind: 'observed_claim',
      at: some(learned.id),
    })
    expect(f.perspective.inspect(learned.id, f.at('bob'), [target])).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
  })

  test('runtime self grants only the owner live access and retelling preserves a private historical snapshot', () => {
    const f = setup()
    f.seed('room', 'room')
    const target = f.at('box').$.text.path
    const privateState = f.commit('make an otherwise public field owner-private', (tx) => {
      tx.set(f.at('box'), { name: 'Box', parent: f.key('room'), owner: f.key('alice') })
      tx.setWithMeta(f.at('box').$.text, 'an owner-private fact', { visibility: 'self' })
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    expect(
      unwrap(f.perspective.inspect(privateState.id, f.at('alice'), [target]))[0],
    ).toMatchObject({ value: 'an owner-private fact', sourceKind: 'self_owned', at: NONE })
    expect(f.perspective.inspect(privateState.id, f.at('bob'), [target])).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
    const relayed = f.commit('the owner privately tells Bob', (tx) => {
      unwrap(f.perspective.propagateKnowledge(tx, f.at('alice'), f.at('bob'), target))
    })
    const changed = f.commit('change the private state without telling Bob', (tx) => {
      tx.set(f.at('alice').$.parent, f.key('remote'))
      tx.set(f.at('box').$.text, 'a later owner-private fact')
    })
    expect(unwrap(f.perspective.inspect(changed.id, f.at('alice'), [target]))[0]).toMatchObject({
      value: 'a later owner-private fact',
      sourceKind: 'self_owned',
    })
    expect(unwrap(f.perspective.inspect(changed.id, f.at('bob'), [target]))[0]).toMatchObject({
      value: 'an owner-private fact',
      sourceKind: 'observed_claim',
      at: some(relayed.id),
      acquiredAt: some(relayed.id),
      coWitnesses: [],
    })
  })

  test('runtime surface reveals a statically ref field and later concealment preserves only the learned old value', () => {
    const f = setup()
    f.seed('room', 'room')
    const target = f.at('note').$.hiddenText.path
    const revealed = f.commit('temporarily reveal the hidden inscription', (tx) => {
      tx.setWithMeta(f.at('note').$.hiddenText, 'the publicly learned inscription', {
        visibility: 'surface',
      })
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    expect(unwrap(f.perspective.inspect(revealed.id, f.at('bob'), [target]))[0]).toMatchObject({
      value: 'the publicly learned inscription',
      sourceKind: 'direct_scope',
    })
    expect(
      unwrap(f.perspective.projectScopePublic(revealed.id, f.at('room'))).instances[f.key('note')]
        ?.fields.hiddenText?.value,
    ).toBe('the publicly learned inscription')
    const concealed = f.commit('hide a new inscription from the same observers', (tx) => {
      tx.setWithMeta(f.at('note').$.hiddenText, 'UNLEARNED_REPLACEMENT_2', { visibility: 'ref' })
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    expect(unwrap(f.perspective.inspect(concealed.id, f.at('bob'), [target]))[0]).toMatchObject({
      value: 'the publicly learned inscription',
      sourceKind: 'observed_claim',
      at: some(revealed.id),
      acquiredAt: some(revealed.id),
    })
    expect(
      JSON.stringify(unwrap(f.perspective.projectView(concealed.id, f.at('bob')))),
    ).not.toContain('UNLEARNED_REPLACEMENT_2')
    expect(
      unwrap(f.perspective.listSearchableCorpus(concealed.id, f.at('bob'))).find(
        (entry) => encodePathKey(entry.path) === encodePathKey(target),
      ),
    ).toMatchObject({ text: 'the publicly learned inscription', factCommitId: revealed.id })
  })

  test('absent or invalid runtime overrides fall back to the declaration instead of granting surface access', () => {
    const f = setup()
    f.seed()
    const fallback = f.commit(
      'store invalid visibility metadata without changing its declaration',
      (tx) => {
        tx.setWithMeta(f.at('note').$.hiddenText, 'STATIC_REF_SECRET_3', {
          visibility: 'unsupported',
        })
        tx.setWithMeta(f.at('note').$.text, 'the default public surface', { visibility: 7 })
      },
    )
    expect(
      f.perspective.inspect(fallback.id, f.at('alice'), [f.at('note').$.hiddenText.path]),
    ).toMatchObject({ ok: false, error: { kind: 'not_authorized' } })
    expect(
      unwrap(f.perspective.inspect(fallback.id, f.at('alice'), [f.at('note').$.text.path]))[0],
    ).toMatchObject({ value: 'the default public surface', sourceKind: 'direct_scope' })
    const removed = f.commit('remove a temporary override before any refresh', (tx) => {
      tx.setWithMeta(f.at('note').$.hiddenText, 'STATIC_REF_SECRET_4', { visibility: 'surface' })
      tx.setWithMeta(f.at('note').$.hiddenText, 'STATIC_REF_SECRET_4', { visibility: null })
    })
    expect(
      f.perspective.inspect(removed.id, f.at('alice'), [f.at('note').$.hiddenText.path]),
    ).toMatchObject({ ok: false, error: { kind: 'not_authorized' } })
  })

  test('custom leaf runtime visibility overrides its stored leaf declaration on the same physical path', () => {
    const f = setup()
    const items = unwrap(
      f.schema.define(
        ['auditCustomItems'],
        s.map(
          s
            .struct({
              parent: s
                .link({ targetRoots: [['entities']], onDelete: 'unlink' })
                .optional()
                .meta({ linkRoles: ['parent'], visibility: 'ref' }),
            })
            .extensible(),
        ),
      ),
    )
    f.seed()
    const item = items.at('item')
    const publicPath = item.custom('revealed', s.str()).path
    const secretPath = item.custom('hidden', s.str()).path
    const seen = f.commit('apply runtime overrides to custom leaves', (tx) => {
      tx.set(item, { parent: f.key('room') })
      tx.defineCustom(
        item,
        'revealed',
        s.str().meta({ visibility: 'ref' }),
        'a revealed custom fact',
        { visibility: 'surface' },
      )
      tx.defineCustom(item, 'hidden', s.str(), 'CUSTOM_RUNTIME_SECRET_5', { visibility: 'ref' })
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    expect(unwrap(f.perspective.inspect(seen.id, f.at('alice'), [publicPath]))[0]).toMatchObject({
      value: 'a revealed custom fact',
      sourceKind: 'direct_scope',
    })
    expect(f.perspective.inspect(seen.id, f.at('alice'), [secretPath])).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized' },
    })
    const left = f.commit('leave the custom field scene', (tx) => {
      tx.set(f.at('alice').$.parent, f.key('remote'))
    })
    expect(unwrap(f.perspective.inspect(left.id, f.at('alice'), [publicPath]))[0]).toMatchObject({
      value: 'a revealed custom fact',
      sourceKind: 'observed_claim',
      at: some(seen.id),
    })
  })
})

describe('projection preserves every legal Schema field name', () => {
  test('declared and custom prototype-like names survive public and remembered JSON projections', () => {
    const f = setup()
    const parent = s
      .link({ targetRoots: [['entities']], exclusiveRole: 'parent', acyclic: true })
      .optional()
      .meta({ visibility: 'ref' })
    const formal = unwrap(
      f.schema.define(
        ['namedArtifacts'],
        s.map(
          s.struct({
            ['__proto__']: s.str().desc('formal prototype inscription'),
            constructor: s.str().desc('formal constructor inscription'),
            toString: s.str().desc('formal string inscription'),
            parent,
          }),
        ),
      ),
    )
    const custom = unwrap(
      f.schema.define(['customArtifacts'], s.map(s.struct({ parent }).extensible())),
    )
    f.seed()
    const observed = f.commit('observe legal names that also exist on Object.prototype', (tx) => {
      tx.set(formal.at('tablet'), {
        ['__proto__']: 'FORMAL_PROTO_VALUE',
        constructor: 'FORMAL_CONSTRUCTOR_VALUE',
        toString: 'FORMAL_STRING_VALUE',
        parent: f.key('room'),
      })
      tx.set(custom.at('tablet'), { parent: f.key('room') })
      tx.defineCustom(
        custom.at('tablet'),
        '__proto__',
        s.str().desc('custom prototype inscription'),
        'CUSTOM_PROTO_VALUE',
      )
      tx.defineCustom(custom.at('tablet'), 'constructor', s.str(), 'CUSTOM_CONSTRUCTOR_VALUE')
      tx.defineCustom(custom.at('tablet'), 'toString', s.str(), 'CUSTOM_STRING_VALUE')
      unwrap(f.perspective.syncScope(tx, f.at('room')))
    })
    const formalKey = encodePathKey(formal.at('tablet').path)
    const customKey = encodePathKey(custom.at('tablet').path)
    const projected = unwrap(f.perspective.projectView(observed.id, f.at('alice')))
    const publicView = unwrap(f.perspective.projectScopePublic(observed.id, f.at('room')))
    for (const instances of [projected.mergedInstances, publicView.instances]) {
      expect(Object.hasOwn(instances[formalKey]!.fields, '__proto__')).toBe(true)
      expect(Reflect.get(instances[formalKey]!.fields, '__proto__')?.value).toBe(
        'FORMAL_PROTO_VALUE',
      )
      expect(Reflect.get(instances[formalKey]!.fields, 'constructor')?.value).toBe(
        'FORMAL_CONSTRUCTOR_VALUE',
      )
      expect(Reflect.get(instances[formalKey]!.fields, 'toString')?.value).toBe(
        'FORMAL_STRING_VALUE',
      )
      expect(Object.hasOwn(instances[customKey]!.customFields, '__proto__')).toBe(true)
      expect(Reflect.get(instances[customKey]!.customFields, '__proto__')?.value).toBe(
        'CUSTOM_PROTO_VALUE',
      )
      expect(Reflect.get(instances[customKey]!.customFields, 'constructor')?.value).toBe(
        'CUSTOM_CONSTRUCTOR_VALUE',
      )
      expect(Reflect.get(instances[customKey]!.customFields, 'toString')?.value).toBe(
        'CUSTOM_STRING_VALUE',
      )
    }
    for (const schemas of [projected.schemas, publicView.schemas]) {
      expect(Object.hasOwn(schemas[formalKey]!.fields, '__proto__')).toBe(true)
      expect(Reflect.get(schemas[formalKey]!.fields, '__proto__')?.description).toBe(
        'formal prototype inscription',
      )
      expect(Object.hasOwn(schemas[customKey]!.fields, '__proto__')).toBe(true)
      expect(Reflect.get(schemas[customKey]!.fields, '__proto__')?.description).toBe(
        'custom prototype inscription',
      )
    }
    const wire = JSON.parse(JSON.stringify(projected))
    expect(Reflect.get(wire.mergedInstances[formalKey].fields, '__proto__').value).toBe(
      'FORMAL_PROTO_VALUE',
    )
    expect(Reflect.get(wire.mergedInstances[customKey].customFields, '__proto__').value).toBe(
      'CUSTOM_PROTO_VALUE',
    )

    const left = f.commit('leave both artifacts outside perception', (tx) => {
      tx.set(f.at('alice').$.parent, f.key('remote'))
    })
    const remembered = unwrap(f.perspective.projectView(left.id, f.at('alice')))
    const deleted = f.commit('delete the unobserved artifacts', (tx) => {
      tx.delete(formal.at('tablet'))
      tx.delete(custom.at('tablet'))
    })
    const historical = unwrap(f.perspective.projectView(deleted.id, f.at('alice')))
    expect(historical).toEqual(remembered)
    expect(
      Reflect.get(historical.privateView.offSceneKnownInstances[formalKey]!.fields, '__proto__'),
    ).toMatchObject({
      value: 'FORMAL_PROTO_VALUE',
      sourceKind: 'observed_claim',
      at: some(observed.id),
    })
    expect(
      Reflect.get(
        historical.privateView.offSceneKnownInstances[customKey]!.customFields,
        '__proto__',
      ),
    ).toMatchObject({
      value: 'CUSTOM_PROTO_VALUE',
      sourceKind: 'observed_claim',
      at: some(observed.id),
    })
    expect(
      Reflect.get(historical.privateView.schemas[formalKey]!.fields, '__proto__')?.description,
    ).toBe('formal prototype inscription')
    expect(
      Reflect.get(historical.privateView.schemas[customKey]!.fields, '__proto__')?.description,
    ).toBe('custom prototype inscription')
    const historicalWire = JSON.parse(JSON.stringify(historical))
    expect(
      Reflect.get(historicalWire.privateView.offSceneKnownInstances[formalKey].fields, '__proto__')
        .value,
    ).toBe('FORMAL_PROTO_VALUE')
    expect(
      Reflect.get(
        historicalWire.privateView.offSceneKnownInstances[customKey].customFields,
        '__proto__',
      ).value,
    ).toBe('CUSTOM_PROTO_VALUE')
  })

  test('rumor-only fields retain prototype-like names without borrowing an objective shape', () => {
    const f = setup()
    f.seed('remote', 'remote')
    const formalPath = ['legends', 'unseen', '__proto__']
    const customPath = ['whispers', 'unseen', '$custom', '__proto__']
    const heard = f.commit('hear literal values at otherwise unknown field coordinates', (tx) => {
      unwrap(f.perspective.grantRumor(tx, f.at('alice'), formalPath, 'RUMORED_PROTO_VALUE'))
      unwrap(f.perspective.grantRumor(tx, f.at('alice'), customPath, 'RUMORED_CUSTOM_PROTO_VALUE'))
    })
    const formalKey = encodePathKey(['legends', 'unseen'])
    const customKey = encodePathKey(['whispers', 'unseen'])
    const projected = unwrap(f.perspective.projectView(heard.id, f.at('alice')))
    expect(Object.hasOwn(projected.mergedInstances[formalKey]!.fields, '__proto__')).toBe(true)
    expect(Reflect.get(projected.mergedInstances[formalKey]!.fields, '__proto__')?.value).toBe(
      'RUMORED_PROTO_VALUE',
    )
    expect(Object.hasOwn(projected.mergedInstances[customKey]!.customFields, '__proto__')).toBe(
      true,
    )
    expect(
      Reflect.get(projected.mergedInstances[customKey]!.customFields, '__proto__')?.value,
    ).toBe('RUMORED_CUSTOM_PROTO_VALUE')
    expect(Object.hasOwn(projected.schemas[formalKey]!.fields, '__proto__')).toBe(true)
    expect(Reflect.get(projected.schemas[formalKey]!.fields, '__proto__')?.description).toBe(
      '__proto__',
    )
    expect(Object.hasOwn(projected.schemas[customKey]!.fields, '__proto__')).toBe(true)
    const wire = JSON.parse(JSON.stringify(projected))
    expect(
      Reflect.get(wire.privateView.offSceneKnownInstances[formalKey].fields, '__proto__').value,
    ).toBe('RUMORED_PROTO_VALUE')
    expect(
      Reflect.get(wire.privateView.offSceneKnownInstances[customKey].customFields, '__proto__')
        .value,
    ).toBe('RUMORED_CUSTOM_PROTO_VALUE')
  })
})
