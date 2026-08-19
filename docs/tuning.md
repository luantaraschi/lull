# Choosing quietMs

The default is 2500ms. It is a starting point, not a recommendation, and for a
support channel with real people typing it is probably too short.

## What the number costs

`npm run bench:sweep` runs a thousand conversations at several settings. The gap
model is stated in the script rather than buried: about two thirds of balloons
follow the previous one inside a second, and the rest come after a longer pause,
because the person stopped to think or is writing something longer.

| quietMs | Calls avoided | Bursts interrupted | Mean wait |
| ------- | ------------- | ------------------ | --------- |
| 1500    | 48.8%         | 53.1%              | 1.5s      |
| 2500    | 52.6%         | 47.2%              | 2.5s      |
| 4000    | 59.0%         | 34.7%              | 4.0s      |
| 6000    | 67.3%         | 13.7%              | 5.8s      |
| 8000    | 70.8%         | 2.4%               | 7.2s      |
| 12000   | 70.8%         | 2.4%               | 9.6s      |

"Bursts interrupted" is the column that decides it: how often the bot answered
before the person had finished. At the default that happens in nearly half of
them.

Two things the table settles. Between 2500 and 6000 waiting longer wins on both
axes at once, cutting interruptions from 47% to 14% while avoiding more calls,
so anything in that range is not a trade-off, it is a fix. And past 8000 nothing
further merges: the two bottom rows are identical except for the wait, which is
latency you pay for nothing.

**A reasonable default for a messaging channel is 5000 to 6000.** Remember the
wait is added to your model's own latency, so six seconds of silence plus three
of generation is nine seconds before anything appears. Send a typing indicator
of your own while the turn is open.

Your own traffic will not match the model above. Run the sweep with your
numbers, or measure the real gaps between inbound messages and pick the value
that puts interruptions where you want them.

## Let the channel tell you instead

Guessing the number is a worse tool than knowing. Most messaging platforms emit
a presence event while somebody is composing. Feed it in:

```ts
await runtime.typing({ conversationId })
```

That holds an open turn open, so you can keep a short `quietMs` for people who
send one message and still not cut off the person mid-sentence. It never opens
a turn: with nothing buffered there is nothing to wait for. And `maxWaitMs`
still applies, so somebody who types without ever sending still gets an answer.

## Different conversations, different patience

Policy is per runtime by default, and per conversation when you need it:

```ts
const runtime = createRuntime({
  store: memoryStore(),
  quietMs: 5_000,
  policyFor: async (conversationId) => {
    const lead = await db.lead.findUnique({ where: { conversationId } })
    return lead?.stage === 'negotiating' ? { quietMs: 2_500 } : {}
  },
})
```

`policyFor` is called once per event, before the conversation is locked, so it
may hit a database. Return nothing for the conversations that need no override.
