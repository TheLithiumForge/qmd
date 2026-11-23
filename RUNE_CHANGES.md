# Rune changes
The Rune QMD fork is a QMD 2.8.3 build that gives Rune scoped retrieval, file updates, per-store model settings and read-only stores through the SDK.

Rune searches separate document and section collections. For example, it can embed a query once, search both collections without loading bodies or contexts, then refresh one changed file without scanning either collection.

Status: Nine SDK changes built from `v2.8.3` (`facd35e`).

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
| Store options | `createStore({ llm })` sets the model cache folder, downloads, the device, the embedding parallelism and the embedding context size for one store. Each option wins over its environment variable | `rune/feat-store-runtime-options` | `test/store-runtime-options.test.ts` checks three stores with different options in one process, the variables that still apply and invalid values |
| Store tokenizer | `embed()` counts chunk tokens with the store's model object instead of the global default. `countTokens()` gives a caller the same count | `rune/fix-store-tokenizer` | `test/store-tokenizer.test.ts` checks chunk sizes against a different global default and the counts of two stores |
| Read-only store | `createStore({ readOnly: true })` opens an existing index without write access. It creates no table and syncs no config | `rune/feat-read-only-store` | `test/read-only-store.test.ts` checks two readers beside a writer that holds the write lock, rejected writes and a missing database or table |

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

## Store options

Pass `llm` to `createStore()` to set the model runtime for one store. Without it, QMD reads these settings from environment variables, which every store in the process shares.

Illustrative:

```ts
const store = await createStore({
  dbPath: "./index.sqlite",
  config: { collections: {}, models: { embed: "./models/embed.gguf" } },
  llm: { modelCacheDir: "./models", skipDownload: true, gpu: false, embedParallelism: 2 },
}); // embeds on the CPU with two contexts and never downloads
```

The `llm` group takes five options:

| Option | Variable | Meaning |
| --- | --- | --- |
| `modelCacheDir` | `XDG_CACHE_HOME` | Folder for downloaded model files |
| `skipDownload` | None | `true` fails on a model file that is missing from the cache, and never downloads or builds llama.cpp. Defaults to `false` |
| `gpu` | `QMD_LLAMA_GPU`, `QMD_FORCE_CPU` | `"auto"`, `"metal"`, `"vulkan"`, `"cuda"` or `false` for CPU only |
| `embedParallelism` | `QMD_EMBED_PARALLELISM` | Number of parallel embedding contexts, capped at 8 |
| `embedContextSize` | `QMD_EMBED_CONTEXT_SIZE` | Embedding context size in tokens |

An option wins over its variable. If you omit an option, its variable or the default still applies. `embedParallelism` and `embedContextSize` take positive integers, and `createStore()` rejects any other value.

Three more variables need no option:

- `QMD_EMBED_MODEL` - `config.models.embed` already sets the embedding model for one store.
- `QMD_CONFIG_DIR` - a store reads its collections from `config`, `configPath` or the database, never from the default config folder.
- `NODE_LLAMA_CPP_SKIP_DOWNLOAD` - QMD passes a `skipDownload` value to node-llama-cpp on every load, so the variable doesn't change how a store loads. Set the `skipDownload` option instead.

## Store tokenizer

`embed()` sizes chunks by token count, and it now counts with the store's model object. Before, it counted with the global default model object. A store with a different embedding model then loaded a second model, or sized its chunks with the wrong one.

`countTokens()` returns the token count that the store's embedding model gives. It loads that model on first use.

Illustrative:

```ts
const tokens = await store.countTokens("How does auth work?"); // the count embed() uses to size chunks
```

## Read-only stores

Pass `readOnly: true` to `createStore()` to open an existing index without write access. Several readers can then search one index while a writer updates it.

Illustrative:

```ts
const reader = await createStore({ dbPath: "./index.sqlite", readOnly: true });
const hits = await reader.searchLex("auth"); // returns hits while a writer holds the write lock
await reader.update(); // rejects: update() needs a writable store
```

A read-only store differs from a default store in four ways:

- It creates no table, migrates no schema and syncs no config. Collections come from the database, and `config` or `configPath` only gives the models.
- Search and read calls work as before. `search()` reads cached expansions and rerank scores and adds none.
- `update()`, `embed()` and the collection and context calls that write reject with an error that names the call.
- A missing database or a missing table fails at open.

A default store writes at open when it creates or migrates the schema, or when its config differs from the synced one. It then waits for the write lock.

## Limits

- As in QMD 2.8.3, config write-through uses one config source for the whole process. With two writable stores open, the collection and context calls of both write through to the source of the store that opened last. After one of them closes, they write to the default config file. A read-only store sets no config source.
- A read-only store can't migrate an old schema. Open the index once without `readOnly` first.

## Validation

Run `npm run test:types`, `npm run test:node` with `CI=1`, and `npm run build`. CI mode skips tests that load or download models. Each topic also has a focused test that runs without a model.

The unchanged Windows baseline passes typecheck and build. Its Node suite reports 1,021 passed, 71 failed, 129 skipped and two `spawn sleep ENOENT` errors across 43 test files. Failures include Windows path handling, POSIX commands, symlinks and daemon fixtures. Compare later runs with this baseline before assigning a failure to a fork change.

The fork passes typecheck and build. Its Node suite reports 1,043 passed, the same 71 failed tests, 129 skipped and the same two spawn errors across 52 test files. All 22 added tests pass. The already failing path-fidelity suite also reports an `EBUSY` error while deleting its temporary database during cleanup.

These counts come from PowerShell. Git Bash has a `sleep` command, so three of the 71 tests pass there and the two spawn errors go away.

## Distribution

Rune pins a commit from [TheLithiumForge/qmd](https://github.com/TheLithiumForge/qmd). The dependency keeps the `@tobilu/qmd` package name, so SDK imports stay the same.

`rune/release-v2.8.3-next` adds the JavaScript and declarations built from `rune/v2.8.3-next` at `0873ef6`. It omits `prepare`, so installing the dependency needs neither checkout hooks nor a package-local TypeScript compiler. `test/install-hooks.test.ts` checks this release contract. The source branch keeps QMD's developer setup.

On Windows x64, Bun 1.3.14 installs the source commit without running its untrusted `prepare` script, leaving `dist/` absent. The script also expects a package-local compiler that this install lacks. The release branch gives all six targets the same JavaScript and declarations. Native dependencies still come from each target's existing packages. Installation on the other five targets needs platform CI.

All changes live in QMD source. The MIT `LICENSE` is unchanged. CLI source is unchanged. A store opened without `readOnly` still initializes as QMD 2.8.3 does.
