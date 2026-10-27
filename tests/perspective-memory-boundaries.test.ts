import { afterEach, expect, test } from 'bun:test'
import { NONE } from '@sekaisen/core'
import { encodePathKey } from '@sekaisen/plugin-world'
import { PerspectiveFixture, unwrap } from './perspective-fixture.ts'

const fixtures: PerspectiveFixture[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.driver.close()
})

test('a later delegate link cannot grant historical private fields retroactively', () => {
  const f = new PerspectiveFixture()
  fixtures.push(f)
  f.seed('remote', 'remote')
  const fact = f.commit('Bob owns the secret before Alice becomes his delegate', (tx) => {
    tx.set(f.at('note').$.owner, f.key('bob'))
    tx.set(f.at('note').$.privateText, 'historically private')
  })
  const granted = f.commit('new delegation is not historical permission', (tx) => {
    tx.set(f.at('alice').$.delegate, f.key('bob'))
    tx.set(f.at('note').$.owner, NONE)
    tx.set(f.at('note').$.privateText, 'unseen replacement')
    unwrap(
      f.perspective.grantKnowledge(tx, f.at('alice'), f.at('note').path, { atCommitId: fact.id }),
    )
  })
  expect(
    f.perspective.inspect(granted.id, f.at('alice'), [f.at('note').$.privateText.path]).ok,
  ).toBe(false)
})

test('removing a delegate link does not erase ownership legitimate at the fact snapshot', () => {
  const f = new PerspectiveFixture()
  fixtures.push(f)
  f.seed('remote', 'remote')
  const fact = f.commit('Alice historically shared Bob mind and owned secret', (tx) => {
    tx.set(f.at('alice').$.delegate, f.key('bob'))
    tx.set(f.at('note').$.owner, f.key('bob'))
    tx.set(f.at('note').$.privateText, 'legitimate historical secret')
  })
  const granted = f.commit('Alice later becomes independent', (tx) => {
    tx.set(f.at('alice').$.delegate, NONE)
    tx.set(f.at('note').$.owner, NONE)
    tx.set(f.at('note').$.privateText, 'unseen replacement')
    unwrap(
      f.perspective.grantKnowledge(tx, f.at('alice'), f.at('note').path, { atCommitId: fact.id }),
    )
  })
  expect(
    unwrap(f.perspective.inspect(granted.id, f.at('alice'), [f.at('note').$.privateText.path]))[0]
      ?.value,
  ).toBe('legitimate historical secret')
})

test('a summary whose narrative is excluded cannot hide its child memory', () => {
  const f = new PerspectiveFixture()
  fixtures.push(f)
  f.seed()
  const summarized = f.commit('remember and summarize', (tx) => {
    unwrap(
      f.perspective.createMemory(tx, f.at('alice'), {
        id: 'detail',
        content: 'A concrete remembered detail',
      }),
    )
    unwrap(
      f.perspective.summarizeMemories(tx, f.at('alice'), {
        id: 'summary',
        level: 'L1',
        childMemoryIds: ['detail'],
        content: 'The higher level narrative',
      }),
    )
  })
  const path = ['perspectives', f.key('alice'), 'memories', 'detail']
  const hidden = f.commit('forget only summary narrative', (tx) => {
    unwrap(
      f.perspective.excludeKnowledge(
        tx,
        f.at('alice'),
        ['perspectives', f.key('alice'), 'memories', 'summary', 'content'],
        { priority: 2000 },
      ),
    )
  })
  const before = unwrap(f.perspective.listSearchableCorpus(summarized.id, f.at('alice')))
  expect(
    before.find((entry) => encodePathKey(entry.path) === encodePathKey([...path, 'content']))
      ?.isFoldedInDefaultView,
  ).toBe(true)
  const after = unwrap(f.perspective.listSearchableCorpus(hidden.id, f.at('alice')))
  expect(
    after.find((entry) => encodePathKey(entry.path) === encodePathKey([...path, 'content']))
      ?.isFoldedInDefaultView,
  ).toBe(false)
  expect(
    unwrap(f.perspective.projectView(hidden.id, f.at('alice'))).mergedInstances[encodePathKey(path)]
      ?.fields.content?.value,
  ).toBe('A concrete remembered detail')
})

test('rumors cannot bypass the memory namespace fence through invalid memory coordinates', () => {
  const f = new PerspectiveFixture()
  fixtures.push(f)
  f.seed()
  const paths = [
    ['perspectives', '$ghost', 'memories', 'event', 'content'],
    ['perspectives', f.key('alice'), 'memories', '$event', 'content'],
  ]
  const rumored = f.commit('record rumors at non-materializable memory coordinates', (tx) => {
    for (const path of paths)
      unwrap(f.perspective.grantRumor(tx, f.at('alice'), path, 'MEMORY_NAMESPACE_RUMOR'))
  })
  for (const path of paths)
    expect(f.perspective.inspect(rumored.id, f.at('alice'), [path])).toMatchObject({
      ok: false,
      error: { kind: 'not_authorized', targetPath: path },
    })
  const view = unwrap(f.perspective.projectView(rumored.id, f.at('alice')))
  const corpus = unwrap(f.perspective.listSearchableCorpus(rumored.id, f.at('alice')))
  expect(JSON.stringify({ view, corpus })).not.toContain('MEMORY_NAMESPACE_RUMOR')
})
