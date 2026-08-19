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

describe('takeover', () => {
  test('cancels the pending timer and discards the buffered messages', () => {
    const state = fold([
      { type: 'message', id: 'm1', text: 'hi', at: 1_000 },
      { type: 'message', id: 'm2', text: 'anyone?', at: 1_500 },
    ])
    const [next, effects] = reduce(state, { type: 'takeover', at: 2_000 }, policy)

    expect(effects).toEqual([
      { type: 'cancel', conversationId: 'c1' },
      { type: 'drop', conversationId: 'c1', messageId: 'm1', reason: 'paused' },
      { type: 'drop', conversationId: 'c1', messageId: 'm2', reason: 'paused' },
    ])
    expect(next.buffer).toEqual([])
    expect(next.firstBufferedAt).toBeNull()
    expect(next.pausedUntil).toBe(12_000)
  })

  test('messages during the pause are dropped, never buffered', () => {
    const state = fold([{ type: 'takeover', at: 2_000 }])
    const [next, effects] = reduce(
      state,
      { type: 'message', id: 'm1', text: 'and the price?', at: 3_000 },
      policy,
    )

    expect(effects).toEqual([
      { type: 'drop', conversationId: 'c1', messageId: 'm1', reason: 'paused' },
    ])
    expect(next.buffer).toEqual([])
    expect(next.seen).toEqual(['m1'])
  })

  test('release brings the bot back immediately', () => {
    const state = fold([
      { type: 'takeover', at: 2_000 },
      { type: 'release', at: 4_000 },
    ])
    const [next, effects] = reduce(
      state,
      { type: 'message', id: 'm1', text: 'hello?', at: 5_000 },
      policy,
    )

    expect(state.pausedUntil).toBeNull()
    expect(next.buffer).toHaveLength(1)
    expect(effects).toEqual([{ type: 'schedule', conversationId: 'c1', at: 7_500 }])
  })

  test('the pause expires lazily once its TTL is past', () => {
    const state = fold([{ type: 'takeover', at: 2_000 }])
    const [next, effects] = reduce(
      state,
      { type: 'message', id: 'm1', text: 'hello?', at: 20_000 },
      policy,
    )

    expect(next.pausedUntil).toBeNull()
    expect(next.buffer).toHaveLength(1)
    expect(effects).toEqual([{ type: 'schedule', conversationId: 'c1', at: 22_500 }])
  })

  test('a tick during the pause emits nothing', () => {
    const state = fold([
      { type: 'message', id: 'm1', text: 'hi', at: 1_000 },
      { type: 'takeover', at: 1_200 },
    ])
    const [, effects] = reduce(state, { type: 'tick', at: 3_500 }, policy)

    expect(effects).toEqual([])
  })
})
