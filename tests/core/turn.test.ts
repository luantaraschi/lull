import { describe, expect, test } from 'vitest'
import { initialState, reduce } from '../../src/core/reduce.js'
import type { ConversationState, Event, Policy } from '../../src/core/types.js'

const policy: Policy = {
  quietMs: 2_500,
  maxWaitMs: 15_000,
  sessionTtlMs: 1_800_000,
  takeoverTtlMs: 900_000,
  dedupeWindow: 200,
}

function fold(events: Event[], start: ConversationState = initialState('c1')): ConversationState {
  return events.reduce<ConversationState>((state, event) => reduce(state, event, policy)[0], start)
}

describe('tick', () => {
  test('does nothing when the buffer is empty', () => {
    const [state, effects] = reduce(initialState('c1'), { type: 'tick', at: 9_999 }, policy)

    expect(effects).toEqual([])
    expect(state).toEqual(initialState('c1'))
  })

  test('reschedules when the tick arrives early', () => {
    const state = fold([{ type: 'message', id: 'm1', text: 'hi', at: 1_000 }])
    const [, effects] = reduce(state, { type: 'tick', at: 2_000 }, policy)

    expect(effects).toEqual([{ type: 'schedule', conversationId: 'c1', at: 3_500 }])
  })

  test('coalesces fragmented messages into a single turn', () => {
    const state = fold([
      { type: 'message', id: 'm1', text: 'hi', at: 1_000 },
      { type: 'message', id: 'm2', text: 'i wanted to ask', at: 1_800 },
      { type: 'message', id: 'm3', text: 'about the flat', at: 2_400 },
    ])
    const [next, effects] = reduce(state, { type: 'tick', at: 4_900 }, policy)

    expect(effects).toEqual([
      {
        type: 'emitTurn',
        conversationId: 'c1',
        sessionId: 'c1#1000',
        messages: [
          { id: 'm1', text: 'hi', at: 1_000 },
          { id: 'm2', text: 'i wanted to ask', at: 1_800 },
          { id: 'm3', text: 'about the flat', at: 2_400 },
        ],
        isNewSession: true,
      },
    ])
    expect(next.buffer).toEqual([])
    expect(next.firstBufferedAt).toBeNull()
    expect(next.session?.turns).toBe(1)
  })

  test('the second turn of a session is not a new session', () => {
    const state = fold([
      { type: 'message', id: 'm1', text: 'hi', at: 1_000 },
      { type: 'tick', at: 3_500 },
      { type: 'message', id: 'm2', text: 'still there?', at: 10_000 },
    ])
    const [, effects] = reduce(state, { type: 'tick', at: 12_500 }, policy)

    expect(effects[0]).toMatchObject({ type: 'emitTurn', isNewSession: false })
  })

  test('maxWaitMs closes the turn even without silence', () => {
    const events: Event[] = []
    for (let i = 0; i <= 20; i += 1) {
      events.push({ type: 'message', id: `m${i}`, text: 'typing', at: 1_000 + i * 1_000 })
    }
    const state = fold(events)
    const [, effects] = reduce(state, { type: 'tick', at: 16_000 }, policy)

    expect(effects[0]).toMatchObject({ type: 'emitTurn' })
  })
})
