/**
 * QMD SDK - Library mode for programmatic access to QMD search and indexing.
 *
 * Usage:
 *   import { createStore } from '@tobilu/qmd'
 *
 *   const store = await createStore({
 *     dbPath: './my-index.sqlite',
 *     config: {
 *       collections: {
 *         docs: { path: '/path/to/docs', pattern: '**\/*.md' }
 *       }
 *     }
 *   })
 *
 *   const results = await store.search({ query: "how does auth work?" })
 *   await store.close()
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { createStore as createStoreInternal, hybridQuery, structuredSearch, extractSnippet, addLineNumbers, DEFAULT_MULTI_GET_MAX_BYTES, reindexCollection, EmbedLockBusyError, generateEmbeddings, listCollections as storeListCollections, syncConfigToDb, invalidateConfigHash, getStoreCollections, getStoreCollection, getStoreGlobalContext, getStoreContexts, upsertStoreCollection, deleteStoreCollection, renameStoreCollection, removeCollection as removeIndexedCollection, renameCollection as renameIndexedCollection, reconcilePublishedRename, assertRenameTargetAvailable, hasCollectionIndexState, updateStoreContext, removeStoreContext, setStoreGlobalContext, vacuumDatabase, cleanupOrphanedContent, cleanupOrphanedVectors, copyVectorsToNewCollections, deleteLLMCache, deleteInactiveDocuments, clearAllEmbeddings, formatQueryForEmbedding, } from "./store.js";
import { LlamaCpp, withLLMSessionForLlm, } from "./llm.js";
export { RemoteEmbedder } from "./remote-embed.js";
export { JevReranker } from "./jev.js";
export { createCommandProcessor } from "./processors.js";
import { snapshotProcessor } from "./processors.js";
import { requireProcessor, hasProcessorMode } from "./processor-store.js";
import { parseMetadataFilter, parseMetadataMatch, MetadataFilterError, } from "./metadata-filter.js";
import { listMetadata as storeListMetadata, MetadataBindingBudgetError, MetadataOptionError, } from "./metadata-store.js";
import { CollectionConfigScope, ConfigScopeClosedError, } from "./collections.js";
export { parseMetadataFilter, parseMetadataMatch, MetadataFilterError };
export { MetadataBindingBudgetError, MetadataOptionError };
// Re-export utility functions and types used by frontends
export { extractSnippet, addLineNumbers, DEFAULT_MULTI_GET_MAX_BYTES };
// Re-export the embed busy error so SDK callers can recognize a run that lost
// the index's embed lock to another process instead of retrying blindly.
export { EmbedLockBusyError };
// Re-export the per-store collection config ownership API. Each store binds one
// scope; consumers can build scopes directly to mirror the CLI's behavior.
export { CollectionConfigScope, ConfigScopeClosedError };
export { PendingRenameError, CorruptPendingRenameError, ConfigLockTimeoutError, NestedConfigMutationError } from "./collections.js";
// Re-export getDefaultDbPath for CLI/MCP that need the default database location
export { getDefaultDbPath } from "./store.js";
// Re-export Maintenance class for CLI housekeeping operations
export { Maintenance } from "./maintenance.js";
// =============================================================================
// Store operation lifecycle
// =============================================================================
//
// A store's SQLite connection and its LlamaCpp instance are shared by every
// method it exposes, while the LLM layer leases resources per model call
// (embed/rerank/expand). An SDK operation such as search() or update() keeps
// using SQLite after its last LLM call returns, so closing must drain whole SDK
// operations — not merely their LLM leases — before it touches either resource:
//
//   open     → operations are admitted immediately.
//   closing  → new operations are rejected; admitted ones run to completion.
//   closed   → terminal: resources released, nothing can be admitted.
//
// close() makes the transition synchronously, waits for the admitted count to
// drop to zero, and only then disposes the LLM and closes SQLite. Every caller
// shares one completion promise, so concurrent closes neither tear the store
// down twice nor return before the drain finished.
//
// The drain is unbounded on purpose. A process-wide shutdown that wants a
// deadline must bound the operations it admits (AbortSignal, processor
// timeouts); closing under a running operation would trade a hang for a
// corrupt read or a native crash.
//
// Admission is tracked through AsyncLocalStorage so close() can tell when it is
// called from inside one of this store's own operations. That call waits for
// the operation it belongs to, which waits for the close: it can never settle,
// so it fails fast instead of deadlocking.
/** Thrown when an operation is attempted on a store that is closing or closed. */
export class StoreClosedError extends Error {
    constructor(message = "QMD store is closed") {
        super(message);
        this.name = "StoreClosedError";
    }
}
/** Thrown when close() is awaited from inside an operation of the same store. */
export class StoreCloseDeadlockError extends Error {
    constructor() {
        super("close() was called from inside an operation of the same store; " +
            "that operation's completion is what close() is waiting for, so awaiting it can only deadlock");
        this.name = "StoreCloseDeadlockError";
    }
}
const operationContext = new AsyncLocalStorage();
class StoreOperationLifecycle {
    _state = "open";
    admitted = 0;
    settleDrain = null;
    completion = null;
    /**
     * Admit one SDK operation and run it inside this store's operation context.
     *
     * The state check and the count happen in one synchronous block: close()
     * flips the state synchronously too, so an operation either takes its slot
     * before close() begins (and is drained) or observes "closing" and is
     * rejected. The count is released in `finally`, so a throwing or aborting
     * operation cannot strand the drain.
     */
    async run(operation, fn) {
        if (this._state !== "open") {
            throw new StoreClosedError(`QMD store is ${this._state}: ${operation}() cannot start`);
        }
        this.admitted += 1;
        const frame = { store: this, active: true, parent: operationContext.getStore() };
        try {
            return await operationContext.run(frame, fn);
        }
        finally {
            frame.active = false;
            this.admitted -= 1;
            if (this.admitted === 0) {
                const settle = this.settleDrain;
                this.settleDrain = null;
                settle?.();
            }
        }
    }
    /**
     * Enter "closing" and return the shared completion of the teardown.
     *
     * `teardown` runs only after every admitted operation finished. It is invoked
     * exactly once, because only the call that observed "open" starts it; later
     * calls share its completion.
     */
    close(teardown) {
        // Checked before the state so a close from inside a callback is reported as
        // the deadlock it is, instead of joining a completion that cannot settle.
        if (this.insideOwnOperation()) {
            return Promise.reject(new StoreCloseDeadlockError());
        }
        if (this.completion)
            return this.completion;
        this._state = "closing";
        // Nothing can be admitted past the synchronous transition above, so the
        // admitted count only decreases from here and this drain settles once.
        const { promise: drained, resolve: settleDrain } = Promise.withResolvers();
        if (this.admitted === 0)
            settleDrain();
        else
            this.settleDrain = settleDrain;
        const completion = (async () => {
            try {
                await drained;
                await teardown();
            }
            finally {
                this._state = "closed";
            }
        })();
        this.completion = completion;
        return completion;
    }
    /** True while an active operation of this store is in the async context. */
    insideOwnOperation() {
        for (let frame = operationContext.getStore(); frame; frame = frame.parent) {
            if (frame.active && frame.store === this)
                return true;
        }
        return false;
    }
}
/**
 * Create a QMD store for programmatic access to search and indexing.
 *
 * @example
 * ```typescript
 * // With a YAML config file
 * const store = await createStore({
 *   dbPath: './index.sqlite',
 *   configPath: './qmd.yml',
 * })
 *
 * // With inline config (no files needed besides the DB)
 * const store = await createStore({
 *   dbPath: './index.sqlite',
 *   config: {
 *     collections: {
 *       docs: { path: '/path/to/docs', pattern: '**\/*.md' }
 *     }
 *   }
 * })
 *
 * const results = await store.search({ query: "authentication flow" })
 * await store.close()
 * ```
 */
