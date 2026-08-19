## What this changes

<!-- What it does, and the problem it solves. If an issue agreed the shape, link it. -->

## How it was checked

<!-- The test that fails before and passes after. For a change to a default or to timing,
     paste the output of npm run bench:sweep. -->

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run format:check`
- [ ] `CHANGELOG.md` updated under `[Unreleased]`, if this is visible to somebody using the package

## Constraints

<!-- Tick what applies, or say why the change needs an exception. -->

- [ ] The core stays pure: no timers, no clock, no network in `src/core`
- [ ] No new runtime dependencies
- [ ] No sleeping tests in the core
- [ ] Anything the reducer keeps is still serializable
