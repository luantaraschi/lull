# The bug you cannot test with a mock

A chat agent has a race condition you cannot see in code review.

Someone types "hi", then "i wanted to ask", then "about the flat", then "the one
downtown". Four balloons, four webhooks, four calls to your model. Your bot
answers four times, and three of those answers were written without knowing what
the user was still typing. It costs four times as much and reads like a bot.

The fix everyone writes first is a debounce: hold the message, wait two seconds,
flush. Then the next message arrives while the timer is running, and now you own
a scheduling problem. Then the gateway redelivers a webhook and you own an
idempotency problem. Then a human on your team opens the conversation and starts
answering, and you own a mutual-exclusion problem, because your bot is about to
talk over a colleague.

None of that is about language models. All of it is about channels. And it is
where I kept finding the same class of bug: everything worked in the happy path,
and the failures only appeared under timing I could not reproduce.

## Testing time is the actual problem

The usual way to test this is fake timers and mocks. You advance the clock, you
assert that a mock was called once. That test tells you the mock was called. It
does not tell you what happens when the second message lands one millisecond
before the flush, or when a takeover arrives while messages sit in the buffer.

The trouble is not the test framework. It is that the logic and the clock are
the same object. As long as the code that decides _when to answer_ is the code
that _reads the clock and creates timers_, every test has to simulate an
environment before it can ask a question.

So I split them.

## Effects as data

The core of [lull](https://github.com/luantaraschi/lull) is one function:

```ts
reduce(state, event, policy) => [nextState, effects]
```

It never reads the clock. It never creates a timer. It never touches the
network. Every event carries its own timestamp, and the function returns what
should happen as plain data (`emitTurn`, `schedule`, `cancel`, `drop`) for
someone else to execute.

That someone else is a thin facade with the timers in it. It is the only part
of the library that knows what `Date.now()` is.

What this changes is what a test looks like:

```ts
const state = fold([
  { type: 'message', id: 'm1', text: 'hi', at: 1_000 },
  { type: 'message', id: 'm2', text: 'i wanted to ask', at: 1_800 },
  { type: 'message', id: 'm3', text: 'about the flat', at: 2_400 },
])
const [, effects] = reduce(state, { type: 'tick', at: 4_900 }, policy)

expect(effects[0]).toMatchObject({ type: 'emitTurn' })
```

No mocks. No fake timers. No sleeping. Four seconds of conversation is four
numbers. The whole turn-closing rule fits on one line,
`min(lastMessage + quietMs, firstBuffered + maxWaitMs)`, and you can read it
without holding a scheduler in your head.

It also means the tests can be generated. Three property-based tests assert
things I would never have thought to write by hand: that no message is ever
silently lost, that no turn is ever emitted while a human has the conversation,
that the deduplication window never grows past its bound. Those run over
thousands of random event sequences, and they only work because the function is
pure.

## The method nobody asks for

The library's storage interface has four methods, and reviewers always ask about
the same three. The one that matters is the fourth:

```ts
withLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T>
```

Two webhooks for the same conversation arriving together will both read the
state, both decide, and both write. One of them wins and a message disappears,
and it disappears rarely, in production, under load, in a way you will not
reproduce locally.

Making it part of the interface rather than an implementation detail is a way of
saying: you cannot implement this store correctly without answering this
question. In memory, it is a promise chain per conversation. In Redis, it is
`SET NX PX` with a compare-and-delete release. The compare matters, because
a critical section that outlives its own lock TTL would otherwise delete the
lock its successor is holding. That specific bug has a test, and the test was
verified by breaking the implementation on purpose to watch it fail.

## What it cost

A benchmark of a thousand conversations, typed the way people actually type:
20,888 messages became 6,000 turns. **71.3% fewer model calls**, and the answers
are written after the question is finished rather than during it.

The number is not the interesting part, though. The interesting part is that
after separating the decision from the clock, I could answer questions about
concurrency by reading a function instead of guessing at a log.

---

lull is MIT-licensed and on GitHub: https://github.com/luantaraschi/lull
