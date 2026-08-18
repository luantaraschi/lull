/**
 * How many LLM calls does coalescing save?
 *
 * Simulates conversations where people type the way they actually do,
 * a burst of short balloons and then a pause, and compares one-call-per-message
 * against one-call-per-turn. Runs on the pure core with a seeded generator,
 * so the number is the same on every machine.
 *
 *   npm run bench
 */
import { initialState, reduce } from '../src/core/reduce.js'
import type { ConversationState, Event, Policy } from '../src/core/types.js'

const policy: Policy = {
  quietMs: 2_500,
  maxWaitMs: 15_000,
  sessionTtlMs: 1_800_000,
  takeoverTtlMs: 900_000,
  dedupeWindow: 200,
}

const CONVERSATIONS = 1_000
const BURSTS_PER_CONVERSATION = 6

/** Mulberry32: a small seeded PRNG, so the benchmark is reproducible. */
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const random = rng(20260818)

let messages = 0
let turns = 0

for (let c = 0; c < CONVERSATIONS; c += 1) {
  let state: ConversationState = initialState(`c${c}`)
  let at = 0
  let index = 0

  const apply = (event: Event): void => {
    const [next, effects] = reduce(state, event, policy)
    state = next
    turns += effects.filter((effect) => effect.type === 'emitTurn').length
  }

  for (let b = 0; b < BURSTS_PER_CONVERSATION; b += 1) {
    // A burst: 1 to 6 balloons, 200-1200ms apart. That is how people type.
    const balloons = 1 + Math.floor(random() * 6)
    for (let m = 0; m < balloons; m += 1) {
      at += 200 + Math.floor(random() * 1_000)
      index += 1
      messages += 1
      apply({ type: 'message', id: `m${index}`, text: 'x', at })
    }
    // Then they stop and wait for an answer.
    at += policy.quietMs + 1
    apply({ type: 'tick', at })
    at += 5_000 + Math.floor(random() * 30_000)
  }
}

const saved = ((messages - turns) / messages) * 100

console.log(`conversations: ${CONVERSATIONS}`)
console.log(`messages received: ${messages}`)
console.log(`turns emitted: ${turns}`)
console.log(`LLM calls avoided: ${saved.toFixed(1)}%`)
