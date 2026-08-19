import type { ConversationState, Effect, Event, Policy } from './types.js'

export function initialState(id: string): ConversationState {
  return {
    id,
    seen: [],
    buffer: [],
    firstBufferedAt: null,
    lastMessageAt: 0,
    session: null,
    pausedUntil: null,
    lastTypingAt: null,
  }
}

/** When the buffered turn is due: quiet silence, capped by maxWaitMs. */
export function deadline(state: ConversationState, policy: Policy): number {
  // Typing counts as activity, so a person still composing holds their turn
  // open. The cap below is what stops that from lasting forever.
  const lastActivity = Math.max(state.lastMessageAt, state.lastTypingAt ?? 0)
  const quiet = lastActivity + policy.quietMs
  const cap = (state.firstBufferedAt ?? state.lastMessageAt) + policy.maxWaitMs
  return Math.min(quiet, cap)
}

export function reduce(
  state: ConversationState,
  event: Event,
  policy: Policy,
): [ConversationState, Effect[]] {
  switch (event.type) {
    case 'message':
      return onMessage(state, event, policy)
    case 'typing':
      return onTyping(state, event, policy)
    case 'tick':
      return onTick(state, event, policy)
    case 'takeover':
      return onTakeover(state, event, policy)
    case 'release':
      return [{ ...state, pausedUntil: null }, []]
  }
}

/** A takeover expires without a sweep: whoever arrives next clears it. */
function pauseAt(state: ConversationState, at: number): number | null {
  if (state.pausedUntil === null) return null
  return at >= state.pausedUntil ? null : state.pausedUntil
}

/** Sessions expire lazily too: the next message decides whether it inherited one. */
function sessionFor(
  state: ConversationState,
  at: number,
  policy: Policy,
): { id: string; lastActivityAt: number; turns: number } {
  const current = state.session
  if (current !== null && at - current.lastActivityAt <= policy.sessionTtlMs) return current
  return { id: `${state.id}#${at}`, lastActivityAt: at, turns: 0 }
}

function onMessage(
  state: ConversationState,
  event: Extract<Event, { type: 'message' }>,
  policy: Policy,
): [ConversationState, Effect[]] {
  if (state.seen.includes(event.id)) {
    return [
      state,
      [{ type: 'drop', conversationId: state.id, messageId: event.id, reason: 'duplicate' }],
    ]
  }

  const pausedUntil = pauseAt(state, event.at)
  const seen = [...state.seen, event.id].slice(-policy.dedupeWindow)

  if (pausedUntil !== null) {
    // A human is handling this conversation. Keep the session warm, stay quiet.
    const paused: ConversationState = {
      ...state,
      seen,
      pausedUntil,
      lastMessageAt: event.at,
      session: state.session === null ? null : { ...state.session, lastActivityAt: event.at },
    }
    return [
      paused,
      [{ type: 'drop', conversationId: state.id, messageId: event.id, reason: 'paused' }],
    ]
  }

  const session = sessionFor(state, event.at, policy)

  const next: ConversationState = {
    ...state,
    seen,
    pausedUntil,
    session: { ...session, lastActivityAt: event.at },
    buffer: [...state.buffer, { id: event.id, text: event.text, at: event.at }],
    firstBufferedAt: state.firstBufferedAt ?? event.at,
    lastMessageAt: event.at,
  }

  return [next, [{ type: 'schedule', conversationId: next.id, at: deadline(next, policy) }]]
}

function onTick(
  state: ConversationState,
  event: Extract<Event, { type: 'tick' }>,
  policy: Policy,
): [ConversationState, Effect[]] {
  if (pauseAt(state, event.at) !== null) return [state, []]
  if (state.buffer.length === 0) return [state, []]

  const due = deadline(state, policy)
  if (event.at < due) {
    return [state, [{ type: 'schedule', conversationId: state.id, at: due }]]
  }

  // A non-empty buffer always means an open session: onMessage opens one.
  const session = state.session ?? {
    id: `${state.id}#${state.lastMessageAt}`,
    lastActivityAt: state.lastMessageAt,
    turns: 0,
  }

  const effect: Effect = {
    type: 'emitTurn',
    conversationId: state.id,
    sessionId: session.id,
    messages: state.buffer,
    isNewSession: session.turns === 0,
  }

  const next: ConversationState = {
    ...state,
    buffer: [],
    firstBufferedAt: null,
    session: { ...session, turns: session.turns + 1, lastActivityAt: event.at },
  }

  return [next, [effect]]
}

function onTakeover(
  state: ConversationState,
  event: Extract<Event, { type: 'takeover' }>,
  policy: Policy,
): [ConversationState, Effect[]] {
  const drops: Effect[] = state.buffer.map((message) => ({
    type: 'drop',
    conversationId: state.id,
    messageId: message.id,
    reason: 'paused',
  }))

  const next: ConversationState = {
    ...state,
    buffer: [],
    firstBufferedAt: null,
    pausedUntil: event.at + policy.takeoverTtlMs,
  }

  return [next, [{ type: 'cancel', conversationId: state.id }, ...drops]]
}

function onTyping(
  state: ConversationState,
  event: Extract<Event, { type: 'typing' }>,
  policy: Policy,
): [ConversationState, Effect[]] {
  // A human is answering; what the customer is doing does not change that.
  if (pauseAt(state, event.at) !== null) return [state, []]

  const next: ConversationState = {
    ...state,
    lastTypingAt: event.at,
    session: state.session === null ? null : { ...state.session, lastActivityAt: event.at },
  }

  if (next.buffer.length === 0) return [next, []]

  return [next, [{ type: 'schedule', conversationId: next.id, at: deadline(next, policy) }]]
}
