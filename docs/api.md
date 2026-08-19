# API reference

Three entry points. The main one gives you a running instance, `/core` gives you
the pure function underneath it, and `/redis` gives you a store.

```ts
import { createRuntime, memoryStore } from '@luantaraschi/lull'
import { reduce, initialState, deadline } from '@luantaraschi/lull/core'
import { redisStore } from '@luantaraschi/lull/redis'
```

## `@luantaraschi/lull`

### `createRuntime(options)`

Returns a `Runtime`. Nothing starts until the first event arrives.

```ts
const runtime = createRuntime({
  store: memoryStore(),
  quietMs: 2_500,
  maxWaitMs: 15_000,
  sessionTtlMs: 1_800_000,
  takeoverTtlMs: 900_000,
  dedupeWindow: 200,
  now: () => Date.now(),
})
```

| Option          | Type                      | Default    | Meaning                                               |
| --------------- | ------------------------- | ---------- | ----------------------------------------------------- |
| `store`         | `Store`                   | required   | Where conversation state lives between events         |
| `quietMs`       | `number`                  | `2500`     | Silence that closes a turn                            |
| `maxWaitMs`     | `number`                  | `15000`    | Hard cap measured from the first buffered message     |
| `sessionTtlMs`  | `number`                  | `1800000`  | Inactivity after which the next turn starts a session |
| `takeoverTtlMs` | `number`                  | `900000`   | How long a human takeover keeps the bot quiet         |
| `dedupeWindow`  | `number`                  | `200`      | Recent message ids remembered per conversation        |
| `now`           | `() => number`            | `Date.now` | Clock, injectable for tests                           |
| `policyFor`     | `(id) => Partial<Policy>` | none       | Per-conversation overrides, sync or async             |

`quietMs` decides how often the bot cuts somebody off, and the default is a
starting point rather than a recommendation. [Choosing quietMs](tuning.md) has
the measurements.

### `runtime.ingest({ conversationId, messageId, text, at? })`

Feeds one inbound message. `messageId` is what deduplication reads, so pass the
id your gateway gives you rather than one you generate. `at` defaults to the
runtime's clock; pass the gateway's timestamp when you have it.

Resolves once the reducer has run and every effect it produced has been
executed, which includes awaiting your `turn` handlers. A store failure rejects
here rather than being swallowed.

### `runtime.takeover({ conversationId, at? })`

Silences the bot for `takeoverTtlMs`. Cancels any pending turn and drops
whatever was buffered.

### `runtime.release({ conversationId, at? })`

Ends a takeover immediately. Safe to call when no takeover is active.

### `runtime.typing({ conversationId, at? })`

Tells the runtime the person is composing, from whatever presence event your
channel emits. It holds an open turn open and never opens one: with nothing
buffered there is nothing to wait for. `maxWaitMs` still applies, so somebody
who types without ever sending still gets an answer, and a takeover ignores it
entirely.

### `runtime.stop()`

Clears every pending timer and stops scheduling new ones. Call it on shutdown.
State stays in the store, so a restart resumes from it.

### `runtime.on(event, handler)`

Three channels. Handlers are called in the order they were registered.

```ts
runtime.on('turn', async ({ conversationId, sessionId, messages, isNewSession }) => {})
runtime.on('drop', ({ conversationId, messageId, reason }) => {})
runtime.on('error', (error: unknown) => {})
```

**`turn`** fires when a conversation has fallen quiet. `messages` is every
balloon that was buffered, oldest first. `isNewSession` is true on the first
turn of a session, which is the cue to reset your model context. Turn handlers
are awaited, so a slow one delays the effects behind it but never blocks
`ingest` for another conversation.

**`drop`** fires for a message the reducer refused: `reason` is `'duplicate'`
for a redelivered id, `'paused'` for one that arrived during a takeover. Nothing
in the library reacts to it. It exists so you can measure what the bot chose not
to answer.

**`error`** receives anything a `turn` or `drop` handler throws, and anything
thrown inside a scheduled tick. Without a listener those failures are silent.

### `DEFAULT_POLICY`

The five defaults above, exported so you can build a policy from them rather
than retyping the numbers. It is a plain object; spread it rather than mutating
it.

### `memoryStore()`

