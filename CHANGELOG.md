# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

- The facade schedules with `setTimeout`, so it runs in a single process.
  Multiple instances need a store with a due index (`listDue(now)`).
- `memoryStore()` keeps state in process memory; it is lost on restart.

[Unreleased]: https://github.com/luantaraschi/lull/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/luantaraschi/lull/releases/tag/v0.1.0
