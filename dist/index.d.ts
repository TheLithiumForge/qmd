import { extractSnippet, addLineNumbers, DEFAULT_MULTI_GET_MAX_BYTES, EmbedLockBusyError, type Store as InternalStore, type DocumentResult, type DocumentNotFound, type DocumentExcludedByIgnore, type DocumentLookupError, type SearchResult, type HybridQueryResult, type HybridQueryOptions, type HybridQueryExplain, type ExpandedQuery, type StructuredSearchOptions, type MultiGetResult, type IndexStatus, type IndexHealthInfo, type SearchHooks, type ReindexProgress, type ReindexResult, type EmbedProgress, type EmbedResult, type ChunkStrategy } from "./store.js";
import { type LlamaCppConfig } from "./llm.js";
export { RemoteEmbedder } from "./remote-embed.js";
export type { RemoteEmbedOptions } from "./remote-embed.js";
export { JevReranker } from "./jev.js";
export type { JevRerankOptions } from "./jev.js";
export { createCommandProcessor } from "./processors.js";
export type { DocumentProcessor, ProcessorInput, ProcessorDocument, CommandProcessorSpec } from "./processors.js";
import { type DocumentProcessor } from "./processors.js";
import type { DocumentMetadata, MetadataScalar, MetadataScalarArray, MetadataValue, MetadataValueType } from "./metadata.js";
import { parseMetadataFilter, parseMetadataMatch, MetadataFilterError, type MetadataFilter, type MetadataFilterGroup, type MetadataFilterNegation, type MetadataCondition, type MetadataPredicate, type MetadataPredicateGroup, type MetadataPredicateNegation, type MetadataMatch, type MetadataEntryCondition, type MetadataEntryField } from "./metadata-filter.js";
import { MetadataBindingBudgetError, MetadataOptionError, type ListMetadataOptions, type ListMetadataResult, type MetadataKeySummary, type MetadataKeyTypeSummary, type MetadataValueCount, type MetadataKeyOverview } from "./metadata-store.js";
import { CollectionConfigScope, ConfigScopeClosedError, type ConfigMirror, type ConfigSourceOptions, type Collection, type CollectionConfig, type NamedCollection, type ContextMap } from "./collections.js";
export type { DocumentResult, DocumentNotFound, DocumentExcludedByIgnore, DocumentLookupError, SearchResult, HybridQueryResult, HybridQueryOptions, HybridQueryExplain, ExpandedQuery, StructuredSearchOptions, MultiGetResult, IndexStatus, IndexHealthInfo, SearchHooks, ReindexProgress, ReindexResult, EmbedProgress, EmbedResult, Collection, CollectionConfig, NamedCollection, ContextMap, };
export type { DocumentMetadata, MetadataScalar, MetadataScalarArray, MetadataValue, MetadataValueType, MetadataFilter, MetadataFilterGroup, MetadataFilterNegation, MetadataCondition, MetadataPredicate, MetadataPredicateGroup, MetadataPredicateNegation, MetadataMatch, MetadataEntryCondition, MetadataEntryField, };
export { parseMetadataFilter, parseMetadataMatch, MetadataFilterError };
export type { ListMetadataOptions, ListMetadataResult, MetadataKeySummary, MetadataKeyTypeSummary, MetadataValueCount, MetadataKeyOverview, };
export { MetadataBindingBudgetError, MetadataOptionError };
export type { InternalStore };
export { extractSnippet, addLineNumbers, DEFAULT_MULTI_GET_MAX_BYTES };
export { EmbedLockBusyError };
export type { ChunkStrategy } from "./store.js";
export { CollectionConfigScope, ConfigScopeClosedError };
export { PendingRenameError, CorruptPendingRenameError, ConfigLockTimeoutError, NestedConfigMutationError } from "./collections.js";
export type { ConfigSourceOptions, ConfigMirror };
export { getDefaultDbPath } from "./store.js";
export { Maintenance } from "./maintenance.js";
/**
 * Progress info emitted during update() for each file processed.
 */
export type UpdateProgress = {
    collection: string;
    file: string;
    current: number;
    total: number;
};
/**
 * Aggregated result from update() across all collections.
 */
