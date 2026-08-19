import { describe, expect, test } from 'vitest'
import { initialState, reduce } from '../../src/core/reduce.js'
import type { ConversationState, Event, Policy } from '../../src/core/types.js'

const policy: Policy = {
  quietMs: 2_500,
  maxWaitMs: 15_000,
  sessionTtlMs: 1_800_000,
  takeoverTtlMs: 10_000,
  dedupeWindow: 200,
}

function fold(events: Event[]): ConversationState {
  return events.reduce<ConversationState>(
    (state, event) => reduce(state, event, policy)[0],
    initialState('c1'),
  )
}

describe('typing', () => {
  test('pushes the deadline while messages are buffered', () => {
    const state = fold([{ type: 'message', id: 'm1', text: 'hi', at: 1_000 }])
    const [, effects] = reduce(state, { type: 'typing', at: 3_000 }, policy)

    expect(effects).toEqual([{ type: 'schedule', conversationId: 'c1', at: 5_500 }])
  })

  test('holds the turn open past the deadline it would have had', () => {
    const state = fold([
      { type: 'message', id: 'm1', text: 'hi', at: 1_000 },
      { type: 'typing', at: 3_000 },
    ])
    const [, effects] = reduce(state, { type: 'tick', at: 3_500 }, policy)

    expect(effects).toEqual([{ type: 'schedule', conversationId: 'c1', at: 5_500 }])
  })

  test('schedules nothing when no message is waiting', () => {
    const [, effects] = reduce(initialState('c1'), { type: 'typing', at: 1_000 }, policy)

    expect(effects).toEqual([])
  })

  test('maxWaitMs still caps someone who never stops typing', () => {
    const events: Event[] = [{ type: 'message', id: 'm1', text: 'hi', at: 1_000 }]
    for (let at = 3_000; at <= 30_000; at += 2_000) {
      events.push({ type: 'typing', at })
    }
    const state = fold(events)
    const [, effects] = reduce(state, { type: 'tick', at: 16_000 }, policy)

    expect(effects[0]).toMatchObject({ type: 'emitTurn' })
  })

  test('is ignored while a human holds the conversation', () => {
    const state = fold([
      { type: 'message', id: 'm1', text: 'hi', at: 1_000 },
      { type: 'takeover', at: 1_200 },
    ])
    const [, effects] = reduce(state, { type: 'typing', at: 2_000 }, policy)

    expect(effects).toEqual([])
  })
})
