import type { ConversationState } from '../core/types.js'

/**
 * Where conversation state lives between events.
 *
 * `withLock` is not a convenience: two webhooks for the same conversation
 * arriving together would read-modify-write over each other and lose a
 * message. Implementations must serialise per conversation id. A Redis
 * store would use `SET NX` with a TTL.
 */
export type Store = {
  load(conversationId: string): Promise<ConversationState | null>
  save(state: ConversationState): Promise<void>
  delete(conversationId: string): Promise<void>
  withLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T>
}
