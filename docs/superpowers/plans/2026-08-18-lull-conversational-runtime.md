# lull — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publicar `@luantaraschi/lull`, uma lib TypeScript que resolve os quatro problemas de canal de todo bot de atendimento — webhook duplicado, mensagem fragmentada, takeover humano e sessão expirada.

**Architecture:** Núcleo puro (`reduce(state, event, policy) => [state', Effect[]]`) que nunca lê relógio nem toca rede, com uma fachada por cima que executa os efeitos (timers, emissão de eventos) e uma interface `Store` cuja única implementação entregue é em memória.

**Tech Stack:** TypeScript 5.6+, vitest, fast-check, tsup, tsx, GitHub Actions, Node 20/22.

**Spec:** `docs/superpowers/specs/2026-08-18-lull-conversational-runtime-design.md`

## Global Constraints

- Pacote npm: `@luantaraschi/lull`. Publicação com `--access public --provenance`.
- Código, comentários, README e mensagens de commit **em inglês**. Só spec e plano em português.
- `src/core/` não pode importar nada fora de `src/core/` — **zero dependências de runtime** no pacote inteiro (`dependencies: {}`).
- ESM + CJS + tipos, via tsup. Subpath `./core` exportado.
- Node 20 e 22 no CI. `"type": "module"`, imports internos com extensão `.js`.
- Toda função do núcleo é pura: nada de `Date.now()`, `Math.random()` ou I/O em `src/core/`.
- Defaults da policy, idênticos em todo lugar: `quietMs: 2_500`, `maxWaitMs: 15_000`, `sessionTtlMs: 1_800_000`, `takeoverTtlMs: 900_000`, `dedupeWindow: 200`.
- O contrato do efeito `schedule` é **substituir** qualquer timer pendente daquela conversa, nunca somar.

> **Nota sobre a spec:** a spec escreve a assinatura como `reduce(state, event)`. Era abreviação; a assinatura real é `reduce(state, event, policy)`, com a policy injetada em vez de global. A spec também descreve `session` como `{ id, lastActivityAt }`; o plano acrescenta `turns: number`, que é como `isNewSession` é derivado sem campo de controle solto no estado.

---

### Task 1: Scaffold, tipos e bufferização

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/core/types.ts`, `src/core/reduce.ts`
- Test: `tests/core/message.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `ConversationState`, `BufferedMessage`, `Policy`, `Event`, `Effect` (`src/core/types.ts`); `initialState(id: string): ConversationState`, `deadline(state: ConversationState, policy: Policy): number`, `reduce(state: ConversationState, event: Event, policy: Policy): [ConversationState, Effect[]]` (`src/core/reduce.ts`).

- [ ] **Step 1: Criar `package.json`**

```json
{
  "name": "@luantaraschi/lull",
  "version": "0.0.0",
  "description": "Conversation runtime for chat agents: message coalescing, webhook idempotency, human takeover and session expiry.",
  "type": "module",
  "license": "MIT",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {},
  "devDependencies": {
    "@types/node": "^22.7.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Criar `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Criar `vitest.config.ts` e `.gitignore`**

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: { include: ['src/**'], reporter: ['text', 'lcov'] },
  },
})
```

`.gitignore`:

```
node_modules/
dist/
coverage/
*.tgz
.DS_Store
```

- [ ] **Step 4: Instalar dependências**

Run: `npm install`
Expected: `node_modules/` criado, sem erros.

- [ ] **Step 5: Escrever o teste que falha**

`tests/core/message.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { initialState, reduce } from '../../src/core/reduce.js'
import type { Policy } from '../../src/core/types.js'

export const policy: Policy = {
  quietMs: 2_500,
  maxWaitMs: 15_000,
  sessionTtlMs: 1_800_000,
  takeoverTtlMs: 900_000,
  dedupeWindow: 200,
}

