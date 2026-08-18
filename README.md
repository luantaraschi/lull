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
that is **71.3% fewer LLM calls** (`npm run bench` — the number is reproducible).

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

| Option          | Default   | What it does                                          |
| --------------- | --------- | ----------------------------------------------------- |
| `quietMs`       | `2500`    | Silence that closes a turn                             |
| `maxWaitMs`     | `15000`   | Hard cap from the first buffered message               |
| `sessionTtlMs`  | `1800000` | Inactivity after which the next turn starts a session  |
| `takeoverTtlMs` | `900000`  | How long a human takeover keeps the bot quiet          |
| `dedupeWindow`  | `200`     | Recent message ids remembered per conversation         |

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
message  at 1000  --> buffer, schedule 3500
message  at 1800  --> buffer, schedule 4300
message  at 2400  --> buffer, schedule 4900
tick     at 4900  --> emitTurn ["hi", "i wanted to ask", "about the flat"]
                             |
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