export type UpdateResult = {
    collections: number;
    indexed: number;
    updated: number;
    unchanged: number;
    removed: number;
    skipped: number;
    /** Vector rows removed because their (hash, collection) no longer has an active document. */
    staleVectorsRemoved: number;
    /** Vector rows copied into the partition of a collection that gained an already-embedded hash. */
    vectorsCopied: number;
    needsEmbedding: number;
};
/**
 * Options for the unified search() method.
 */
export interface SearchOptions {
    /** Cancels remote embedding/rerank stages; local generation may finish before cancellation is observed. */
    signal?: AbortSignal;
    /** Simple query string — will be auto-expanded via LLM */
    query?: string;
    /** Pre-expanded queries (from expandQuery) — skips auto-expansion */
    queries?: ExpandedQuery[];
    /** Domain intent hint — steers reranking and snippet/chunk selection */
    intent?: string;
    /** Rerank results using LLM (default: true) */
    rerank?: boolean;
    /** Filter to a specific collection */
    collection?: string;
    /** Filter to specific collections */
    collections?: string[];
    /** Metadata filter — every returned result satisfies it */
    filter?: MetadataFilter;
    /** Max results (default: 10) */
    limit?: number;
    /** Max candidates to rerank (default: 40) */
    candidateLimit?: number;
    /** Minimum score threshold */
    minScore?: number;
    /** Include explain traces */
    explain?: boolean;
    /** Chunk strategy: "auto" (default, uses AST for code files) or "regex" (legacy) */
    chunkStrategy?: ChunkStrategy;
}
/**
 * Options for searchLex() — BM25 keyword search.
 */
export interface LexSearchOptions {
    /** Defaults to true. False skips content hydration and reports bodyLength 0. */
    includeBody?: boolean;
    /** Defaults to true. False skips path context lookup. */
    includeContext?: boolean;
    limit?: number;
    collection?: string | string[];
    /** Metadata filter — every returned result satisfies it */
    filter?: MetadataFilter;
}
/**
 * Options for searchVector() — vector similarity search.
 */
export interface VectorSearchOptions {
    signal?: AbortSignal;
    /** Defaults to true. False skips content hydration and reports bodyLength 0. */
    includeBody?: boolean;
    /** Defaults to true. False skips path context lookup. */
    includeContext?: boolean;
    /** Query embedding from embedQuery(), using this store's embedding model. Skips embedding the query again. */
    embedding?: number[];
    limit?: number;
    collection?: string | string[];
    /** Metadata filter — every returned result satisfies it */
    filter?: MetadataFilter;
}
/**
 * Options for expandQuery() — manual query expansion.
 */
export interface ExpandQueryOptions {
    /**
     * @deprecated Ignored. Intent no longer feeds the expansion model — caller
     * intent is meta-language the model reproduced verbatim as sub-queries.
     * Pass intent via SearchOptions instead, where it shapes reranking and
     * snippet selection.
     */
    intent?: string;
}
/**
 * Model runtime settings for one store. An option takes precedence over its
 * environment variable. An omitted option keeps the variable or the default.
 */
export type StoreLlmOptions = Pick<LlamaCppConfig, "modelCacheDir" | "skipDownload" | "gpu" | "embedParallelism" | "embedContextSize" | "allowInCI">;
/**
 * Options for creating a QMD store.
 *
 * Provide `dbPath` and optionally `configPath` (YAML file) or `config` (inline).
 * If neither configPath nor config is provided, the store reads from existing
 * DB state (useful for reopening a previously-configured store).
 *
 * A given `configPath` or `config` is owned by the store that was created with
 * it: collection and context mutations write through to it, and to nothing
 * else, for as long as that store is open. Multiple stores may be open at once;
 * closing one never rebinds another.
 */
