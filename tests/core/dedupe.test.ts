import { describe, expect, test } from 'vitest'
import { initialState, reduce } from '../../src/core/reduce.js'
import type { ConversationState, Event, Policy } from '../../src/core/types.js'

const policy: Policy = {
  quietMs: 2_500,
  maxWaitMs: 15_000,
  sessionTtlMs: 1_800_000,
  takeoverTtlMs: 900_000,
  dedupeWindow: 3,
}

function fold(events: Event[]): ConversationState {
  return events.reduce<ConversationState>(
    (state, event) => reduce(state, event, policy)[0],
    initialState('c1'),
  )
}

describe('dedupe', () => {
  test('a redelivered webhook is dropped, not buffered', () => {
    const state = fold([{ type: 'message', id: 'm1', text: 'hi', at: 1_000 }])
    const [next, effects] = reduce(
      state,
      { type: 'message', id: 'm1', text: 'hi', at: 1_050 },
      policy,
    )

    expect(effects).toEqual([
      { type: 'drop', conversationId: 'c1', messageId: 'm1', reason: 'duplicate' },
    ])
    expect(next.buffer).toHaveLength(1)
    expect(next).toEqual(state)
  })

  test('remembers only the last dedupeWindow ids', () => {
    const state = fold([
      { type: 'message', id: 'm1', text: 'a', at: 1_000 },
      { type: 'message', id: 'm2', text: 'b', at: 1_100 },
      { type: 'message', id: 'm3', text: 'c', at: 1_200 },
      { type: 'message', id: 'm4', text: 'd', at: 1_300 },
    ])

    expect(state.seen).toEqual(['m2', 'm3', 'm4'])
  })
})
