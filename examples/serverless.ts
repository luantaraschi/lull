/**
 * Running lull where no process stays alive: serverless functions, edge
 * handlers, or a bot orchestrated by an external tool (n8n, Temporal, cron).
 *
 * The facade owns timers, and a serverless function is gone before any timer
 * fires. So skip the facade: drive the pure core yourself, persist the state,
 * and let something outside deliver the tick.
 *
 *   npm run example:serverless
 */
import { initialState, reduce } from '../src/core/reduce.js'
import type { ConversationState, Effect, Event, Policy } from '../src/core/types.js'

const policy: Policy = {
  quietMs: 2_500,
  maxWaitMs: 15_000,
  sessionTtlMs: 1_800_000,
  takeoverTtlMs: 900_000,
  dedupeWindow: 200,
}

// Stands in for Redis, Postgres, or whatever your functions already share.
const db = new Map<string, ConversationState>()

/**
 * One request = one event. Returns the effects for the caller to act on:
 * `schedule` tells the caller when to come back (an n8n Wait node, a delayed
 * queue message, a cron row); `emitTurn` is the cue to call your model.
 */
async function handle(conversationId: string, event: Event): Promise<Effect[]> {
  const state = db.get(conversationId) ?? initialState(conversationId)
  const [next, effects] = reduce(state, event, policy)
  db.set(conversationId, next)
  return effects
}

async function main(): Promise<void> {
  const conversationId = '5573999999999'
  let wakeAt: number | null = null

  const report = (effects: Effect[]): void => {
    for (const effect of effects) {
      if (effect.type === 'schedule') {
        wakeAt = effect.at
        console.log(`  scheduler: come back at t=${effect.at}`)
      }
      if (effect.type === 'cancel') {
        wakeAt = null
        console.log('  scheduler: cancel the pending wake-up')
      }
      if (effect.type === 'drop') {
        console.log(`  drop: ${effect.messageId} (${effect.reason})`)
      }
      if (effect.type === 'emitTurn') {
        wakeAt = null
        const text = effect.messages.map((m) => m.text).join(' ')
        console.log(`  turn: "${text}" -> call the model once, then reply`)
      }
    }
  }

  console.log('request 1: message at t=1000')
  report(await handle(conversationId, { type: 'message', id: 'm1', text: 'hi', at: 1_000 }))

  console.log('request 2: message at t=1800 (the wake-up moves)')
  report(
    await handle(conversationId, { type: 'message', id: 'm2', text: 'about the flat', at: 1_800 }),
  )

  console.log('request 3: the scheduler wakes us at the deadline')
  if (wakeAt !== null) report(await handle(conversationId, { type: 'tick', at: wakeAt }))

  console.log('request 4: a human takes over')
  report(await handle(conversationId, { type: 'takeover', at: 5_000 }))

  console.log('request 5: the customer writes while the human is handling it')
  report(
    await handle(conversationId, { type: 'message', id: 'm3', text: 'and the price?', at: 6_000 }),
  )

  console.log('\nNothing above needed a timer, a running process, or a clock.')
}

void main()
