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
    default:
      return [state, []]
  }
}

function onMessage(
  state: ConversationState,
  event: Extract<Event, { type: 'message' }>,
  policy: Policy,
): [ConversationState, Effect[]] {
  const session = state.session ?? {
    id: `${state.id}#${event.at}`,
    lastActivityAt: event.at,
    turns: 0,
  }

  const next: ConversationState = {
    ...state,
    session: { ...session, lastActivityAt: event.at },
    buffer: [...state.buffer, { id: event.id, text: event.text, at: event.at }],
    firstBufferedAt: state.firstBufferedAt ?? event.at,
    lastMessageAt: event.at,
  }

  return [next, [{ type: 'schedule', conversationId: next.id, at: deadline(next, policy) }]]
}
