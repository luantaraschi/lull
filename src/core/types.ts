/** A message waiting in the buffer for the conversation to fall quiet. */
export type BufferedMessage = {
  id: string
  text: string
  at: number
}

/** Everything lull knows about one conversation. Serializable on purpose. */
export type ConversationState = {
  id: string
  /** Window of recent message ids, used for deduplication. */
  seen: string[]
  buffer: BufferedMessage[]
  firstBufferedAt: number | null
  lastMessageAt: number
  session: { id: string; lastActivityAt: number; turns: number } | null
  /** Epoch millis until which the bot stays quiet after a human takeover. */
  pausedUntil: number | null
  /**
   * When the channel last reported the person as typing. Absent on state
   * persisted by versions before 0.3.0, so every read tolerates undefined.
   */
  lastTypingAt?: number | null
}

export type Policy = {
  /** Silence, in millis, that closes a turn. */
  quietMs: number
  /** Hard cap, in millis, from the first buffered message. */
  maxWaitMs: number
  /** Inactivity, in millis, after which the next message opens a new session. */
  sessionTtlMs: number
  /** How long, in millis, a human takeover keeps the bot quiet. */
  takeoverTtlMs: number
  /** How many recent message ids to remember per conversation. */
  dedupeWindow: number
}

export type DropReason = 'duplicate' | 'paused'

export type Event =
  | { type: 'message'; id: string; text: string; at: number }
  /**
   * The channel says the person is composing. It holds an open turn open, and
   * it never opens one: with nothing buffered there is nothing to wait for.
   */
  | { type: 'typing'; at: number }
  | { type: 'takeover'; at: number }
  | { type: 'release'; at: number }
  | { type: 'tick'; at: number }

export type Effect =
  | {
      type: 'emitTurn'
      conversationId: string
      sessionId: string
      messages: BufferedMessage[]
      isNewSession: boolean
    }
  /** Replaces any pending timer for this conversation. Never adds to it. */
  | { type: 'schedule'; conversationId: string; at: number }
  | { type: 'cancel'; conversationId: string }
  | { type: 'drop'; conversationId: string; messageId: string; reason: DropReason }
