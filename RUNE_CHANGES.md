# Rune changes
The Rune release of QMD is a build of upstream `main` with eleven changes that give Rune searches without bodies, reusable query embeddings, file updates, per-store settings, read-only stores, a fast vector cleanup and keyword search on any term.

E.g. Rune embeds a query once, searches its document and section collections without loading bodies or contexts, then refreshes one changed file without scanning either collection.

Status: Built from `rune/main` at `8d16d87`. `rune/main` is upstream `main` at `8be0c42` (QMD 2.9.0 and two commits) with one squash commit per change and six review follow-ups.

## Changes

Each change has its own branch from `main` and an open pull request against `main`, so it can go upstream as it is:

| Change | Pull request | Branch | Test |
| --- | --- | --- | --- |
| Optional hydration | [#2](https://github.com/TheLithiumForge/qmd/pull/2) | `pr/search-hydration` | `test/search-hydration.test.ts` |
| Query embeddings | [#3](https://github.com/TheLithiumForge/qmd/pull/3) | `pr/query-embedding` | `test/query-embedding.test.ts` |
| Idle timeout | [#4](https://github.com/TheLithiumForge/qmd/pull/4) | `pr/model-idle-timeout` | `test/model-idle-timeout.test.ts` |
| Targeted updates | [#5](https://github.com/TheLithiumForge/qmd/pull/5) | `pr/targeted-update` | `test/targeted-update.test.ts` |
| Store options | [#6](https://github.com/TheLithiumForge/qmd/pull/6) | `pr/store-runtime-options` | `test/store-runtime-options.test.ts` |
| Token count | [#7](https://github.com/TheLithiumForge/qmd/pull/7) | `pr/store-tokenizer` | `test/store-tokenizer.test.ts` |
| Read-only store | [#8](https://github.com/TheLithiumForge/qmd/pull/8) | `pr/read-only-store` | `test/read-only-store.test.ts` |
| CI and busy timeout | [#9](https://github.com/TheLithiumForge/qmd/pull/9) | `pr/store-ci-and-busy-options` | `test/store-ci-and-busy-options.test.ts` |
| Orphan cleanup by hash | [#10](https://github.com/TheLithiumForge/qmd/pull/10) | `pr/orphan-cleanup-index` | `test/orphan-cleanup-index.test.ts` |
| Any-term keyword search | [#11](https://github.com/TheLithiumForge/qmd/pull/11) | `pr/lex-any-term` | `test/lex-any-term.test.ts` |
| Context sizes | [#12](https://github.com/TheLithiumForge/qmd/pull/12) | `pr/store-model-settings` | `test/store-model-settings.test.ts` |

The pull request of each change says what it does, why it helps any library user and how it was tested. The busy timeout pull request works on `main` alone. On `rune/main`, a read-only store takes `busyTimeoutMs` too. The context size pull request also works on `main` alone. On `rune/main`, its two options join the `llm` group of #6.

The orphan cleanup fix makes `update()` fast again on a large index. Since upstream #1024, every `update()` ran a cleanup that read a whole collection for each vector row. On Rune's test index, one targeted update took about 25 s, and an edited file missed the 5 s keyword limit of the acceptance harness.

## Review follow-ups

A review of the ten pull requests led to six more commits. Each one is a commit on its `pr/` branch and a follow-up on `rune/main`, whose subject names the pull request:

| Pull request | Follow-up on `rune/main` | Change |
| --- | --- | --- |
| [#2](https://github.com/TheLithiumForge/qmd/pull/2) | `1ce31fb` | Both searches drop a hit without a `content` row, also without the body |
| [#3](https://github.com/TheLithiumForge/qmd/pull/3) | `e3dc207` | Tests that `close()` waits for `embedQuery()` and an abort signal fails it |
| [#4](https://github.com/TheLithiumForge/qmd/pull/4) | `216bb42` | `createStore()` rejects an invalid `modelIdleTimeoutMs` |
| [#4](https://github.com/TheLithiumForge/qmd/pull/4) | `76dc1e6` | `modelIdleTimeoutMs` stops at 2,147,483,647 ms, the largest delay a timer takes |
| [#10](https://github.com/TheLithiumForge/qmd/pull/10) | `08b3be0` | The changelog bullet joins the Fixed list |
| [#11](https://github.com/TheLithiumForge/qmd/pull/11) | `63698b0` | A test that a quoted phrase stays a phrase with `anyTerm` |

The squash commits keep their first message, since rewriting them needs a force-push. The next rebuild of `rune/main` after upstream moves folds each follow-up into its squash commit.

## Changes upstream covers

The fork on QMD 2.8.3 had ten changes. Two have no pull request, since upstream `main` already does what they did:

- Scoped KNN - upstream partitions the vector table by collection (#1024). A scoped search runs an exact KNN inside each collection's partition. The old test passes on `main` unchanged.
- Indexed chunk lookup - upstream resolves vector hits through `vector_rows` and the `(hash, seq)` primary key of `content_vectors`. Tied distances now go to the smaller file path, not to the older document.

The store tokenizer change keeps only `countTokens()`, since upstream `143176f` already chunks with the store's model.

## Release build

`rune/release` adds the JavaScript and declarations built from `rune/main`. It omits `prepare`, so installing the dependency needs neither checkout hooks nor a package-local TypeScript compiler. `test/install-hooks.test.ts` checks this release contract.

## Validation

Run `npm run test:types`, `npm run build` and `npm run test:node` with `CI=1` in PowerShell. CI mode skips the tests that load or download models.

Upstream `main` passes the typecheck and the build. Its Node suite reports 1,584 passed, 122 failed and 138 skipped tests across 79 test files, and two `spawn sleep ENOENT` errors. Most failures are in the CLI, shell script, daemon and cross-process lock suites.

At `8d16d87`, `rune/main` passes the typecheck of the build and of the whole project, the build and `oxlint`. Its Node suite reports 1,635 passed tests, the same 122 failed tests, 138 skipped tests and the same two errors across 90 test files. All 51 added tests pass.

These counts come from PowerShell, in a checkout on another drive than the temp folder. Git Bash has a `sleep` command, which changes the counts. On the test machine, a checkout on the drive of the temp folder changes three results: `getRealPath resolves symlinks` fails, and two failing tests in `embed-lock-domain.test.ts` and `mcp.test.ts` pass.
