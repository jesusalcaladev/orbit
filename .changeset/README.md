# Changesets

The lifecycle and publishing of every package in this orbit monorepo is managed
through [Changesets](https://github.com/changesets/changesets).

- **`pnpm changeset add`** — create a new changeset describing the change (major /
  minor / patch) and which packages it affects. This is the ONLY step developers
  run during normal work; the version bump and changelog are derived from it.
- **`pnpm changeset version`** — consume all pending changesets: bump versions,
  write per-package `CHANGELOG.md` entries and update the root.
- **`pnpm changeset publish`** — build and publish each package to the registry.

## Conventions for this repo

- The protocol core (`@orbit/core`) keeps its **zero-dependency** rule. A
  changeset for `@orbit/core` must be `minor` or `major` only when the change is
  _additive_ (spec §11 / §13 allow additive extensions without a major bump);
  any subtractive or re-shaping change is a `major` and must update `spec.md`
  and the frozen contract tests in the same change.
- Companion packages (`@orbit/auth`, `@orbit/client`, `@orbit/react`,
  `@orbit/redis`, `@orbit/rest`,
  `@orbit/kv-cache`, `@orbit/cache`, `@orbit/rate-limit`, `@orbit/logging`,
  `@orbit/express`, `@orbit/hono`, `@orbit/cloudflare-workers`) bump freely with
  their own changelogs.
- The root workspace package (`orbit`) is private and **ignored** by Changesets
  (see `config.json`).
