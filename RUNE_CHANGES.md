# Rune changes
The Rune QMD fork is a QMD 2.8.3 build that gives Rune scoped retrieval and file updates through the SDK.

Rune searches separate document and section collections. For example, it can embed a query once, search both collections without loading bodies or contexts, then refresh one changed file without scanning either collection.

Status: Six SDK changes built from `v2.8.3` (`facd35e`).

## Changes

Each topic branch starts at `v2.8.3` and has one change commit. `rune/v2.8.3` merges the branches:

| Change | Why | Branch | Test |
| --- | --- | --- | --- |
| Scoped KNN | Give sqlite-vec a `hash_seq` allowlist through `json_each(?)`. This avoids grouped cosine scans and collection starvation. The KNN cap stays 4,096 | `rune/fix-scoped-knn` | `test/scoped-knn.test.ts` checks a collection above 20,000 keys with closer unrelated vectors |
| Optional hydration | `searchLex()` and `searchVector()` skip the content join with `includeBody: false` and path context lookup with `includeContext: false`. Both default to true. An omitted body has `bodyLength: 0` | `rune/feat-search-hydration` | `test/search-hydration.test.ts` checks each option, both options and default results across collections |
| Indexed chunks | Join requested `(hash, seq)` pairs to the existing primary key. Order by document ID and sequence to keep hydration order for tied distances | `rune/perf-indexed-chunk-lookup` | `test/indexed-chunk-lookup.test.ts` checks the query plan and tied result order |
| Query embeddings | `embedQuery()` applies the model query instruction once. `searchVector(query, { embedding })` reuses that vector across collections and refills | `rune/feat-query-embedding` | `test/query-embedding.test.ts` checks formatting, reuse and a failed embedding |
| Idle timeout | `createStore({ modelIdleTimeoutMs })` defaults to five minutes. Zero keeps models loaded until the store closes | `rune/feat-model-idle-timeout` | `test/model-idle-timeout.test.ts` checks the default, a custom timeout, zero and disposal on close |
| Targeted updates | `update({ changed, removed })` reads and hashes only named files. It keeps unlisted documents and removes unused chunks for affected hashes | `rune/feat-targeted-update` | `test/targeted-update.test.ts` checks edits, empty targets, rename within and across collections, shared hashes, final-chunk deletion, empty replacements and path rules |

## Targeted updates

Call `update()` without arguments to keep the existing full collection scan. If you pass `changed` or `removed`, QMD processes only those files. Empty arrays do no filesystem scan.

Paths can be absolute or use `qmd://collection/path`. If you pass relative paths, select exactly one collection through `collections`, or configure only one collection. QMD checks every input path before writing. Changed files follow the collection glob, ignore patterns and hidden-file rules.

Illustrative:

```ts
const result = await store.update({
  changed: ["qmd://docs/renamed.md"],
  removed: ["qmd://docs/a.md"],
}); // indexes renamed.md and deactivates a.md
```

An unchanged content hash keeps its embeddings during a rename. Cleanup runs after all selected collections finish, so a move between collections can reuse the same chunks. Removing the final active reference deletes that hash's chunks from both vector tables. Content referenced by inactive document rows stays until maintenance deletes those rows.

`update()` updates document storage and the keyword index. Call `embed()` afterward to generate missing vectors. A changed file with an empty body deactivates its previous document. If a file appears in both arrays, a readable changed file takes precedence.

## Validation

Run `npm run test:types`, `npm run test:node` with `CI=1`, and `npm run build`. CI mode skips tests that load or download models. Each topic also has a focused test that runs without a model.

The unchanged Windows baseline passes typecheck and build. Its Node suite reports 1,021 passed, 71 failed, 129 skipped and two `spawn sleep ENOENT` errors across 43 test files. Failures include Windows path handling, POSIX commands, symlinks and daemon fixtures. Compare later runs with this baseline before assigning a failure to a fork change.

The fork passes typecheck and build. Its Node suite reports 1,037 passed, the same 71 failed tests, 129 skipped and the same two spawn errors across 49 test files. All 16 added tests pass. The already failing path-fidelity suite also reports an `EBUSY` error while deleting its temporary database during cleanup.

## Distribution

Rune pins a commit from [TheLithiumForge/qmd](https://github.com/TheLithiumForge/qmd). The dependency keeps the `@tobilu/qmd` package name, so SDK imports stay the same.

`rune/release-v2.8.3` adds the JavaScript and declarations built from `rune/v2.8.3` at `0d975e6`. It omits `prepare`, so installing the dependency needs neither checkout hooks nor a package-local TypeScript compiler. `test/install-hooks.test.ts` checks this release contract. The source branch keeps QMD's developer setup.

On Windows x64, Bun 1.3.14 installs the source commit without running its untrusted `prepare` script, leaving `dist/` absent. The script also expects a package-local compiler that this install lacks. The release branch gives all six targets the same JavaScript and declarations. Native dependencies still come from each target's existing packages. Installation on the other five targets needs platform CI.

All changes live in QMD source. The MIT `LICENSE` is unchanged. CLI source is unchanged. Reader initialization still follows QMD 2.8.3 behavior.
