# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The README now uses a transparent, theme-aware `lull` wordmark, with editable
  HTML source and matching PNG exports included in the npm package.
- `quietMs` now defaults to `5000`, where it was `2500`. The sweep behind
  [Choosing quietMs](docs/tuning.md) has the bot answering before the person had
  finished in 47% of bursts at 2500 and 25% at 5000, while avoiding more model
  calls at the same time, so the old default was buying interruptions and
  nothing else. Pass `quietMs: 2_500` to keep the previous behaviour.

## [0.3.0] - 2026-08-19

### Added

- A `typing` event. Feed it the presence your channel already emits, with
  `runtime.typing({ conversationId })` or a `{ type: 'typing', at }` event on
  the core, and an open turn stays open while the person composes. It never
  opens a turn, and `maxWaitMs` still caps it, so somebody who types without
  ever sending still gets an answer.
- `policyFor`, a per-conversation policy override on `createRuntime`. It runs
  before the conversation is locked, so it may read a database.
- `npm run bench:sweep`, measuring what `quietMs` costs, and
  [Choosing quietMs](docs/tuning.md) with the resulting table. At the 2500ms
  default the bot answers before the person has finished in 47% of bursts; at
  6000ms that falls to 14%.

### Changed

- `deadline()` now reads `max(lastMessageAt, lastTypingAt)`. State written by
  earlier versions has no `lastTypingAt` and keeps working unchanged.

## [0.2.0] - 2026-08-18

### Added

- `redisStore()`, exported from `@luantaraschi/lull/redis`: shared state and
  cross-instance mutual exclusion. Locks use `SET NX PX` and are released with
  a compare-and-delete script, so a section that outlives its TTL cannot
  release its successor's lock. The client is duck-typed, so the package still
  has no runtime dependencies.
- A serverless recipe (`npm run example:serverless`) showing how to drive the
  pure core from stateless handlers, with an external scheduler delivering the
  ticks.
- An [API reference](docs/api.md) covering every export, option and event.
- A showcase page at https://luantaraschi.github.io/lull/ that runs the
  library's own reducer in the browser, compiled from `src/core` at deploy time.

### Changed

- CI now checks formatting, enforces a coverage floor, and runs `publint` and
  `attw` against the packed tarball, so the published shape cannot regress
  unnoticed.

## [0.1.0] - 2026-08-18

First release.

### Added

- Pure core reducer (`reduce(state, event, policy)`) that never reads the clock,
  creates a timer, or touches the network. Exported from `@luantaraschi/lull/core`.
- Message coalescing: balloons are buffered and released as one turn after
  `quietMs` of silence, capped by `maxWaitMs`.
- Webhook idempotency: a redelivered `messageId` is dropped, tracked in a
  bounded window of the last `dedupeWindow` ids per conversation.
- Human takeover: `takeover()` silences the bot for `takeoverTtlMs` and discards
  buffered messages; `release()` brings it back. Messages arriving during the
  pause are dropped rather than queued.
- Session expiry: after `sessionTtlMs` of inactivity the next turn carries
  `isNewSession: true`.
- `Store` interface with `load`, `save`, `delete` and `withLock`, plus the
  in-memory implementation `memoryStore()`.
- `createRuntime()` facade owning timers and effect execution, with `turn`,
  `drop` and `error` channels.
- Dual ESM/CJS build with type declarations, and a `./core` subpath export.

### Known limitations

- The facade schedules with `setTimeout`, so timers live in the process that
  received the message. `redisStore()` (unreleased) shares state across
  instances, but a process dying with a turn buffered leaves that turn waiting
  for the next message.
- `memoryStore()` keeps state in process memory; it is lost on restart.

[Unreleased]: https://github.com/luantaraschi/lull/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/luantaraschi/lull/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/luantaraschi/lull/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/luantaraschi/lull/releases/tag/v0.1.0
