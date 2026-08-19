/*
 * What does quietMs cost, and what does it buy?
 *
 * The other benchmark answers "how many model calls does coalescing avoid".
 * This one answers the question that decides the number you actually ship:
 * how often does the bot cut somebody off mid-thought?
 *
 * The gap model matters more than anything else here, so it is stated rather
 * than hidden: about two thirds of balloons follow the previous one inside a
 * second, and the rest come after a longer pause, because the person stopped
 * to think or is typing something longer. Seeded, so the table is the same on
 * every machine.
 *
 *   npm run bench:sweep
 */
import { initialState, reduce } from '../src/core/reduce.js'
import type { ConversationState, Event, Policy } from '../src/core/types.js'

const CONVERSATIONS = 1_000
const BURSTS_PER_CONVERSATION = 6
const QUIET_VALUES = [1_500, 2_500, 4_000, 5_000, 6_000, 8_000, 12_000]

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

function gap(random: () => number): number {
  return random() < 0.68 ? 250 + Math.floor(random() * 950) : 1_600 + Math.floor(random() * 5_400)
}

function dueAt(state: ConversationState, policy: Policy): number {
  const quiet = Math.max(state.lastMessageAt, state.lastTypingAt ?? 0) + policy.quietMs
  const cap = (state.firstBufferedAt ?? state.lastMessageAt) + policy.maxWaitMs
  return Math.min(quiet, cap)
}

function run(quietMs: number) {
  const policy: Policy = {
    quietMs,
    maxWaitMs: 15_000,
    sessionTtlMs: 1_800_000,
    takeoverTtlMs: 900_000,
    dedupeWindow: 200,
  }
  const random = rng(20260819)

  let messages = 0
  let turns = 0
  let interrupted = 0
  let waitTotal = 0

  for (let c = 0; c < CONVERSATIONS; c += 1) {
    let state: ConversationState = initialState(`c${c}`)
    let at = 0
    let index = 0

    for (let b = 0; b < BURSTS_PER_CONVERSATION; b += 1) {
      const balloons = 1 + Math.floor(random() * 6)
      let turnsInBurst = 0
      let lastMessageAt = at

      for (let m = 0; m < balloons; m += 1) {
        at += gap(random)
        lastMessageAt = at

        // Any turn that came due while the person was still typing fires now,
        // before their next balloon lands. That is the interruption.
        if (state.buffer.length > 0) {
          const due = dueAt(state, policy)
          if (due <= at) {
            const [next, effects] = reduce(state, { type: 'tick', at: due }, policy)
            state = next
            for (const effect of effects) {
              if (effect.type !== 'emitTurn') continue
              turns += 1
              turnsInBurst += 1
              waitTotal += due - effect.messages[effect.messages.length - 1]!.at
            }
          }
        }

        index += 1
        messages += 1
        const [next] = reduce(state, { type: 'message', id: `m${index}`, text: 'x', at }, policy)
        state = next
      }

      // The person stops and waits for an answer.
      at = dueAt(state, policy)
      const [next, effects] = reduce(state, { type: 'tick', at }, policy)
      state = next
      for (const effect of effects) {
        if (effect.type !== 'emitTurn') continue
        turns += 1
        turnsInBurst += 1
        waitTotal += at - lastMessageAt
      }

      if (turnsInBurst > 1) interrupted += 1
      at += 5_000 + Math.floor(random() * 30_000)
    }
  }

  const bursts = CONVERSATIONS * BURSTS_PER_CONVERSATION
  return {
    quietMs,
    avoided: ((messages - turns) / messages) * 100,
    interrupted: (interrupted / bursts) * 100,
    wait: waitTotal / turns / 1000,
  }
}

const rows = QUIET_VALUES.map(run)
const best = rows.reduce((a, b) => (b.avoided > a.avoided ? b : a))

console.log(`${CONVERSATIONS} conversations, ${BURSTS_PER_CONVERSATION} bursts each\n`)
console.log('quietMs | calls avoided | bursts interrupted | mean wait')
for (const row of rows) {
  console.log(
    `${String(row.quietMs).padStart(7)} | ${row.avoided.toFixed(1).padStart(12)}% | ${row.interrupted
      .toFixed(1)
      .padStart(17)}% | ${row.wait.toFixed(1).padStart(8)}s`,
  )
}
console.log(
  `\nPast ${best.quietMs}ms nothing more merges under this model: the extra wait is latency only.`,
)