A `Store` that keeps state in a `Map` and serialises `withLock` with a promise
chain per conversation. Loses everything on restart. Good for a single process,
for tests, and for getting started.

## `@luantaraschi/lull/core`

The pure layer. It never reads the clock, creates a timer, or touches the
network, which is why you can run it inside a worker, a Durable Object, or a
serverless handler that will not be alive when the deadline arrives.

### `reduce(state, event, policy)`

```ts
const [next, effects] = reduce(state, event, policy)
```

Returns the next state and the effects to run. Same input, same output, always.

**Events**

```ts
{ type: 'message', id: string, text: string, at: number }
{ type: 'typing', at: number }
{ type: 'takeover', at: number }
{ type: 'release', at: number }
{ type: 'tick', at: number }
```

Every event carries `at`, in epoch milliseconds. A `tick` is how you tell the
reducer that time has passed: send one when a `schedule` effect comes due.

**Effects**

```ts
{
  type: ('emitTurn', conversationId, sessionId, messages, isNewSession)
}
{
  type: ('schedule', conversationId, at)
}
{
  type: ('cancel', conversationId)
}
{
  type: ('drop', conversationId, messageId, reason)
}
```

`schedule` **replaces** any pending timer for that conversation. It never adds
one, so a naive implementation that stacks timers will fire the same turn twice.

### `initialState(conversationId)`

The state of a conversation nothing has happened to yet. Use it when your store
returns `null`.

### `deadline(state, policy)`

When the buffered turn is due, in epoch milliseconds:
`min(max(lastMessageAt, lastTypingAt) + quietMs, firstBufferedAt + maxWaitMs)`. Exported because a
scheduler outside the facade needs the same number the reducer will use.

### `ConversationState`

```ts
type ConversationState = {
  id: string
  seen: string[]
  buffer: BufferedMessage[]
  firstBufferedAt: number | null
  lastMessageAt: number
  session: { id: string; lastActivityAt: number; turns: number } | null
  pausedUntil: number | null
  lastTypingAt?: number | null
}
```

`lastTypingAt` is optional because state written by versions before 0.3.0 does
not carry it, and every read tolerates its absence.

Plain data, JSON serialisable on purpose: it goes into Redis or a Postgres
column without translation. Session ids are derived as
`${conversationId}#${at}`, so the reducer stays free of randomness.

## `@luantaraschi/lull/redis`

### `redisStore(client, options?)`

```ts
import Redis from 'ioredis'

const store = redisStore(new Redis(process.env.REDIS_URL), {
  keyPrefix: 'lull:',
  lockTtlMs: 10_000,
  acquireTimeoutMs: 5_000,
  retryDelayMs: 20,
})
```

| Option             | Default   | Meaning                                               |
| ------------------ | --------- | ----------------------------------------------------- |
| `keyPrefix`        | `'lull:'` | Prefix for every key the store writes                 |
| `lockTtlMs`        | `10000`   | How long a held lock survives if the holder dies      |
| `acquireTimeoutMs` | `5000`    | How long to wait for a contended lock before throwing |
| `retryDelayMs`     | `20`      | Pause between acquisition attempts                    |

Locks are taken with `SET NX PX` and released with a compare-and-delete script,
so a critical section that outlives its own TTL cannot delete the lock its
successor is holding. Waiting past `acquireTimeoutMs` throws rather than
proceeding without the lock.

The client is typed structurally, so lull imports no Redis package and keeps
zero dependencies. Anything with ioredis-style `get`, `set`, `del` and `eval`
works:

```ts
type RedisLike = {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: unknown[]): Promise<string | null>
  del(key: string): Promise<number>
  eval(script: string, numKeys: number, ...args: unknown[]): Promise<unknown>
}
```

For node-redis, whose `set` takes an options object, pass a six line shim that
maps those four calls.

## Writing your own store

```ts
type Store = {
  load(conversationId: string): Promise<ConversationState | null>
  save(state: ConversationState): Promise<void>
  delete(conversationId: string): Promise<void>
  withLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T>
}
```

`load` returns `null` for a conversation that has no state yet. `withLock` has
to serialise per conversation id: two webhooks for the same conversation
arriving together will otherwise read, decide and write over each other, and one
message disappears. It is the method that makes the other three correct.