export interface StoreOptions {
    /** Path to the SQLite database file */
    dbPath: string;
    /** Path to a YAML config file owned by this store (mutually exclusive with `config`) */
    configPath?: string;
    /** Inline collection config owned by this store (mutually exclusive with `configPath`) */
    config?: CollectionConfig;
    /** Model idle timeout in milliseconds. Defaults to five minutes. Zero keeps models loaded until close(). */
    modelIdleTimeoutMs?: number;
    /** Model runtime settings for this store: cache folder, downloads, device, embedding contexts and model operations while CI is set */
    llm?: StoreLlmOptions;
    /**
     * Open an existing index without write access. Nothing is created, migrated
     * or synced: collections come from the database, and `config` or `configPath`
     * only gives the models. Calls that write reject. A missing database, a
     * missing table or an older schema fails at open.
     */
    readOnly?: boolean;
    /**
     * SQLite busy timeout in milliseconds: how long a statement waits for a lock
     * that another connection holds. Takes precedence over QMD_SQLITE_BUSY_TIMEOUT.
     * Defaults to 120000. Zero fails at once.
     */
    busyTimeoutMs?: number;
}
/**
 * The QMD SDK store — provides search, retrieval, collection management,
 * context management, and indexing operations.
 *
 * All methods are async. The store manages its own LlamaCpp instance
 * (lazy-loaded, auto-unloaded after inactivity) — no global singletons.
 */