export async function createStore(options) {
    if (!options.dbPath) {
        throw new Error("dbPath is required");
    }
    if (options.configPath && options.config) {
        throw new Error("Provide either configPath or config, not both");
    }
    const idleTimeout = options.modelIdleTimeoutMs;
    if (idleTimeout !== undefined && (!Number.isInteger(idleTimeout) || idleTimeout < 0)) {
        throw new Error(`Invalid modelIdleTimeoutMs: ${idleTimeout}. Must be a non-negative integer.`);
    }
    // Each store owns its own configuration scope. A YAML or inline source is
    // bound to this store for its lifetime, so another store created in the same
    // process can neither redirect nor reset this store's write-through target.
    // DB-only mode has no external config and uses existing store_collections.
    const configScope = options.configPath
        ? new CollectionConfigScope({ configPath: options.configPath })
        : options.config
            ? new CollectionConfigScope({ config: options.config })
            : undefined;
    // Resolve model selection from this store's config before opening SQLite, so
    // an invalid selection fails without creating a database.
    const configuredConfig = configScope?.load();
    // Create a per-store LlamaCpp instance — lazy-loads models on first use,
    // auto-unloads after the idle timeout (default 5 min) to free VRAM.
    const llm = new LlamaCpp({
        ...options.llm,
        embedModel: configuredConfig?.models?.embed,
        embedOptions: configuredConfig?.models?.embedOptions,
        generateModel: configuredConfig?.models?.generate,
        rerankModel: configuredConfig?.models?.rerank,
        rerankOptions: configuredConfig?.models?.rerankOptions,
        inactivityTimeoutMs: options.modelIdleTimeoutMs ?? 5 * 60 * 1000,
        disposeModelsOnInactivity: true,
    });
    const internal = createStoreInternal(options.dbPath, { readOnly: options.readOnly, busyTimeoutMs: options.busyTimeoutMs });
    const db = internal.db;
    // Seed SQLite from the configuration that is authoritative now, read under
    // the config lock. A lock-free read and a later sync would delete a
    // collection another process published in between, and stamp the stale
    // document's hash over the result. An inline snapshot is process-local: it
    // has no file to serialize on and is applied as given.
    // A read-only store syncs nothing: its config only gives the models.
    if (!options.readOnly)
        configScope?.withLockedConfig((authoritative) => syncConfigToDb(db, authoritative));
    internal.llm = llm;
    // Every operation this store exposes is admitted here before it touches the
    // database or the LLM, so close() can drain them instead of racing them.
    const lifecycle = new StoreOperationLifecycle();
    const admit = (operation, fn) => lifecycle.run(operation, fn);
    // Mirror half of a configuration mutation. It runs after this store's config
    // scope published the change and while that scope still holds the config
    // lock, so the configuration stays authoritative and no concurrent sync can
    // interleave between the publish and the mirror. A direct row write also
    // invalidates the stored sync hash: the rows and the document the hash
    // certifies must not disagree.
    const mirrorToDb = (apply) => () => {
        const changed = apply() === true;
        invalidateConfigHash(db);
        return changed;
    };
    // Teardown runs only after the drain. It attempts every step so one failure
    // cannot leak the others: native models and contexts first, then the SQLite
    // connection, then this store's config target.
    const teardown = async () => {
        const failures = [];
        try {
            await llm.dispose();
        }
        catch (error) {
            failures.push(error);
        }
        try {
            internal.close();
        }
        catch (error) {
            failures.push(error);
        }
        // Release this store's config target even if resources above could not be
        // released. Later mutations fail with ConfigScopeClosedError instead of
        // writing to another store's config.
        configScope?.close();
        if (failures.length === 1)
            throw failures[0];
        if (failures.length > 1)
            throw new AggregateError(failures, "QMD store teardown failed");
    };
    const store = {
        internal,
        dbPath: internal.dbPath,
        // Search
        search: (opts) => admit("search", async () => {
            opts.signal?.throwIfAborted();
            if (!opts.query && !opts.queries) {
                throw new Error("search() requires either 'query' or 'queries'");
            }
            // Normalize collection/collections
            const collections = [
                ...(opts.collection ? [opts.collection] : []),
                ...(opts.collections ?? []),
            ];
            const skipRerank = opts.rerank === false;
            // The SDK is also a JavaScript boundary: TypeScript declarations do not
            // protect plain-JS callers or deserialized input. Apply the same bounded,
            // strict validation used by CLI, MCP, and HTTP before compiling SQL.
            const filter = opts.filter === undefined ? undefined : parseMetadataFilter(opts.filter);
            if (opts.queries) {
                // Pre-expanded queries — use structuredSearch
                return structuredSearch(internal, opts.queries, {
                    signal: opts.signal,
                    collections: collections.length > 0 ? collections : undefined,
                    filter,
                    limit: opts.limit,
                    minScore: opts.minScore,
                    explain: opts.explain,
                    intent: opts.intent,
                    candidateLimit: opts.candidateLimit,
                    skipRerank,
                    chunkStrategy: opts.chunkStrategy,
                });
            }
            // Simple query string — use hybridQuery (expand + search + rerank)
            return hybridQuery(internal, opts.query, {
                signal: opts.signal,
                collection: collections.length > 0 ? collections : undefined,
                filter,
                limit: opts.limit,
                minScore: opts.minScore,
                explain: opts.explain,
                intent: opts.intent,
                candidateLimit: opts.candidateLimit,
                skipRerank,
                chunkStrategy: opts.chunkStrategy,
            });
        }),
        searchLex: (q, opts) => admit("searchLex", async () => {
            const filter = opts?.filter === undefined ? undefined : parseMetadataFilter(opts.filter);
            return internal.searchFTS(q, opts?.limit, opts?.collection, filter, opts);
        }),
        searchVector: (q, opts) => admit("searchVector", async () => {
            const filter = opts?.filter === undefined ? undefined : parseMetadataFilter(opts.filter);
            return withLLMSessionForLlm(llm, session => internal.searchVec(q, llm.embedModelName, opts?.limit, opts?.collection, session, opts?.embedding, filter, opts), { signal: opts?.signal, name: "searchVector" });
        }),
        embedQuery: (q, opts) => admit("embedQuery", async () => withLLMSessionForLlm(llm, async (session) => {
            const result = await session.embed(formatQueryForEmbedding(q, llm.embedModelName), { model: llm.embedModelName, isQuery: true });
            return result?.embedding ?? null;
        }, { signal: opts?.signal, name: "embedQuery" })),
        expandQuery: (q) => admit("expandQuery", async () => internal.expandQuery(q)),
        get: (pathOrDocid, opts) => admit("get", async () => internal.findDocument(pathOrDocid, opts)),
        getDocumentBody: (pathOrDocid, opts) => admit("getDocumentBody", async () => {
            const result = internal.findDocument(pathOrDocid, { includeBody: false });
            if ("error" in result)
                return null;
            return internal.getDocumentBody(result, opts?.fromLine, opts?.maxLines);
        }),
        multiGet: (pattern, opts) => admit("multiGet", async () => internal.findDocuments(pattern, opts)),
        // Collection Management — the bound configuration is authoritative: each
        // mutation publishes it first and mirrors the result into SQLite under the
        // same config lock. The old order (SQLite first) left a database-only edit
        // behind whenever the config write failed.
        addCollection: (name, opts) => admit("addCollection", async () => {
            const upsert = () => {
                db.transaction(() => {
                    upsertStoreCollection(db, name, { path: opts.path, pattern: opts.pattern, ignore: opts.ignore });
                }).immediate();
            };
            // Write-through goes to this store's config scope only.
            if (configScope)
                configScope.addCollection(name, opts.path, opts.pattern, mirrorToDb(upsert));
            else
                upsert();
        }),
        removeCollection: (name) => admit("removeCollection", async () => {
            const removeFromDb = () => {
                // Full removal whenever the index still holds anything under this name:
                // a config sync may already have dropped the row from an already
                // published file while documents, sync rows, processor state or a
                // vector partition remain from an interrupted removal.
                if (!hasCollectionIndexState(db, name))
                    return deleteStoreCollection(db, name);
                removeIndexedCollection(db, name);
                return true;
            };
            if (!configScope)
                return removeFromDb();
            return configScope.removeCollection(name, mirrorToDb(removeFromDb));
        }),
        renameCollection: (oldName, newName) => admit("renameCollection", async () => {
            if (!configScope) {
                const processed = hasProcessorMode(db, oldName) || !!getStoreCollection(db, oldName)?.processor;
                if (!processed)
                    return renameStoreCollection(db, oldName, newName);
                renameIndexedCollection(db, oldName, newName);
                return true;
            }
            // An ordinary index-side refusal happens before the file is published, so
            // it cannot leave the configuration renamed ahead of the index. A target
            // row a sync wrote from an already published file has no documents and is
            // finished by the mirror instead.
            assertRenameTargetAvailable(db, newName);
            return configScope.renameCollection(oldName, newName, mirrorToDb(() => reconcilePublishedRename(db, oldName, newName)));
        }),
        listCollections: () => admit("listCollections", async () => storeListCollections(db)),
        listMetadata: (opts) => admit("listMetadata", async () => storeListMetadata(db, {
            ...opts,
            match: opts?.match === undefined ? undefined : parseMetadataMatch(opts.match),
            filter: opts?.filter === undefined ? undefined : parseMetadataFilter(opts.filter),
        })),
        getDefaultCollectionNames: () => admit("getDefaultCollectionNames", async () => {
            const collections = storeListCollections(db);
            return collections.filter(c => c.includeByDefault).map(c => c.name);
        }),
        // Context Management — same order as collections: the configuration is
        // authoritative, SQLite mirrors it under the config lock.
        addContext: (collectionName, pathPrefix, contextText) => admit("addContext", async () => {
            if (!configScope)
                return updateStoreContext(db, collectionName, pathPrefix, contextText);
            return configScope.addContext(collectionName, pathPrefix, contextText, mirrorToDb(() => updateStoreContext(db, collectionName, pathPrefix, contextText)));
        }),
        removeContext: (collectionName, pathPrefix) => admit("removeContext", async () => {
            if (!configScope)
                return removeStoreContext(db, collectionName, pathPrefix);
            return configScope.removeContext(collectionName, pathPrefix, mirrorToDb(() => removeStoreContext(db, collectionName, pathPrefix)));
        }),
        setGlobalContext: (context) => admit("setGlobalContext", async () => {
            const apply = () => setStoreGlobalContext(db, context);
            if (configScope)
                configScope.setGlobalContext(context, mirrorToDb(apply));
            else
                apply();
        }),
        getGlobalContext: () => admit("getGlobalContext", async () => getStoreGlobalContext(db)),
        listContexts: () => admit("listContexts", async () => getStoreContexts(db)),
        // Indexing — reads collections from SQLite
        update: (updateOpts) => admit("update", async () => {
            const collections = getStoreCollections(db);
            const filtered = updateOpts?.collections
                ? collections.filter(c => updateOpts.collections.includes(c.name))
                : collections;
            // Resolve every named path before writing, so an invalid one cannot leave a partial update.
            const targeted = updateOpts?.changed !== undefined || updateOpts?.removed !== undefined;
            const targets = new Map(filtered.map(col => [col.name, { changed: [], removed: [] }]));
            for (const kind of ["changed", "removed"]) {
                for (const input of updateOpts?.[kind] ?? []) {
                    const virtual = /^qmd:\/\/([^/]+)\/(.+)$/.exec(input);
                    if (!virtual && !isAbsolute(input) && filtered.length !== 1) {
                        throw new Error("Relative update paths require exactly one selected collection");
                    }
                    let matched = false;
                    for (const col of filtered) {
                        if (virtual && virtual[1] !== col.name)
                            continue;
                        const local = relative(resolvePath(col.path), resolvePath(col.path, virtual ? virtual[2] : input)).replaceAll("\\", "/");
                        if (!local || local === ".." || local.startsWith("../") || isAbsolute(local))
                            continue;
                        targets.get(col.name)[kind].push(local);
                        matched = true;
                    }
                    if (!matched)
                        throw new Error(`Update path is outside selected collections: ${input}`);
                }
            }
            const selected = targeted
                ? filtered.filter(col => targets.get(col.name).changed.length > 0 || targets.get(col.name).removed.length > 0)
                : filtered;
            const prepared = selected.map(col => {
                const registered = updateOpts?.processors?.[col.name];
                const processor = registered ? snapshotProcessor(registered) : undefined;
                requireProcessor(db, col.name, !!col.processor, processor);
                if (targeted && processor)
                    throw new Error(`Collection '${col.name}' has a processor and needs a full update`);
                return { col, processor };
            });
            internal.clearCache();
            let totalIndexed = 0, totalUpdated = 0, totalUnchanged = 0, totalRemoved = 0, totalSkipped = 0;
            for (const { col, processor } of prepared) {
                const result = await reindexCollection(internal, col.path, col.pattern || "**/*.md", col.name, {
                    ignorePatterns: col.ignore,
                    processor,
                    signal: updateOpts?.signal,
                    ...(targeted ? targets.get(col.name) : {}),
                    onProgress: updateOpts?.onProgress
                        ? (info) => updateOpts.onProgress({ collection: col.name, ...info })
                        : undefined,
                });
                totalIndexed += result.indexed;
                totalUpdated += result.updated;
                totalUnchanged += result.unchanged;
                totalRemoved += result.removed;
                totalSkipped += result.skipped;
            }
            // A changed file rewrites its document's hash in place and strands the
            // old hash's partition rows, which take k slots from scoped searches;
            // a hash that joined a collection while embedded elsewhere stays
            // unsearchable there until its rows are copied. The copy runs first:
            // the cleanup deletes the partition rows it copies from, so a document
            // moved between collections would otherwise need a fresh embed.
            const vectorsCopied = copyVectorsToNewCollections(db).copied;
            const staleVectorsRemoved = cleanupOrphanedVectors(db);
            return {
                collections: prepared.length,
                indexed: totalIndexed,
                updated: totalUpdated,
                unchanged: totalUnchanged,
                removed: totalRemoved,
                skipped: totalSkipped,
                staleVectorsRemoved,
                vectorsCopied,
                needsEmbedding: internal.getHashesNeedingEmbedding(),
            };
        }),
        embed: (embedOpts) => admit("embed", async () => generateEmbeddings(internal, {
            signal: embedOpts?.signal,
            force: embedOpts?.force,
            model: embedOpts?.model,
            collection: embedOpts?.collection,
            maxDocsPerBatch: embedOpts?.maxDocsPerBatch,
            maxBatchBytes: embedOpts?.maxBatchBytes,
            chunkStrategy: embedOpts?.chunkStrategy,
            onProgress: embedOpts?.onProgress,
        })),
        countTokens: (text) => admit("countTokens", async () => llm.countTokens(text)),
        // Index Health
        getStatus: () => admit("getStatus", async () => internal.getStatus()),
        getIndexHealth: () => admit("getIndexHealth", async () => internal.getIndexHealth()),
        // Lifecycle
        close: () => lifecycle.close(teardown),
    };
    if (options.readOnly) {
        // Reject every call that writes before it reaches SQLite or the config, with an error that names the call.
        for (const call of [
            "addCollection", "removeCollection", "renameCollection",
            "addContext", "removeContext", "setGlobalContext",
            "update", "embed",
        ]) {
            store[call] = async () => {
                throw new Error(`${call}() needs a writable store. This store was opened with readOnly.`);
            };
        }
    }
    return store;
}