describe('message', () => {
  test('buffers the message and schedules the quiet deadline', () => {
    const [state, effects] = reduce(
      initialState('c1'),
      { type: 'message', id: 'm1', text: 'hi', at: 1_000 },
      policy,
    )

    expect(state.buffer).toEqual([{ id: 'm1', text: 'hi', at: 1_000 }])
    expect(state.firstBufferedAt).toBe(1_000)
    expect(effects).toEqual([{ type: 'schedule', conversationId: 'c1', at: 3_500 }])
  })

  test('a further message pushes the quiet deadline forward', () => {
    const [first] = reduce(
      initialState('c1'),
      { type: 'message', id: 'm1', text: 'hi', at: 1_000 },
      policy,
    )
    const [second, effects] = reduce(
      first,
      { type: 'message', id: 'm2', text: 'there', at: 2_000 },
      policy,
    )

    expect(second.buffer.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(second.firstBufferedAt).toBe(1_000)
    expect(effects).toEqual([{ type: 'schedule', conversationId: 'c1', at: 4_500 }])
  })

  test('opens a session on the first message, with a deterministic id', () => {
    const [state] = reduce(
      initialState('c1'),
      { type: 'message', id: 'm1', text: 'hi', at: 1_000 },
      policy,
    )

    expect(state.session).toEqual({ id: 'c1#1000', lastActivityAt: 1_000, turns: 0 })
  })
})
```

- [ ] **Step 6: Rodar o teste e confirmar que falha**

Run: `npx vitest run tests/core/message.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/core/reduce.js"`.

- [ ] **Step 7: Escrever `src/core/types.ts`**

```ts
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
```

- [ ] **Step 8: Escrever `src/core/reduce.ts`**

```ts
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
```

- [ ] **Step 9: Rodar o teste e confirmar que passa**

Run: `npx vitest run tests/core/message.test.ts && npm run typecheck`
Expected: 3 testes PASS, typecheck sem erro.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src tests
git commit -m "feat(core): buffer messages and schedule the quiet deadline"
```

---

### Task 2: Fechamento do turno

**Files:**
- Modify: `src/core/reduce.ts`
- Test: `tests/core/turn.test.ts`

**Interfaces:**
- Consumes: `reduce`, `initialState`, `deadline` (Task 1).
- Produces: tratamento do evento `{ type: 'tick', at }` — emite `emitTurn` quando vencido, reagenda quando cedo demais, nada quando o buffer está vazio.

- [ ] **Step 1: Escrever o teste que falha**

`tests/core/turn.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { initialState, reduce } from '../../src/core/reduce.js'
import type { ConversationState, Event, Policy } from '../../src/core/types.js'

const policy: Policy = {
  quietMs: 2_500,
  maxWaitMs: 15_000,
  sessionTtlMs: 1_800_000,
  takeoverTtlMs: 900_000,
  dedupeWindow: 200,
}

function fold(events: Event[], start: ConversationState = initialState('c1')): ConversationState {
  return events.reduce<ConversationState>((state, event) => reduce(state, event, policy)[0], start)
}

describe('tick', () => {
  test('does nothing when the buffer is empty', () => {
    const [state, effects] = reduce(initialState('c1'), { type: 'tick', at: 9_999 }, policy)

    expect(effects).toEqual([])
    expect(state).toEqual(initialState('c1'))
  })

  test('reschedules when the tick arrives early', () => {
    const state = fold([{ type: 'message', id: 'm1', text: 'hi', at: 1_000 }])
    const [, effects] = reduce(state, { type: 'tick', at: 2_000 }, policy)

    expect(effects).toEqual([{ type: 'schedule', conversationId: 'c1', at: 3_500 }])
  })

  test('coalesces fragmented messages into a single turn', () => {
    const state = fold([
      { type: 'message', id: 'm1', text: 'hi', at: 1_000 },
      { type: 'message', id: 'm2', text: 'i wanted to ask', at: 1_800 },
      { type: 'message', id: 'm3', text: 'about the flat', at: 2_400 },
    ])
    const [next, effects] = reduce(state, { type: 'tick', at: 4_900 }, policy)

    expect(effects).toEqual([
      {
        type: 'emitTurn',
        conversationId: 'c1',
        sessionId: 'c1#1000',
        messages: [
          { id: 'm1', text: 'hi', at: 1_000 },
          { id: 'm2', text: 'i wanted to ask', at: 1_800 },
          { id: 'm3', text: 'about the flat', at: 2_400 },
        ],
        isNewSession: true,
      },
    ])
    expect(next.buffer).toEqual([])
    expect(next.firstBufferedAt).toBeNull()
    expect(next.session?.turns).toBe(1)
  })

  test('the second turn of a session is not a new session', () => {
    const state = fold([
      { type: 'message', id: 'm1', text: 'hi', at: 1_000 },
      { type: 'tick', at: 3_500 },
      { type: 'message', id: 'm2', text: 'still there?', at: 10_000 },
    ])
    const [, effects] = reduce(state, { type: 'tick', at: 12_500 }, policy)

    expect(effects[0]).toMatchObject({ type: 'emitTurn', isNewSession: false })
  })

  test('maxWaitMs closes the turn even without silence', () => {
    const events: Event[] = []
    for (let i = 0; i <= 20; i += 1) {
      events.push({ type: 'message', id: `m${i}`, text: 'typing', at: 1_000 + i * 1_000 })
    }
    const state = fold(events)
    const [, effects] = reduce(state, { type: 'tick', at: 16_000 }, policy)

    expect(effects[0]).toMatchObject({ type: 'emitTurn' })
  })
})
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run tests/core/turn.test.ts`
Expected: FAIL — os ticks devolvem `[]` (o `default` do switch), então "reschedules when the tick arrives early" e os dois de emissão quebram.

- [ ] **Step 3: Implementar o tratamento de `tick`**

Em `src/core/reduce.ts`, trocar o `switch` por:

```ts
  switch (event.type) {
    case 'message':
      return onMessage(state, event, policy)
    case 'tick':
      return onTick(state, event, policy)
    default:
      return [state, []]
  }
```

E acrescentar ao fim do arquivo:

```ts
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
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `npx vitest run && npm run typecheck`
Expected: todos PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/reduce.ts tests/core/turn.test.ts
git commit -m "feat(core): close the turn on tick, capped by maxWaitMs"
```

---

### Task 3: Idempotência por janela

**Files:**
- Modify: `src/core/reduce.ts`
- Test: `tests/core/dedupe.test.ts`

**Interfaces:**
- Consumes: `reduce`, `initialState` (Task 1).
- Produces: campo `seen` alimentado e limitado a `policy.dedupeWindow`; efeito `drop` com `reason: 'duplicate'`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/core/dedupe.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { initialState, reduce } from '../../src/core/reduce.js'
import type { ConversationState, Event, Policy } from '../../src/core/types.js'

const policy: Policy = {
  quietMs: 2_500,
  maxWaitMs: 15_000,
  sessionTtlMs: 1_800_000,
  takeoverTtlMs: 900_000,
  dedupeWindow: 3,
}

function fold(events: Event[]): ConversationState {
  return events.reduce<ConversationState>(
    (state, event) => reduce(state, event, policy)[0],
    initialState('c1'),
  )
}

describe('dedupe', () => {
  test('a redelivered webhook is dropped, not buffered', () => {
    const state = fold([{ type: 'message', id: 'm1', text: 'hi', at: 1_000 }])
    const [next, effects] = reduce(
      state,
      { type: 'message', id: 'm1', text: 'hi', at: 1_050 },
      policy,
    )

    expect(effects).toEqual([
      { type: 'drop', conversationId: 'c1', messageId: 'm1', reason: 'duplicate' },
    ])
    expect(next.buffer).toHaveLength(1)
    expect(next).toEqual(state)
  })

  test('remembers only the last dedupeWindow ids', () => {
    const state = fold([
      { type: 'message', id: 'm1', text: 'a', at: 1_000 },
      { type: 'message', id: 'm2', text: 'b', at: 1_100 },
      { type: 'message', id: 'm3', text: 'c', at: 1_200 },
      { type: 'message', id: 'm4', text: 'd', at: 1_300 },
    ])

    expect(state.seen).toEqual(['m2', 'm3', 'm4'])
  })
})
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run tests/core/dedupe.test.ts`
Expected: FAIL — a duplicata entra no buffer e `state.seen` continua `[]`.

- [ ] **Step 3: Implementar o dedupe**

Em `src/core/reduce.ts`, substituir o corpo de `onMessage` por:

```ts
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
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `npx vitest run && npm run typecheck`
Expected: todos PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/reduce.ts tests/core/dedupe.test.ts
git commit -m "feat(core): drop redelivered messages with a bounded id window"
```

---

### Task 4: Takeover humano

**Files:**
- Modify: `src/core/reduce.ts`
- Test: `tests/core/takeover.test.ts`

**Interfaces:**
- Consumes: `reduce`, `initialState` (Task 1).
- Produces: tratamento de `takeover` e `release`; campo `pausedUntil`; efeitos `cancel` e `drop` com `reason: 'paused'`; expiração preguiçosa da pausa.

- [ ] **Step 1: Escrever o teste que falha**

`tests/core/takeover.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { initialState, reduce } from '../../src/core/reduce.js'
import type { ConversationState, Event, Policy } from '../../src/core/types.js'

const policy: Policy = {
  quietMs: 2_500,
  maxWaitMs: 15_000,
  sessionTtlMs: 1_800_000,
  takeoverTtlMs: 10_000,
  dedupeWindow: 200,
}

function fold(events: Event[]): ConversationState {
  return events.reduce<ConversationState>(
    (state, event) => reduce(state, event, policy)[0],
    initialState('c1'),
  )
}

describe('takeover', () => {
  test('cancels the pending timer and discards the buffered messages', () => {
    const state = fold([
      { type: 'message', id: 'm1', text: 'hi', at: 1_000 },
      { type: 'message', id: 'm2', text: 'anyone?', at: 1_500 },
    ])
    const [next, effects] = reduce(state, { type: 'takeover', at: 2_000 }, policy)

    expect(effects).toEqual([
      { type: 'cancel', conversationId: 'c1' },
      { type: 'drop', conversationId: 'c1', messageId: 'm1', reason: 'paused' },
      { type: 'drop', conversationId: 'c1', messageId: 'm2', reason: 'paused' },
    ])
    expect(next.buffer).toEqual([])
    expect(next.firstBufferedAt).toBeNull()
    expect(next.pausedUntil).toBe(12_000)
  })

  test('messages during the pause are dropped, never buffered', () => {
    const state = fold([{ type: 'takeover', at: 2_000 }])
    const [next, effects] = reduce(
      state,
      { type: 'message', id: 'm1', text: 'and the price?', at: 3_000 },
      policy,
    )

    expect(effects).toEqual([
      { type: 'drop', conversationId: 'c1', messageId: 'm1', reason: 'paused' },
    ])
    expect(next.buffer).toEqual([])
    expect(next.seen).toEqual(['m1'])
  })

  test('release brings the bot back immediately', () => {
    const state = fold([{ type: 'takeover', at: 2_000 }, { type: 'release', at: 4_000 }])
    const [next, effects] = reduce(
      state,
      { type: 'message', id: 'm1', text: 'hello?', at: 5_000 },
      policy,
    )

    expect(state.pausedUntil).toBeNull()
    expect(next.buffer).toHaveLength(1)
    expect(effects).toEqual([{ type: 'schedule', conversationId: 'c1', at: 7_500 }])
  })

  test('the pause expires lazily once its TTL is past', () => {
    const state = fold([{ type: 'takeover', at: 2_000 }])
    const [next, effects] = reduce(
      state,
      { type: 'message', id: 'm1', text: 'hello?', at: 20_000 },
      policy,
    )

    expect(next.pausedUntil).toBeNull()
    expect(next.buffer).toHaveLength(1)
    expect(effects).toEqual([{ type: 'schedule', conversationId: 'c1', at: 22_500 }])
  })

  test('a tick during the pause emits nothing', () => {
    const state = fold([
      { type: 'message', id: 'm1', text: 'hi', at: 1_000 },
      { type: 'takeover', at: 1_200 },
    ])
    const [, effects] = reduce(state, { type: 'tick', at: 3_500 }, policy)

    expect(effects).toEqual([])
  })
})
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run tests/core/takeover.test.ts`
Expected: FAIL — `takeover` e `release` caem no `default` e não fazem nada.

- [ ] **Step 3: Implementar takeover, release e expiração preguiçosa**

Em `src/core/reduce.ts`, o `switch` completo passa a ser:

```ts
  switch (event.type) {
    case 'message':
      return onMessage(state, event, policy)
    case 'tick':
      return onTick(state, event, policy)
    case 'takeover':
      return onTakeover(state, event, policy)
    case 'release':
      return [{ ...state, pausedUntil: null }, []]
  }
```

Acrescentar o helper e o handler:

```ts
/** A takeover expires without a sweep: whoever arrives next clears it. */
function pauseAt(state: ConversationState, at: number): number | null {
  if (state.pausedUntil === null) return null
  return at >= state.pausedUntil ? null : state.pausedUntil
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
```

Em `onMessage`, logo depois do bloco de dedupe, acrescentar:

```ts
  const pausedUntil = pauseAt(state, event.at)
  const seen = [...state.seen, event.id].slice(-policy.dedupeWindow)

  if (pausedUntil !== null) {
    // A human is handling this conversation. Keep the session warm, stay quiet.
    const paused: ConversationState = {
      ...state,
      seen,
      pausedUntil,
      lastMessageAt: event.at,
      session:
        state.session === null ? null : { ...state.session, lastActivityAt: event.at },
    }
    return [
      paused,
      [{ type: 'drop', conversationId: state.id, messageId: event.id, reason: 'paused' }],
    ]
  }
```

Remover a linha `const seen = ...` que ficou duplicada abaixo e acrescentar `pausedUntil` ao objeto `next` de `onMessage`:

```ts
  const next: ConversationState = {
    ...state,
    seen,
    pausedUntil,
    session: { ...session, lastActivityAt: event.at },
    buffer: [...state.buffer, { id: event.id, text: event.text, at: event.at }],
    firstBufferedAt: state.firstBufferedAt ?? event.at,
    lastMessageAt: event.at,
  }
```

Em `onTick`, como primeira linha do corpo:

```ts
  if (pauseAt(state, event.at) !== null) return [state, []]
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `npx vitest run && npm run typecheck`
Expected: todos PASS. O `default` sumiu do switch — o typecheck agora garante exaustividade sobre `Event`.

- [ ] **Step 5: Commit**

```bash
git add src/core/reduce.ts tests/core/takeover.test.ts
git commit -m "feat(core): pause the bot while a human handles the conversation"
```

---

### Task 5: Expiração de sessão

**Files:**
- Modify: `src/core/reduce.ts`
- Test: `tests/core/session.test.ts`

**Interfaces:**
- Consumes: `reduce`, `initialState` (Task 1).
- Produces: sessão que expira por inatividade — a mensagem seguinte abre sessão nova, com `turns` zerado, e o turno resultante sai com `isNewSession: true`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/core/session.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { initialState, reduce } from '../../src/core/reduce.js'
import type { ConversationState, Event, Policy } from '../../src/core/types.js'

const policy: Policy = {
  quietMs: 2_500,
  maxWaitMs: 15_000,
  sessionTtlMs: 30_000,
  takeoverTtlMs: 900_000,
  dedupeWindow: 200,
}

function fold(events: Event[]): ConversationState {
  return events.reduce<ConversationState>(
    (state, event) => reduce(state, event, policy)[0],
    initialState('c1'),
  )
}

describe('session', () => {
  test('keeps the same session while the user stays active', () => {
    const state = fold([
      { type: 'message', id: 'm1', text: 'hi', at: 1_000 },
      { type: 'tick', at: 3_500 },
      { type: 'message', id: 'm2', text: 'one more thing', at: 20_000 },
    ])

    expect(state.session?.id).toBe('c1#1000')
    expect(state.session?.turns).toBe(1)
  })

  test('opens a new session after the inactivity TTL', () => {
    const state = fold([
      { type: 'message', id: 'm1', text: 'hi', at: 1_000 },
      { type: 'tick', at: 3_500 },
      { type: 'message', id: 'm2', text: 'back again', at: 100_000 },
    ])
    const [, effects] = reduce(state, { type: 'tick', at: 102_500 }, policy)

    expect(state.session).toEqual({ id: 'c1#100000', lastActivityAt: 100_000, turns: 0 })
    expect(effects[0]).toMatchObject({
      type: 'emitTurn',
      sessionId: 'c1#100000',
      isNewSession: true,
    })
  })
})
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run tests/core/session.test.ts`
Expected: FAIL em "opens a new session after the inactivity TTL" — a sessão `c1#1000` sobrevive e `isNewSession` vem `false`.

- [ ] **Step 3: Implementar a expiração**

Em `src/core/reduce.ts`, acrescentar o helper:

```ts
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
```

E em `onMessage` trocar a criação da sessão por:

```ts
  const session = sessionFor(state, event.at, policy)
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `npx vitest run && npm run typecheck`
Expected: todos PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/reduce.ts tests/core/session.test.ts
git commit -m "feat(core): expire idle sessions and flag the first turn of a new one"
```

---

### Task 6: Invariantes com fast-check

**Files:**
- Modify: `package.json` (devDependency `fast-check`)
- Test: `tests/core/properties.test.ts`

**Interfaces:**
- Consumes: `reduce`, `initialState` (Tasks 1–5).
- Produces: nenhuma API nova. Três invariantes sobre sequências arbitrárias de eventos.

- [ ] **Step 1: Instalar `fast-check`**

Run: `npm install --save-dev fast-check@^3.22.0`
Expected: entra em `devDependencies`.

- [ ] **Step 2: Escrever o teste que falha**

`tests/core/properties.test.ts`:

```ts
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { initialState, reduce } from '../../src/core/reduce.js'
import type { ConversationState, Effect, Event, Policy } from '../../src/core/types.js'

const policy: Policy = {
  quietMs: 2_500,
  maxWaitMs: 15_000,
  sessionTtlMs: 30_000,
  takeoverTtlMs: 10_000,
  dedupeWindow: 5,
}

/** Arbitrary event kinds, each with a positive time gap from the previous one. */
const step = fc.record({
  kind: fc.constantFrom('message', 'takeover', 'release', 'tick'),
  gap: fc.integer({ min: 1, max: 40_000 }),
})

/** Turns a list of steps into a timeline with strictly increasing timestamps. */
function timeline(steps: { kind: string; gap: number }[]): Event[] {
  let at = 1_000
  let index = 0
  return steps.map((s) => {
    at += s.gap
    switch (s.kind) {
      case 'message':
        index += 1
        return { type: 'message', id: `m${index}`, text: 't', at } as Event
      case 'takeover':
        return { type: 'takeover', at } as Event
      case 'release':
        return { type: 'release', at } as Event
      default:
        return { type: 'tick', at } as Event
    }
  })
}

function run(events: Event[]): { state: ConversationState; effects: Effect[] } {
  let state = initialState('c1')
  const effects: Effect[] = []
  for (const event of events) {
    const [next, produced] = reduce(state, event, policy)
    state = next
    effects.push(...produced)
  }
  return { state, effects }
}

describe('properties', () => {
  test('every message is emitted, dropped, or still buffered — never lost', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        const events = timeline(steps)
        const { state, effects } = run(events)

        const sent = events.filter((e) => e.type === 'message').map((e) => e.id)
        const accounted = new Set<string>()
        for (const effect of effects) {
          if (effect.type === 'drop') accounted.add(effect.messageId)
          if (effect.type === 'emitTurn') {
            for (const message of effect.messages) accounted.add(message.id)
          }
        }
        for (const message of state.buffer) accounted.add(message.id)

        expect([...new Set(sent)].filter((id) => !accounted.has(id))).toEqual([])
      }),
    )
  })

  test('never emits a turn while the bot is paused', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        let state = initialState('c1')
        for (const event of timeline(steps)) {
          const paused = state.pausedUntil !== null && event.at < state.pausedUntil
          const [next, effects] = reduce(state, event, policy)
          if (paused) {
            expect(effects.some((e) => e.type === 'emitTurn')).toBe(false)
          }
          state = next
        }
      }),
    )
  })

  test('the dedupe window never grows past its bound', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        const { state } = run(timeline(steps))
        expect(state.seen.length).toBeLessThanOrEqual(policy.dedupeWindow)
      }),
    )
  })
})
```

- [ ] **Step 3: Rodar o teste**

Run: `npx vitest run tests/core/properties.test.ts`
Expected: PASS. Se alguma propriedade falhar, o `fast-check` imprime o contraexemplo mínimo — **corrija o núcleo, nunca a propriedade**, e acrescente o contraexemplo como teste de mesa em `tests/core/`.

- [ ] **Step 4: Rodar a suíte inteira com cobertura**

Run: `npx vitest run --coverage`
Expected: todos PASS, cobertura de `src/core/` acima de 90%.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tests/core/properties.test.ts
git commit -m "test(core): pin invariants with property-based tests"
```

---

### Task 7: Store e o lock por conversa

**Files:**
- Create: `src/store/types.ts`, `src/store/memory.ts`
- Test: `tests/store/memory.test.ts`

**Interfaces:**
- Consumes: `ConversationState` (Task 1).
- Produces: `Store` (`src/store/types.ts`) com `load`, `save`, `delete`, `withLock`; `memoryStore(): Store` (`src/store/memory.ts`).

- [ ] **Step 1: Escrever o teste que falha**

`tests/store/memory.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { memoryStore } from '../../src/store/memory.js'
import { initialState } from '../../src/core/reduce.js'

describe('memoryStore', () => {
  test('round-trips a conversation state', async () => {
    const store = memoryStore()
    expect(await store.load('c1')).toBeNull()

    await store.save({ ...initialState('c1'), lastMessageAt: 42 })
    expect((await store.load('c1'))?.lastMessageAt).toBe(42)

    await store.delete('c1')
    expect(await store.load('c1')).toBeNull()
  })

  test('serialises concurrent work on the same conversation', async () => {
    const store = memoryStore()
    await store.save(initialState('c1'))

    // Without a lock, every one of these reads the same state and the count ends at 1.
    await Promise.all(
      Array.from({ length: 50 }, () =>
        store.withLock('c1', async () => {
          const state = await store.load('c1')
          await new Promise((resolve) => setTimeout(resolve, 0))
          await store.save({ ...state!, lastMessageAt: state!.lastMessageAt + 1 })
        }),
      ),
    )

    expect((await store.load('c1'))?.lastMessageAt).toBe(50)
  })

  test('different conversations are not blocked by each other', async () => {
    const store = memoryStore()
    const order: string[] = []

    await Promise.all([
      store.withLock('slow', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        order.push('slow')
      }),
      store.withLock('fast', async () => {
        order.push('fast')
      }),
    ])

    expect(order).toEqual(['fast', 'slow'])
  })

  test('a failed critical section releases the lock', async () => {
    const store = memoryStore()

    await expect(
      store.withLock('c1', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    await expect(store.withLock('c1', async () => 'ok')).resolves.toBe('ok')
  })
})
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run tests/store/memory.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/store/memory.js"`.

- [ ] **Step 3: Escrever `src/store/types.ts`**

```ts
import type { ConversationState } from '../core/types.js'

/**
 * Where conversation state lives between events.
 *
 * `withLock` is not a convenience: two webhooks for the same conversation
 * arriving together would read-modify-write over each other and lose a
 * message. Implementations must serialise per conversation id — a Redis
 * store would use `SET NX` with a TTL.
 */
export type Store = {
  load(conversationId: string): Promise<ConversationState | null>
  save(state: ConversationState): Promise<void>
  delete(conversationId: string): Promise<void>
  withLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T>
}
```

- [ ] **Step 4: Escrever `src/store/memory.ts`**

```ts
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
```

- [ ] **Step 5: Rodar os testes e confirmar que passam**

Run: `npx vitest run && npm run typecheck`
Expected: todos PASS. Se "serialises concurrent work" falhar com 1 em vez de 50, o lock não está encadeando.

- [ ] **Step 6: Commit**

```bash
git add src/store tests/store
git commit -m "feat(store): add the Store contract and an in-memory implementation"
```

---

### Task 8: A fachada `createRuntime`

**Files:**
- Create: `src/runtime/runtime.ts`, `src/index.ts`, `src/core/index.ts`
- Test: `tests/runtime/runtime.test.ts`

**Interfaces:**
- Consumes: `reduce`, `initialState`, tipos do núcleo (Tasks 1–5); `Store`, `memoryStore` (Task 7).
- Produces: `createRuntime(options: RuntimeOptions): Runtime` com `on`, `ingest`, `takeover`, `release`, `stop`; tipos `Turn`, `Drop`, `RuntimeOptions`, `Runtime`. Reexports públicos em `src/index.ts` e `src/core/index.ts`.

- [ ] **Step 1: Escrever o teste que falha**

`tests/runtime/runtime.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createRuntime } from '../../src/runtime/runtime.js'
import { memoryStore } from '../../src/store/memory.js'
import type { Drop, Turn } from '../../src/runtime/runtime.js'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  vi.useRealTimers()
})

function setup() {
  const turns: Turn[] = []
  const drops: Drop[] = []
  const runtime = createRuntime({ store: memoryStore(), quietMs: 2_500, maxWaitMs: 15_000 })
  runtime.on('turn', (turn) => {
    turns.push(turn)
  })
  runtime.on('drop', (drop) => {
    drops.push(drop)
  })
  return { runtime, turns, drops }
}

describe('createRuntime', () => {
  test('emits one turn for a burst of fragmented messages', async () => {
    const { runtime, turns } = setup()

    await runtime.ingest({ conversationId: 'c1', messageId: 'm1', text: 'hi' })
    await vi.advanceTimersByTimeAsync(800)
    await runtime.ingest({ conversationId: 'c1', messageId: 'm2', text: 'about the flat' })
    await vi.advanceTimersByTimeAsync(600)
    await runtime.ingest({ conversationId: 'c1', messageId: 'm3', text: 'the one downtown' })

    expect(turns).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(2_500)

    expect(turns).toHaveLength(1)
    expect(turns[0]?.messages.map((m) => m.text)).toEqual([
      'hi',
      'about the flat',
      'the one downtown',
    ])
    expect(turns[0]?.isNewSession).toBe(true)

    await runtime.stop()
  })

  test('reports a redelivered message as a drop', async () => {
    const { runtime, drops } = setup()

    await runtime.ingest({ conversationId: 'c1', messageId: 'm1', text: 'hi' })
    await runtime.ingest({ conversationId: 'c1', messageId: 'm1', text: 'hi' })
    await vi.advanceTimersByTimeAsync(2_500)

    expect(drops).toEqual([{ conversationId: 'c1', messageId: 'm1', reason: 'duplicate' }])

    await runtime.stop()
  })

  test('takeover cancels the pending turn', async () => {
    const { runtime, turns } = setup()

    await runtime.ingest({ conversationId: 'c1', messageId: 'm1', text: 'hi' })
    await runtime.takeover({ conversationId: 'c1' })
    await vi.advanceTimersByTimeAsync(10_000)

    expect(turns).toEqual([])

    await runtime.stop()
  })

  test('release lets the bot answer again', async () => {
    const { runtime, turns } = setup()

    await runtime.takeover({ conversationId: 'c1' })
    await runtime.release({ conversationId: 'c1' })
    await runtime.ingest({ conversationId: 'c1', messageId: 'm1', text: 'hello?' })
    await vi.advanceTimersByTimeAsync(2_500)

    expect(turns).toHaveLength(1)

    await runtime.stop()
  })

  test('a throwing turn handler surfaces on the error channel', async () => {
    const errors: unknown[] = []
    const runtime = createRuntime({ store: memoryStore(), quietMs: 1_000 })
    runtime.on('turn', () => {
      throw new Error('handler blew up')
    })
    runtime.on('error', (error) => {
      errors.push(error)
    })

    await runtime.ingest({ conversationId: 'c1', messageId: 'm1', text: 'hi' })
    await vi.advanceTimersByTimeAsync(1_000)

    expect((errors[0] as Error).message).toBe('handler blew up')

    await runtime.stop()
  })

  test('stop clears pending timers', async () => {
    const { runtime, turns } = setup()

    await runtime.ingest({ conversationId: 'c1', messageId: 'm1', text: 'hi' })
    await runtime.stop()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(turns).toEqual([])
  })
})
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run tests/runtime/runtime.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/runtime/runtime.js"`.

- [ ] **Step 3: Escrever `src/runtime/runtime.ts`**

```ts
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

  return {
    on(event: 'turn' | 'drop' | 'error', handler: never): void {
      if (event === 'turn') turnHandlers.push(handler)
      else if (event === 'drop') dropHandlers.push(handler)
      else errorHandlers.push(handler)
    },

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
  } as Runtime
}
```

- [ ] **Step 4: Escrever os barrels `src/index.ts` e `src/core/index.ts`**

`src/index.ts`:

```ts
export { createRuntime, DEFAULT_POLICY } from './runtime/runtime.js'
export type { Drop, Runtime, RuntimeOptions, Turn } from './runtime/runtime.js'
export { memoryStore } from './store/memory.js'
export type { Store } from './store/types.js'
export type {
  BufferedMessage,
  ConversationState,
  DropReason,
  Effect,
  Event,
  Policy,
} from './core/types.js'
```

`src/core/index.ts`:

```ts
export { deadline, initialState, reduce } from './reduce.js'
export type {
  BufferedMessage,
  ConversationState,
  DropReason,
  Effect,
  Event,
  Policy,
} from './types.js'
```

- [ ] **Step 5: Rodar os testes e confirmar que passam**

Run: `npx vitest run && npm run typecheck`
Expected: todos PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime src/index.ts src/core/index.ts tests/runtime
git commit -m "feat(runtime): add the facade that executes effects and owns timers"
```

---

### Task 9: Build e CI

**Files:**
- Create: `tsup.config.ts`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- Modify: `package.json`

**Interfaces:**
- Consumes: `src/index.ts`, `src/core/index.ts` (Task 8).
- Produces: `dist/` com ESM, CJS e tipos; entradas `.` e `./core` no exports map; CI verde em Node 20 e 22.

- [ ] **Step 1: Instalar o tsup**

Run: `npm install --save-dev tsup@^8.3.0`
Expected: entra em `devDependencies`.

- [ ] **Step 2: Criar `tsup.config.ts`**

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/core/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
})
```

- [ ] **Step 3: Completar o `package.json`**

Acrescentar/substituir estes campos (o resto permanece como na Task 1):

```json
{
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    },
    "./core": {
      "types": "./dist/core/index.d.ts",
      "import": "./dist/core/index.js",
      "require": "./dist/core/index.cjs"
    }
  },
  "files": ["dist", "README.md", "LICENSE"],
  "sideEffects": false,
  "engines": { "node": ">=20" },
  "keywords": [
    "chatbot",
    "whatsapp",
    "agent",
    "llm",
    "debounce",
    "idempotency",
    "conversation"
  ],
  "repository": {
    "type": "git",
    "url": "git+https://github.com/luantaraschi/lull.git"
  },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "npm run typecheck && npm run test && npm run build"
  }
}
```

- [ ] **Step 4: Rodar o build e verificar a saída**

Run: `npm run build && ls dist`
Expected: `index.js`, `index.cjs`, `index.d.ts`, `core/index.js`, `core/index.cjs`, `core/index.d.ts`.

- [ ] **Step 5: Verificar o pacote com `publint` e `attw`**

Run: `npx publint && npx --yes @arethetypeswrong/cli --pack`
Expected: nenhum problema. Se o `attw` reclamar de resolução ESM/CJS, o culpado costuma ser o exports map — corrija-o, não desative a checagem.

- [ ] **Step 6: Criar `.github/workflows/ci.yml`**

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run test -- --coverage
      - run: npm run build
```

- [ ] **Step 7: Criar `.github/workflows/release.yml`**

```yaml
name: release

on:
  push:
    tags: ['v*']

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
          cache: npm
      - run: npm ci
      - run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsup.config.ts .github
git commit -m "build: ship dual ESM/CJS output and wire CI"
```

---

### Task 10: Exemplo executável

**Files:**
- Create: `examples/webhook.ts`
- Modify: `package.json` (script `example`, devDependency `tsx`)

**Interfaces:**
- Consumes: `createRuntime`, `memoryStore` (Task 8).
- Produces: `npm run example` — sobe um servidor local, dispara um webhook fragmentado com duplicata e takeover, imprime os turnos. Sem credencial nenhuma.

- [ ] **Step 1: Instalar o `tsx`**

Run: `npm install --save-dev tsx@^4.19.0`
Expected: entra em `devDependencies`.

- [ ] **Step 2: Criar `examples/webhook.ts`**

```ts
/**
 * Runs a whole conversation against a local webhook: fragmented messages, a
 * redelivered one, and a human stepping in. No API keys, no accounts.
 *
 *   npm run example
 */
import { createServer } from 'node:http'
import { createRuntime, memoryStore } from '../src/index.js'

const runtime = createRuntime({
  store: memoryStore(),
  quietMs: 1_000,
  maxWaitMs: 5_000,
  takeoverTtlMs: 3_000,
})

runtime.on('turn', (turn) => {
  const text = turn.messages.map((m) => m.text).join(' ')
  console.log(`\n[turn] ${turn.conversationId} (new session: ${turn.isNewSession})`)
  console.log(`       "${text}"`)
  console.log(`       -> this is where you would call your LLM, once, with ${turn.messages.length} message(s)`)
})

runtime.on('drop', (drop) => {
  console.log(`[drop] ${drop.messageId} (${drop.reason})`)
})

runtime.on('error', (error) => {
  console.error('[error]', error)
})

const server = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => {
    body += chunk
  })
  request.on('end', () => {
    const payload = JSON.parse(body) as {
      kind: 'message' | 'takeover' | 'release'
      conversationId: string
      messageId?: string
      text?: string
    }

    const done =
      payload.kind === 'message'
        ? runtime.ingest({
            conversationId: payload.conversationId,
            messageId: payload.messageId!,
            text: payload.text!,
          })
        : payload.kind === 'takeover'
          ? runtime.takeover({ conversationId: payload.conversationId })
          : runtime.release({ conversationId: payload.conversationId })

    void done.then(() => {
      response.writeHead(200).end('ok')
    })
  })
})

