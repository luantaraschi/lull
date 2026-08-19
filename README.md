# lull

[![ci](https://github.com/luantaraschi/lull/actions/workflows/ci.yml/badge.svg)](https://github.com/luantaraschi/lull/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@luantaraschi/lull.svg)](https://www.npmjs.com/package/@luantaraschi/lull)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**[Run it in your browser](https://luantaraschi.github.io/lull/)**, where the
page drives this library's own reducer, compiled from `src/core`.

Conversation runtime for chat agents. It handles the four channel problems every
WhatsApp or support bot ends up rewriting badly: fragmented messages,
redelivered webhooks, human takeover, and session expiry.

## The problem

Someone types this:

```
19:04:02  "hi"
19:04:03  "i wanted to ask"
19:04:04  "about the flat"
19:04:05  "the one downtown"
```

Four webhooks. Four model calls. Four replies to a single question, and the last
three were written without knowing what the user was still typing.

lull waits for the conversation to fall quiet, then hands you one turn:

```ts
import { createRuntime, memoryStore } from '@luantaraschi/lull'

const runtime = createRuntime({ store: memoryStore() })

runtime.on('turn', async ({ conversationId, messages, isNewSession }) => {
  const reply = await myAgent(messages) // your LLM, your choice
  await whatsapp.send(conversationId, reply)
})

// in your webhook handler
await runtime.ingest({ conversationId, messageId, text })
```

Across 1,000 simulated conversations typed the way people actually type, that is
**71.3% fewer model calls**: 20,888 messages became 6,000 turns. Run `npm run
bench` to reproduce the number.

## Install

```bash
npm i @luantaraschi/lull
```

Node 20 or newer. No runtime dependencies. Published from CI with provenance,
so npm shows which commit and which workflow built the tarball.

## What it handles

Fragmented messages are coalesced into one turn, closed after `quietMs` of
silence and capped by `maxWaitMs` so a user who never stops typing still gets an
answer.

Redelivered webhooks produce one event. Gateways retry, and the same `messageId`
twice is tracked in a bounded window per conversation.

Human takeover silences the bot. Call `runtime.takeover({ conversationId })` and
it stays quiet for a TTL. Messages arriving in the meantime are dropped rather
than queued, so when the TTL lapses the bot does not wake up and answer twenty
messages a colleague already handled.

Sessions expire. After `sessionTtlMs` of inactivity the next turn arrives with
`isNewSession: true`, which is your cue to reset the model context.

## What it does not handle

It does not call a model. It does not know what WhatsApp is. It does not
transcribe audio, manage prompts, or store conversation history. It does not
persist on its own: `Store` is an interface, and the implementations shipped are
in-memory and Redis.

That list is deliberate. lull is the part every chat agent rewrites badly, and
the rest already has good libraries.

## Configuration

| Option          | Default   | What it does                                          |
| --------------- | --------- | ----------------------------------------------------- |
| `quietMs`       | `5000`    | Silence that closes a turn                            |
| `maxWaitMs`     | `15000`   | Hard cap from the first buffered message              |
| `sessionTtlMs`  | `1800000` | Inactivity after which the next turn starts a session |
| `takeoverTtlMs` | `900000`  | How long a human takeover keeps the bot quiet         |
| `dedupeWindow`  | `200`     | Recent message ids remembered per conversation        |

The runtime also emits `drop` (with a reason of `duplicate` or `paused`) and
`error`, so you can measure what the bot chose not to answer. Every export,
option and event is listed in the [API reference](docs/api.md).

`quietMs` is worth measuring rather than guessing. In a simulation of a thousand
conversations, the default has the bot answering before the person finished in
25% of bursts; at 2500 that was 47%, and at 6000 it falls to 14%. See
[choosing quietMs](docs/tuning.md), or run `npm run bench:sweep`. If your channel
reports when somebody is composing, pass it along with
`runtime.typing({ conversationId })`: it holds an open turn open while they
type, which beats guessing at a number. Conversations that need different
patience get it through `policyFor`.

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
mocks, no fake timers, and no sleeping:

```
message  at 1000  ->  buffer, schedule 3500
message  at 1800  ->  buffer, schedule 4300
message  at 2400  ->  buffer, schedule 4900
tick     at 4900  ->  emitTurn ["hi", "i wanted to ask", "about the flat"]
                              |
              min(lastMessage + quietMs, firstBuffered + maxWaitMs)
```

It also means you can run the core inside a worker, a Durable Object, or a
Lambda without the facade timers.

### Decisions worth knowing

Messages during a takeover are dropped, not buffered. Keeping them would mean
the bot returns from its TTL answering a conversation the human already closed,
which is the worst behaviour available in a real support channel.

Deduplication is a window, not a history: the last 200 ids per conversation. A
redelivered webhook arrives within seconds, not days, and keeping every id
forever is a memory leak dressed up as correctness.

Sessions and takeovers expire lazily. There is no background sweep and no global
state. The next event on a conversation decides what has lapsed.

## Storage

`memoryStore()` keeps state in the process. For more than one instance, use
Redis:

```ts
import Redis from 'ioredis'
import { createRuntime } from '@luantaraschi/lull'
import { redisStore } from '@luantaraschi/lull/redis'

const runtime = createRuntime({ store: redisStore(new Redis(process.env.REDIS_URL)) })
```

The client is duck-typed, so lull never imports one and stays dependency free.
Any client with ioredis-style `get`, `set`, `del`, and `eval` works. Locks are
taken with `SET NX PX` and released with a compare-and-delete script, so a
section that outlives its own TTL cannot delete the lock its successor holds.

To write your own store, implement four methods:

```ts
type Store = {
  load(conversationId: string): Promise<ConversationState | null>
  save(state: ConversationState): Promise<void>
  delete(conversationId: string): Promise<void>
  withLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T>
}
```

`withLock` is not optional. Two webhooks for the same conversation arriving
together will read-modify-write over each other and lose a message.

## Serverless, or anywhere no process stays alive

The facade owns timers, and a serverless function is gone before any timer
fires. Skip it: drive the core directly and let something outside deliver the
tick.

```ts
import { initialState, reduce } from '@luantaraschi/lull/core'

const state = (await db.get(conversationId)) ?? initialState(conversationId)
const [next, effects] = reduce(state, { type: 'message', id, text, at: Date.now() }, policy)
await db.put(conversationId, next)
// `schedule` tells you when to come back: an n8n Wait node, a delayed queue
// message, a cron row. `emitTurn` is the cue to call your model.
```

`npm run example:serverless` walks through it. The state is a plain serialisable
object, so any store will do.

### Known limitation

With the facade, timers live in the process that received the message. If that
process dies with a turn buffered, the turn waits for the next message instead
of firing on time. A store with a due index (`listDue(now)`) driving the ticks
would close that gap. It is not shipped.

## Try it

The [demo page](https://luantaraschi.github.io/lull/) runs the reducer in the
browser: send a burst of messages and watch the deadline slide, then hand the
conversation to a human and watch the bot go quiet.

Locally, the same behaviour against a real webhook:

```bash
git clone https://github.com/luantaraschi/lull && cd lull
npm install
npm run example
```

A local webhook, a fragmented burst, a redelivered message, and a human taking
over. No API keys.

## Tests

```bash
npm test
```

46 tests. The reducer is covered by a table of timing scenarios and by three
property-based tests over random event sequences: no message is ever lost, no
turn is emitted while the bot is paused, and the dedupe window never grows past
its bound. The Redis lock has a test that was verified by breaking the
implementation on purpose to watch it fail.

## Contributing

Issues and pull requests are welcome. Because the core is a pure function, a bug
report can usually be written as events in and effects out, which is the fastest
kind to fix. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup, the workflow and
the constraints a change has to respect: the core stays pure, the package keeps
no runtime dependencies, its tests do not sleep, and defaults are measured
rather than chosen.

## More

- [API reference](docs/api.md), every export with its options and events
- [Choosing quietMs](docs/tuning.md), with the measurements behind the default
- [Why the core is a pure reducer](docs/writing/why-the-core-is-a-pure-reducer.md)
- [Changelog](CHANGELOG.md)
- [Design spec and implementation plan](docs/superpowers) (in Portuguese)

## License

MIT
