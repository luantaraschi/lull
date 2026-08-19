import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { initialState, reduce } from '../../src/core/reduce.js'
import type { ConversationState, Effect, Event, Policy } from '../../src/core/types.js'

const policy: Policy = {
  quietMs: 2_500,
  maxWaitMs: 15_000,
  sessionTtlMs: 30_000,
  takeoverTtlMs: 10_000,
  dedupeWindow: 5,
}

/** Arbitrary event kinds, each with a positive time gap from the previous one. */
const step = fc.record({
  kind: fc.constantFrom('message', 'takeover', 'release', 'tick', 'typing'),
  gap: fc.integer({ min: 1, max: 40_000 }),
})

/** Turns a list of steps into a timeline with strictly increasing timestamps. */
function timeline(steps: { kind: string; gap: number }[]): Event[] {
  let at = 1_000
  let index = 0
  return steps.map((s) => {
    at += s.gap
    switch (s.kind) {
      case 'message':
        index += 1
        return { type: 'message', id: `m${index}`, text: 't', at } as Event
      case 'takeover':
        return { type: 'takeover', at } as Event
      case 'release':
        return { type: 'release', at } as Event
      case 'typing':
        return { type: 'typing', at } as Event
      default:
        return { type: 'tick', at } as Event
    }
  })
}

function run(events: Event[]): { state: ConversationState; effects: Effect[] } {
  let state = initialState('c1')
  const effects: Effect[] = []
  for (const event of events) {
    const [next, produced] = reduce(state, event, policy)
    state = next
    effects.push(...produced)
  }
  return { state, effects }
}

describe('properties', () => {
  test('every message is emitted, dropped, or still buffered, never lost', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        const events = timeline(steps)
        const { state, effects } = run(events)

        const sent = events
          .filter((e): e is Extract<Event, { type: 'message' }> => e.type === 'message')
          .map((e) => e.id)
        const accounted = new Set<string>()
        for (const effect of effects) {
          if (effect.type === 'drop') accounted.add(effect.messageId)
          if (effect.type === 'emitTurn') {
            for (const message of effect.messages) accounted.add(message.id)
          }
        }
        for (const message of state.buffer) accounted.add(message.id)

        expect([...new Set(sent)].filter((id) => !accounted.has(id))).toEqual([])
      }),
    )
  })

  test('never emits a turn while the bot is paused', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        let state = initialState('c1')
        for (const event of timeline(steps)) {
          const paused = state.pausedUntil !== null && event.at < state.pausedUntil
          const [next, effects] = reduce(state, event, policy)
          if (paused) {
            expect(effects.some((e) => e.type === 'emitTurn')).toBe(false)
          }
          state = next
        }
      }),
    )
  })

  test('the dedupe window never grows past its bound', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        const { state } = run(timeline(steps))
        expect(state.seen.length).toBeLessThanOrEqual(policy.dedupeWindow)
      }),
    )
  })
})
