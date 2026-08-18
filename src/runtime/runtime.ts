import { initialState, reduce } from '../core/reduce.js'
import type { BufferedMessage, DropReason, Effect, Event, Policy } from '../core/types.js'
import type { Store } from '../store/types.js'

export type Turn = {
  conversationId: string
  sessionId: string
  messages: BufferedMessage[]
  isNewSession: boolean
}

export type Drop = {
  conversationId: string
  messageId: string
  reason: DropReason
}

export type RuntimeOptions = Partial<Policy> & {
  store: Store
  /** Injectable clock. Defaults to Date.now. */
  now?: () => number
}

export type Runtime = {
  on(event: 'turn', handler: (turn: Turn) => void | Promise<void>): void
  on(event: 'drop', handler: (drop: Drop) => void): void
  on(event: 'error', handler: (error: unknown) => void): void
  ingest(input: {
    conversationId: string
    messageId: string
    text: string
    at?: number
  }): Promise<void>
  takeover(input: { conversationId: string; at?: number }): Promise<void>
  release(input: { conversationId: string; at?: number }): Promise<void>
  stop(): Promise<void>
}

export const DEFAULT_POLICY: Policy = {
  quietMs: 2_500,
  maxWaitMs: 15_000,
  sessionTtlMs: 1_800_000,
  takeoverTtlMs: 900_000,
  dedupeWindow: 200,
}

export function createRuntime(options: RuntimeOptions): Runtime {
  const { store, now = () => Date.now(), ...overrides } = options
  const policy: Policy = { ...DEFAULT_POLICY, ...overrides }

  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const turnHandlers: ((turn: Turn) => void | Promise<void>)[] = []
  const dropHandlers: ((drop: Drop) => void)[] = []
  const errorHandlers: ((error: unknown) => void)[] = []
  let stopped = false

  function emitError(error: unknown): void {
    for (const handler of errorHandlers) handler(error)
  }

  function clearTimer(conversationId: string): void {
    const timer = timers.get(conversationId)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(conversationId)
    }
  }

  async function dispatch(conversationId: string, event: Event): Promise<void> {
    const effects = await store.withLock(conversationId, async () => {
      const state = (await store.load(conversationId)) ?? initialState(conversationId)
      const [next, produced] = reduce(state, event, policy)
      await store.save(next)
      return produced
    })

    // Effects run outside the lock: a slow turn handler must not block ingest.
    for (const effect of effects) await runEffect(effect)
  }

  async function runEffect(effect: Effect): Promise<void> {
    switch (effect.type) {
      case 'schedule': {
        clearTimer(effect.conversationId)
        if (stopped) return
        const timer = setTimeout(
          () => {
            timers.delete(effect.conversationId)
            void dispatch(effect.conversationId, { type: 'tick', at: now() }).catch(emitError)
          },
          Math.max(0, effect.at - now()),
        )
        timer.unref?.()
        timers.set(effect.conversationId, timer)
        return
      }

      case 'cancel':
        clearTimer(effect.conversationId)
        return

      case 'drop':
        for (const handler of dropHandlers) {
          try {
            handler({
              conversationId: effect.conversationId,
              messageId: effect.messageId,
              reason: effect.reason,
            })
          } catch (error) {
            emitError(error)
          }
        }
        return

      case 'emitTurn':
        for (const handler of turnHandlers) {
          try {
            await handler({
              conversationId: effect.conversationId,
              sessionId: effect.sessionId,
              messages: effect.messages,
              isNewSession: effect.isNewSession,
            })
          } catch (error) {
            emitError(error)
          }
        }
        return
    }
  }

  function on(event: 'turn', handler: (turn: Turn) => void | Promise<void>): void
  function on(event: 'drop', handler: (drop: Drop) => void): void
  function on(event: 'error', handler: (error: unknown) => void): void
  function on(event: 'turn' | 'drop' | 'error', handler: (payload: never) => unknown): void {
    if (event === 'turn') turnHandlers.push(handler as (turn: Turn) => void)
    else if (event === 'drop') dropHandlers.push(handler as (drop: Drop) => void)
    else errorHandlers.push(handler as (error: unknown) => void)
  }

  return {
    on,

    async ingest({ conversationId, messageId, text, at }) {
      await dispatch(conversationId, { type: 'message', id: messageId, text, at: at ?? now() })
    },

    async takeover({ conversationId, at }) {
      await dispatch(conversationId, { type: 'takeover', at: at ?? now() })
    },

    async release({ conversationId, at }) {
      await dispatch(conversationId, { type: 'release', at: at ?? now() })
    },

    async stop() {
      stopped = true
      for (const conversationId of [...timers.keys()]) clearTimer(conversationId)
    },
  }
}
