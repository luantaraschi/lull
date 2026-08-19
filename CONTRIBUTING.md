# Contributing

lull is small on purpose, and the aim is to keep it small while it gets better
at the four things it does. Bug reports, failing test cases, benchmark numbers
and documentation fixes are as welcome here as code.

## Getting set up

Node 20 or newer, and nothing else.

```bash
git clone https://github.com/luantaraschi/lull.git
cd lull
npm ci
npm test
```

| Command                | What it does                                              |
| ---------------------- | --------------------------------------------------------- |
| `npm test`             | The suite, once                                           |
| `npm run test:watch`   | The suite, on every save                                  |
| `npm run typecheck`    | `tsc --noEmit`                                            |
| `npm run format`       | Prettier over the repository                              |
| `npm run format:check` | The same check CI runs                                    |
| `npm run bench`        | What coalescing saves, seeded so it prints the same twice |
| `npm run bench:sweep`  | What `quietMs` costs and buys, across a range             |
| `npm run example`      | A fake webhook feed through the runtime                   |
| `npm run build:site`   | Compiles `src/core` into `site/vendor` for the page       |

## Reporting a bug

The core is a pure function, so most bugs can be written down as events in and
effects out. A report in that shape is halfway to a fix:

- the policy you were running
- the events, with the timestamps you passed on them
- the effects you expected, and the ones you got

If it only happens with a store, say which one, and whether `memoryStore()`
shows it too. If it only happens under a real channel, the timestamps still tell
most of the story.

## Proposing a change

Open an issue first for anything that changes behaviour, adds an option or
touches the public API. Agreeing on the shape in a paragraph is faster than
agreeing on it in a diff. For typos, missing tests and small fixes, skip the
issue and send the pull request.

## What a pull request needs

- A test that fails before the change and passes after it
- `npm test`, `npm run typecheck` and `npm run format:check` all green
- A commit message in the form the history already uses: `feat:`, `fix:`,
  `docs:`, `chore:`, `ci:`, `refactor:` or `test:`, with a scope where it helps,
  as in `feat(site):`
- An entry in `CHANGELOG.md` under `[Unreleased]` when the change is visible to
  somebody using the package

Small pull requests get read and merged. A large one is not unwelcome, but say
what it is doing in the description, because a reviewer who has to reconstruct
the intent from the diff is a reviewer who takes a week.

## The constraints

These are what the library is. A change that breaks one of them needs to argue
for it rather than around it.

**The core is a pure function.** `src/core` takes a state, an event and a policy
and returns the next state plus the effects to run. It creates no timers, opens
no sockets and never reads the clock: time arrives as a number on the event.
[Why the core is a pure reducer](docs/writing/why-the-core-is-a-pure-reducer.md)
has the reasoning.

**No runtime dependencies.** `package.json` has no `dependencies` and should not
grow any. The Redis store duck-types its client instead of importing one, and
that is the pattern to follow for anything else that talks to the outside.

**Core tests do not sleep.** Every timing question in the reducer is arithmetic
on numbers you pass in, so four messages across eight seconds is four numbers,
not four seconds of waiting. The store tests do wait on real timers, because
locks and TTLs are real.

**State stays serializable.** Whatever the reducer keeps has to survive a round
trip through JSON and somebody's database. No class instances, no functions, no
`Map`.

**Defaults are measured, not chosen.** If you want to move one, run
`npm run bench:sweep` and put the table in the pull request. That is how
`quietMs` got to where it is: see [choosing quietMs](docs/tuning.md).

## The site

`site/` is the page at [luantaraschi.github.io/lull](https://luantaraschi.github.io/lull/).
It is plain ES modules with no bundler; `npm run build:site` compiles `src/core`
into `site/vendor/` so the page drives the library's own reducer rather than a
copy of it. Serve the folder with any static server to work on it:

```bash
npm run build:site
npx serve site
```

What the page has decided, so a change can decide otherwise on purpose rather
than by accident: square corners, hairlines instead of shadows, one accent
colour that marks the moment a turn fires, and every state still reported under
`prefers-reduced-motion`, only without the movement between them.

## Releasing

Maintainer only. Releases are cut by tagging, and CI publishes from the tag with
npm provenance, so the registry shows which commit and which workflow built the
tarball.

## Code of conduct

By taking part you agree to the [code of conduct](CODE_OF_CONDUCT.md).
