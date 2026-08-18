import { describe, expect, test } from 'vitest'
import { initialState, reduce } from '../../src/core/reduce.js'
import type { ConversationState, Event, Policy } from '../../src/core/types.js'

const policy: Policy = {
  quietMs: 2_500,
  maxWaitMs: 15_000,
  sessionTtlMs: 30_000,
  takeoverTtlMs: 900_000,
  dedupeWindow: 200,
}

function fold(events: Event[]): ConversationState {
  return events.reduce<ConversationState>(
    (state, event) => reduce(state, event, policy)[0],
    initialState('c1'),
  )
}

describe('session', () => {
  test('keeps the same session while the user stays active', () => {
    const state = fold([
      { type: 'message', id: 'm1', text: 'hi', at: 1_000 },
      { type: 'tick', at: 3_500 },
      { type: 'message', id: 'm2', text: 'one more thing', at: 20_000 },
    ])

    expect(state.session?.id).toBe('c1#1000')
    expect(state.session?.turns).toBe(1)
  })

  test('opens a new session after the inactivity TTL', () => {
    const state = fold([
      { type: 'message', id: 'm1', text: 'hi', at: 1_000 },
      { type: 'tick', at: 3_500 },
      { type: 'message', id: 'm2', text: 'back again', at: 100_000 },
    ])
    const [, effects] = reduce(state, { type: 'tick', at: 102_500 }, policy)

    expect(state.session).toEqual({ id: 'c1#100000', lastActivityAt: 100_000, turns: 0 })
    expect(effects[0]).toMatchObject({
      type: 'emitTurn',
      sessionId: 'c1#100000',
      isNewSession: true,
    })
  })
})