const port = 3999
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function post(payload: Record<string, unknown>): Promise<void> {
  await fetch(`http://localhost:${port}/webhook`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

server.listen(port, async () => {
  const conversationId = '5573999999999'

  console.log('--- fragmented burst: four balloons, one turn ---')
  await post({ kind: 'message', conversationId, messageId: 'm1', text: 'hi' })
  await wait(300)
  await post({ kind: 'message', conversationId, messageId: 'm2', text: 'i wanted to ask' })
  await wait(300)
  await post({ kind: 'message', conversationId, messageId: 'm3', text: 'about the flat' })
  await wait(200)
  await post({ kind: 'message', conversationId, messageId: 'm4', text: 'the one downtown' })

  console.log('--- the gateway redelivers m4 ---')
  await post({ kind: 'message', conversationId, messageId: 'm4', text: 'the one downtown' })

  await wait(1_500)

  console.log('\n--- a human takes over, the bot goes quiet ---')
  await post({ kind: 'takeover', conversationId })
  await post({ kind: 'message', conversationId, messageId: 'm5', text: 'and the price?' })
  await wait(1_500)

  console.log('\n--- the human releases the conversation ---')
  await post({ kind: 'release', conversationId })
  await post({ kind: 'message', conversationId, messageId: 'm6', text: 'are you still there?' })
  await wait(1_500)

  await runtime.stop()
  server.close()
})
```

- [ ] **Step 3: Acrescentar o script ao `package.json`**

```json
"example": "tsx examples/webhook.ts"
```

- [ ] **Step 4: Rodar o exemplo**

Run: `npm run example`
Expected: um `[turn]` com as quatro mensagens juntas, um `[drop] m4 (duplicate)`, um `[drop] m5 (paused)`, e um `[turn]` final com "are you still there?". O processo encerra sozinho.

- [ ] **Step 5: Commit**

```bash
git add examples package.json package-lock.json
git commit -m "docs: add a runnable webhook example with no credentials"
```

---

### Task 11: Benchmark

**Files:**
- Create: `bench/coalescing.ts`
- Modify: `package.json` (script `bench`)

**Interfaces:**
- Consumes: `reduce`, `initialState` (Tasks 1–5).
- Produces: `npm run bench` — número reproduzível de redução de chamadas ao LLM. Roda sobre o núcleo puro, sem timers, portanto é determinístico.

- [ ] **Step 1: Criar `bench/coalescing.ts`**

```ts
/**
 * How many LLM calls does coalescing save?
 *
 * Simulates conversations where people type the way they actually do — a
 * burst of short balloons, then a pause — and compares one-call-per-message
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
```

- [ ] **Step 2: Acrescentar o script ao `package.json`**

```json
"bench": "tsx bench/coalescing.ts"
```

- [ ] **Step 3: Rodar o benchmark**

Run: `npm run bench`
Expected: quatro linhas de saída; `turns` exatamente igual a `CONVERSATIONS * BURSTS_PER_CONVERSATION` (6.000), `messages` por volta de 21.000 (média de 3,5 balões por rajada) e a redução na faixa de 65–75%. **Anote o número real** — ele vai literalmente para o README e para o currículo.

- [ ] **Step 4: Rodar duas vezes e confirmar que o número é idêntico**

Run: `npm run bench && npm run bench`
Expected: saídas idênticas. Se variarem, alguma coisa está usando `Math.random` em vez do gerador semeado.

- [ ] **Step 5: Commit**

```bash
git add bench package.json
git commit -m "bench: measure how many LLM calls coalescing avoids"
```

---

### Task 12: README, licença e publicação

**Files:**
- Create: `README.md`, `LICENSE`
- Modify: `package.json` (`version`)

**Interfaces:**
- Consumes: tudo. É a embalagem.
- Produces: pacote publicado em `@luantaraschi/lull` e uma tag `v0.1.0`.

- [ ] **Step 1: Criar `LICENSE`**

MIT, `Copyright (c) 2026 Luan Taraschi`. Texto padrão da licença MIT.

- [ ] **Step 2: Escrever o `README.md`**

Substituir `NN%` pelo número medido na Task 11.

````markdown
# lull

Your bot answers four times because the user sent four balloons.

```
19:04:02  "hi"
19:04:03  "i wanted to ask"
19:04:04  "about the flat"
19:04:05  "the one downtown"
```

Four webhooks. Four LLM calls. Four replies to a single question, and the last
three were written without knowing what the user was still typing.

lull waits for the conversation to fall quiet, then hands you one turn:

```ts
import { createRuntime, memoryStore } from '@luantaraschi/lull'

const runtime = createRuntime({ store: memoryStore() })

runtime.on('turn', async ({ conversationId, messages, isNewSession }) => {
  const reply = await myAgent(messages)      // your LLM, your choice
  await whatsapp.send(conversationId, reply)
})

// in your webhook handler
await runtime.ingest({ conversationId, messageId, text })
```

In a benchmark of 1,000 conversations typed the way people actually type,
that is **NN% fewer LLM calls** (`npm run bench` — the number is reproducible).

## What it handles

**Fragmented messages.** Balloons are coalesced into one turn, closed after
`quietMs` of silence and capped by `maxWaitMs` so a user who never stops
typing still gets an answer.

**Redelivered webhooks.** Gateways retry. The same `messageId` twice produces
one event, tracked in a bounded window per conversation.

**Human takeover.** `runtime.takeover({ conversationId })` and the bot goes
quiet for a TTL. Messages that arrive meanwhile are dropped, not queued — when
the TTL lapses, the bot must not wake up and answer twenty messages a human
already handled.

**Session expiry.** After `sessionTtlMs` of inactivity the next turn arrives
with `isNewSession: true`, which is your cue to reset the LLM context.

## What it does not handle

It does not call an LLM. It does not know what WhatsApp is. It does not
transcribe audio, manage prompts, or store conversation history. It does not
persist: `Store` is an interface and the only implementation shipped is
in-memory.

That list is deliberate. lull is the part every chat agent rewrites badly; the
rest already has good libraries.

## Install

```bash
npm i @luantaraschi/lull
```

## Configuration

| Option           | Default   | What it does                                          |
| ---------------- | --------- | ----------------------------------------------------- |
| `quietMs`        | `2500`    | Silence that closes a turn                             |
| `maxWaitMs`      | `15000`   | Hard cap from the first buffered message               |
| `sessionTtlMs`   | `1800000` | Inactivity after which the next turn starts a session  |
| `takeoverTtlMs`  | `900000`  | How long a human takeover keeps the bot quiet          |
| `dedupeWindow`   | `200`     | Recent message ids remembered per conversation         |

## Design

The core is a pure function:

```ts
import { reduce, initialState } from '@luantaraschi/lull/core'

const [next, effects] = reduce(state, { type: 'message', id, text, at }, policy)
```

It never reads the clock, never creates a timer, never touches the network.
Every event carries its own `at`, and the reducer returns effects as data
(`emitTurn`, `schedule`, `cancel`, `drop`). The facade executes them.

That is why "four messages in eight seconds, then silence" is a test with no
mocks, no fake timers and no sleeping:

```
message  at 1000  ──► buffer, schedule 3500
message  at 1800  ──► buffer, schedule 4300
message  at 2400  ──► buffer, schedule 4900
tick     at 4900  ──► emitTurn ["hi", "i wanted to ask", "about the flat"]
                             │
             min(lastMessage + quietMs, firstBuffered + maxWaitMs)
```

It also means you can run the core inside a worker, a Durable Object or a
Lambda without the facade's timers.

### Decisions worth knowing

**Messages during a takeover are dropped, not buffered.** Keeping them would
mean the bot returns from its TTL answering a conversation the human already
closed — the worst possible behaviour in a real support channel.

**Deduplication is a window, not a history.** The last 200 ids per
conversation. A redelivered webhook arrives within seconds, not days; keeping
every id forever is a memory leak dressed up as correctness.

**Sessions and takeovers expire lazily.** No background sweep, no global
state: the next event on a conversation decides what has lapsed.

### Storage

`memoryStore()` is in-process. To go further, implement four methods:

```ts
type Store = {
  load(conversationId: string): Promise<ConversationState | null>
  save(state: ConversationState): Promise<void>
  delete(conversationId: string): Promise<void>
  withLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T>
}
```

`withLock` is not optional. Two webhooks for the same conversation arriving
together will read-modify-write over each other and lose a message. The
in-memory store chains promises per id; a Redis store would use `SET NX`.

### Known limitation

The facade schedules with `setTimeout`, so it runs in a single process.
Multiple instances need a store with a due index (`listDue(now)`) driving the
ticks; the state is serialisable and the interface is ready for it, but that
implementation is not shipped.

## Try it

```bash
git clone https://github.com/luantaraschi/lull && cd lull
npm install
npm run example
```

A local webhook, a fragmented burst, a redelivered message and a human taking
over. No API keys.

## License

MIT
````

- [ ] **Step 3: Verificar o exemplo do README contra o código real**

Run: `npm run build && node -e "import('./dist/index.js').then(m => console.log(Object.keys(m)))"`
Expected: a lista inclui `createRuntime` e `memoryStore`. Todo símbolo citado no README tem que aparecer aqui.

- [ ] **Step 4: Rodar a verificação completa**

Run: `npm run typecheck && npm run test -- --coverage && npm run build && npm run example && npm run bench`
Expected: tudo verde; a porcentagem impressa pelo bench bate com a do README.

- [ ] **Step 5: Commit e tag**

```bash
git add README.md LICENSE package.json
git commit -m "docs: write the README and license the package"
npm version 0.1.0 -m "release: v%s"
```

- [ ] **Step 6: Publicar**

Requer o repositório no GitHub e o segredo `NPM_TOKEN` configurado.

```bash
git push origin main --follow-tags
```

Expected: o workflow `release` publica `@luantaraschi/lull@0.1.0` com proveniência. Confirme em `https://www.npmjs.com/package/@luantaraschi/lull` — o badge "Provenance" tem que aparecer.

Alternativa manual, se preferir publicar antes de configurar o CI:

```bash
npm publish --access public
```

---

## Depois do plano

O que fazer com o repositório pronto, já que o objetivo é currículo:

1. **Descrição e topics no GitHub** — `chatbot`, `llm`, `whatsapp`, `typescript`, `agents`. É por aí que alguém tropeça no projeto.
2. **A linha do currículo**, com o número do bench no lugar de adjetivo: *"@luantaraschi/lull — biblioteca TypeScript de runtime conversacional para agentes de atendimento (coalescing de mensagens, idempotência de webhook, takeover humano). Núcleo puro testado por propriedades; NN% menos chamadas ao LLM em conversas fragmentadas."*
3. **Um post técnico** sobre a decisão do reducer puro com efeitos declarativos e o porquê de `withLock` — é o conteúdo que circula, e é exatamente o assunto que você quer que apareça na entrevista.
