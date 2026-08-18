import type { ConversationState } from '../core/types.js'
import type { Store } from './types.js'

/**
 * In-process store. Locking is a promise chain per conversation id, so the
 * critical sections of one conversation run one at a time while other
 * conversations proceed untouched.
 */
export function memoryStore(): Store {
  const states = new Map<string, ConversationState>()
  const chains = new Map<string, Promise<unknown>>()

  return {
    async load(conversationId) {
      return states.get(conversationId) ?? null
    },

    async save(state) {
      states.set(state.id, state)
    },

    async delete(conversationId) {
      states.delete(conversationId)
      chains.delete(conversationId)
    },

    withLock(conversationId, fn) {
      const previous = chains.get(conversationId) ?? Promise.resolve()
      // Run whether the previous section resolved or rejected: a failure
      // must not wedge the conversation forever.
      const result = previous.then(fn, fn)
      const guard = result.then(
        () => undefined,
        () => undefined,
      )
      chains.set(conversationId, guard)
      void guard.then(() => {
        if (chains.get(conversationId) === guard) chains.delete(conversationId)
      })
      return result
    },
  }
}
