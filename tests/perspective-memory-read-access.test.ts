import { afterEach, expect, test } from 'bun:test'
import { NONE } from '@sekaisen/core'
import type { Path } from '@sekaisen/plugin-world'
import { encodePathKey, SELF_COMMIT } from '@sekaisen/plugin-world'
import { PerspectiveFixture, present, unwrap } from './perspective-fixture.ts'

const fixtures: PerspectiveFixture[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.driver.close()
})

for (const field of ['targetRef', 'role'] as const) {
  test(`memory corpus respects an exclusion on an association ${field} leaf`, () => {
    const f = new PerspectiveFixture()
    fixtures.push(f)
    f.seed()
    const path: Path = ['perspectives', f.key('alice'), 'memories', 'event']
    const source = f.commit('remember an authorized identity with a private role', (tx) => {
      unwrap(
        f.perspective.createMemory(tx, f.at('alice'), {
          id: 'event',
          content: 'Remembered event',
          relatedEntities: {
            subject: {
              targetRef: { commitId: SELF_COMMIT, path: f.at('note').path },
              role: 'SECRET_ROLE',
            },
          },
        }),
      )
    })
    const hidden = f.commit('exclude one association leaf', (tx) => {
      unwrap(
        f.perspective.excludeKnowledge(
          tx,
          f.at('alice'),
          [...path, 'relatedEntities', 'subject', field],
          { priority: 2000 },
        ),
      )
    })
    const before = unwrap(f.perspective.listSearchableCorpus(source.id, f.at('alice'))).find(
      (entry) => encodePathKey(entry.path) === encodePathKey([...path, 'content']),
    )
    expect(before?.linkedEntities).toMatchObject([{ role: 'SECRET_ROLE' }])
    const after = unwrap(f.perspective.listSearchableCorpus(hidden.id, f.at('alice'))).find(
      (entry) => encodePathKey(entry.path) === encodePathKey([...path, 'content']),
    )
    if (!after) throw new Error('Expected the unexcluded narrative to remain searchable')
    if (field === 'targetRef') {
      expect(after.linkedEntities).toEqual([])
      expect(after.linkedInstancePaths).toEqual([])
    } else {
      expect(after.linkedEntities).toMatchObject([
        { role: 'participant', ref: { commitId: source.id, path: f.at('note').path } },
      ])
      expect(JSON.stringify(after)).not.toContain('SECRET_ROLE')
    }
  })
}

for (const suffix of [
  ['content', '$meta', 'summary'],
  ['content', '$meta'],
]) {
  test(`memory summary exclusion at ${suffix.join('/')} is respected by every read surface`, () => {
    const f = new PerspectiveFixture()
    fixtures.push(f)
    f.seed()
    const path: Path = ['perspectives', f.key('alice'), 'memories', 'event']
    f.commit('remember a narrative and its separately suppressible summary', (tx) => {
      unwrap(
        f.perspective.createMemory(tx, f.at('alice'), {
          id: 'event',
          content: 'Visible full narrative',
          summary: 'HIDDEN_SUMMARY',
        }),
      )
    })
    const hidden = f.commit('exclude summary metadata', (tx) => {
      unwrap(
        f.perspective.excludeKnowledge(tx, f.at('alice'), [...path, ...suffix], { priority: 2000 }),
      )
    })
    const scope = unwrap(f.perspective.asObserver(hidden.id, f.at('alice')))
    const projection = unwrap(scope.projectView())
    const projected = projection.mergedInstances[encodePathKey(path)]?.fields.content
    expect(projected).toMatchObject({
      value: 'Visible full narrative',
      summary: NONE,
      folded: false,
    })
    const inspected = unwrap(scope.inspect([[...path, 'content']]))
    expect(inspected[0]).toMatchObject({ value: 'Visible full narrative', summary: NONE })
    const corpus = unwrap(scope.listSearchableCorpus())
    const entry = corpus.find(
      (candidate) => encodePathKey(candidate.path) === encodePathKey([...path, 'content']),
    )
    expect(entry).toMatchObject({
      text: 'Visible full narrative',
      summary: NONE,
      isFoldedInDefaultView: false,
    })
    expect(JSON.stringify({ projection, inspected, corpus })).not.toContain('HIDDEN_SUMMARY')
  })
}

test('propagation preserves prototype-like association slot keys as own dictionary entries', () => {
  const f = new PerspectiveFixture()
  fixtures.push(f)
  f.seed()
  const slots = ['__proto__', 'constructor', 'toString']
  const source = f.commit('create all legal association slot names', (tx) => {
    unwrap(
      f.perspective.createMemory(tx, f.at('alice'), {
        id: 'dictionary',
        content: 'A memory with legal slot names',
        relatedEntities: Object.fromEntries(
          slots.map((slot) => [
            slot,
            {
              targetRef: { commitId: SELF_COMMIT, path: f.at('note').path },
              role: slot,
            },
          ]),
        ),
      }),
    )
  })
  const target = f.commit('retell without changing dictionary prototypes', (tx) => {
    unwrap(f.perspective.propagateMemory(tx, f.at('alice'), f.at('bob'), 'dictionary'))
  })
  const relatedPath = ['perspectives', f.key('bob'), 'memories', 'dictionary', 'relatedEntities']
  const related = present(unwrap(f.schema.inspectInstance(target.id, relatedPath)))
  if (related.nodeKind !== 'map') throw new Error('Expected a related entity Map')
  expect(Object.keys(related.entries).sort()).toEqual([...slots].sort())
  for (const slot of slots) {
    expect(Object.hasOwn(related.entries, slot)).toBe(true)
    const row = related.entries[slot]
    if (row?.nodeKind !== 'struct') throw new Error(`Expected own association ${slot}`)
    expect(present(row.fields.targetRef!)).toMatchObject({
      nodeKind: 'leaf',
      value: { commitId: source.id, path: f.at('note').path },
    })
    expect(present(row.fields.role!)).toMatchObject({ nodeKind: 'leaf', value: slot })
  }
})
