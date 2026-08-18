import { describe, expect, test } from 'vitest'
import { initialState, reduce } from '../../src/core/reduce.js'
import type { Policy } from '../../src/core/types.js'

export const policy: Policy = {
  quietMs: 2_500,
  maxWaitMs: 15_000,
  sessionTtlMs: 1_800_000,
  takeoverTtlMs: 900_000,
  dedupeWindow: 200,
}

describe('message', () => {
  test('buffers the message and schedules the quiet deadline', () => {
    const [state, effects] = reduce(
      initialState('c1'),
      { type: 'message', id: 'm1', text: 'hi', at: 1_000 },
      policy,
    )

    expect(state.buffer).toEqual([{ id: 'm1', text: 'hi', at: 1_000 }])
    expect(state.firstBufferedAt).toBe(1_000)
    expect(effects).toEqual([{ type: 'schedule', conversationId: 'c1', at: 3_500 }])
  })

  test('a further message pushes the quiet deadline forward', () => {
    const [first] = reduce(
      initialState('c1'),
      { type: 'message', id: 'm1', text: 'hi', at: 1_000 },
      policy,
    )
    const [second, effects] = reduce(
      first,
      { type: 'message', id: 'm2', text: 'there', at: 2_000 },
      policy,
    )

    expect(second.buffer.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(second.firstBufferedAt).toBe(1_000)
    expect(effects).toEqual([{ type: 'schedule', conversationId: 'c1', at: 4_500 }])
  })

  test('opens a session on the first message, with a deterministic id', () => {
    const [state] = reduce(
      initialState('c1'),
      { type: 'message', id: 'm1', text: 'hi', at: 1_000 },
      policy,
    )

    expect(state.session).toEqual({ id: 'c1#1000', lastActivityAt: 1_000, turns: 0 })
  })
})