export interface QMDStore {
    /**
     * The underlying internal store (for advanced use).
     *
     * It bypasses the SDK operation lifecycle: calls made through it, or closing
     * it directly, are neither tracked nor drained by close(), so they can race
     * an in-flight operation of this store.
     */
    readonly internal: InternalStore;
    /** Path to the SQLite database */
    readonly dbPath: string;
    /** Full search: query expansion + multi-signal retrieval + LLM reranking */
    search(options: SearchOptions): Promise<HybridQueryResult[]>;
    /** BM25 keyword search (fast, no LLM) */
    searchLex(query: string, options?: LexSearchOptions): Promise<SearchResult[]>;
    /** Vector similarity search (embedding model, no reranking) */
    searchVector(query: string, options?: VectorSearchOptions): Promise<SearchResult[]>;
    /** Embed a query once, with the model's query instruction, for reuse across searchVector() calls */
    embedQuery(query: string, options?: {
        signal?: AbortSignal;
    }): Promise<number[] | null>;
    /** Expand a query into typed sub-searches (lex/vec/hyde) for manual control */
    expandQuery(query: string, options?: ExpandQueryOptions): Promise<ExpandedQuery[]>;
    /** Get a single document by path or docid */
    get(pathOrDocid: string, options?: {
        includeBody?: boolean;
    }): Promise<DocumentResult | DocumentLookupError>;
    /** Get the body content of a document, optionally sliced by line range */
    getDocumentBody(pathOrDocid: string, opts?: {
        fromLine?: number;
        maxLines?: number;
    }): Promise<string | null>;
    /** Get multiple documents by glob pattern or comma-separated list */
    multiGet(pattern: string, options?: {
        includeBody?: boolean;
        maxBytes?: number;
    }): Promise<{
        docs: MultiGetResult[];
        errors: string[];
    }>;
    /**
     * Add or update a collection.
     *
     * For a store bound to a configuration, the change is published there first
     * and mirrored into SQLite under the same config lock, so a refused config
     * write leaves no database-only edit behind.
     */
    addCollection(name: string, opts: {
        path: string;
        pattern?: string;
        ignore?: string[];
    }): Promise<void>;
    /**
     * Remove a collection. Returns whether anything was removed.
     *
     * Repeating it finishes a removal whose index half failed or was interrupted:
     * documents, vectors and processor state still under the name are removed even
     * if a later config sync already dropped its `store_collections` row.
     */
    removeCollection(name: string): Promise<boolean>;
    /**
     * Rename a collection. Returns whether anything was renamed.
     *
     * The configuration is published first, preceded by a marker for this
     * old→new pair, and the index half runs against that evidence. A retry after
     * a failed or interrupted index move finishes it, including when a config
     * sync has already written the target row. Without such evidence the call
     * changes nothing and returns false: a name the configuration no longer lists
     * is not moved into a collection that merely happens to exist there.
     */
    renameCollection(oldName: string, newName: string): Promise<boolean>;
    /** List all collections with document stats */
    listCollections(): Promise<{
        name: string;
        pwd: string;
        glob_pattern: string;
        doc_count: number;
        active_count: number;
        last_modified: string | null;
        includeByDefault: boolean;
    }[]>;
    /**
     * Discover metadata keys, types, and value counts across the documents in
     * scope. `filter` selects which documents are counted. `match` selects
     * which of their metadata entries are reported, with the filter grammar
     * evaluated against each entry (a condition's `field` is the entry's `key` or
     * `value`). Keys and values are windowed by `keyLimit`/`keyOffset` and
     * `valueLimit`/`valueOffset`, and the result carries the totals and
     * remainders needed to page. Every value reported is one an `eq` filter can
     * match under the same scope, and the whole result comes from one database
     * snapshot. Throws MetadataFilterError for an invalid predicate,
     * MetadataOptionError for an option outside its domain, and
     * MetadataBindingBudgetError when `filter` and `match` together bind more
     * SQL parameters than one statement allows.
     */
    listMetadata(options?: ListMetadataOptions): Promise<ListMetadataResult>;
    /** Get names of collections included by default in queries */
    getDefaultCollectionNames(): Promise<string[]>;
    /** Add context for a path within a collection */
    addContext(collectionName: string, pathPrefix: string, contextText: string): Promise<boolean>;
    /** Remove context from a collection path */
    removeContext(collectionName: string, pathPrefix: string): Promise<boolean>;
    /** Set global context (applies to all collections) */
    setGlobalContext(context: string | undefined): Promise<void>;
    /** Get global context */
    getGlobalContext(): Promise<string | undefined>;
    /** List all contexts across all collections */
    listContexts(): Promise<Array<{
        collection: string;
        path: string;
        context: string;
    }>>;
    /**
     * Re-index collections by scanning the filesystem.
     *
     * With `changed` or `removed`, only the named files are read or deactivated,
     * and no collection folder is scanned. A path is absolute, `qmd://collection/path`,
     * or relative to the one selected collection. Collections with a processor
     * need a full update.
     */
    update(options?: {
        processors?: Record<string, DocumentProcessor>;
        signal?: AbortSignal;
        collections?: string[];
        /** Files to index. A file missing from disk is skipped, so list it in `removed`. */
        changed?: string[];
        /** Files to deactivate. A file also listed in `changed` is indexed if it can be read. */
        removed?: string[];
        onProgress?: (info: UpdateProgress) => void;
    }): Promise<UpdateResult>;
    /**
     * Generate vector embeddings for documents that need them.
     *
     * Embedding is exclusive per index: this rejects with EmbedLockBusyError
     * while another CLI/SDK/direct run holds this index's embed lock, rather than
     * interleaving partial-chunk cleanup and vector writes with it. The lock is
     * released on success, error and cancellation.
     */
    embed(options?: {
        signal?: AbortSignal;
        force?: boolean;
        model?: string;
        /** Restrict embedding to documents in one collection. */
        collection?: string;
        maxDocsPerBatch?: number;
        maxBatchBytes?: number;
        chunkStrategy?: ChunkStrategy;
        onProgress?: (info: EmbedProgress) => void;
    }): Promise<EmbedResult>;
    /** Count tokens with this store's embedding model, the way embed() sizes chunks. Loads the model on first use. */
    countTokens(text: string): Promise<number>;
    /** Get index status (document counts, collections, embedding state) */
    getStatus(): Promise<IndexStatus>;
    /** Get index health info (stale embeddings, etc.) */
    getIndexHealth(): Promise<IndexHealthInfo>;
    /**
     * Close the store and release all resources (LLM models, DB connection).
     *
     * The transition is synchronous: operations started after this call reject
     * with StoreClosedError. Operations already admitted run to completion before
     * the LLM instance is disposed and SQLite is closed, so none of them observes
     * a torn-down model or a closed connection mid-flight. Concurrent and
     * repeated calls share one completion: they all resolve once that teardown
     * finished.
     *
     * Do not await close() from inside an operation of this store — a processor,
     * a progress callback, or anything they await. Such a call waits for the very
     * operation it runs in and can only deadlock, so it rejects with
     * StoreCloseDeadlockError instead.
     *
     * The drain is deliberately unbounded: an operation that never settles keeps
     * close() — and any shutdown awaiting it — pending, because closing SQLite or
     * disposing models underneath it is the race this lifecycle exists to remove.
     * Bound the operation itself (AbortSignal, processor timeout), not the close.
     */
    close(): Promise<void>;
}
/** Thrown when an operation is attempted on a store that is closing or closed. */
export declare class StoreClosedError extends Error {
    constructor(message?: string);
}
/** Thrown when close() is awaited from inside an operation of the same store. */
export declare class StoreCloseDeadlockError extends Error {
    constructor();
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
export declare function createStore(options: StoreOptions): Promise<QMDStore>;
