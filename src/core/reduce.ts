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
  }
}

/** When the buffered turn is due: quiet silence, capped by maxWaitMs. */
export function deadline(state: ConversationState, policy: Policy): number {
  const quiet = state.lastMessageAt + policy.quietMs
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
    case 'tick':
      return onTick(state, event, policy)
    default:
      return [state, []]
  }
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

  const seen = [...state.seen, event.id].slice(-policy.dedupeWindow)

  const session = state.session ?? {
    id: `${state.id}#${event.at}`,
    lastActivityAt: event.at,
    turns: 0,
  }

  const next: ConversationState = {
    ...state,
    seen,
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
