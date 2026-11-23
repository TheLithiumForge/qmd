/**
 * Collections configuration management
 *
 * This module manages the YAML-based collection configuration at ~/.config/qmd/index.yml.
 * Collections define which directories to index and their associated contexts.
 *
 * Several processes share that file (CLI commands, the MCP daemon, SDK stores),
 * so every mutation is a read-modify-write under an exclusive per-config lock
 * and every publish is an atomic rename: no update is lost to a concurrent
 * writer and no reader ever observes a partially written YAML document.
 */
import type { RemoteEmbedOptions } from "./remote-embed.js";
import type { JevRerankOptions } from "./jev.js";
import type { CommandProcessorSpec } from "./processors.js";
/**
 * Context definitions for a collection
 * Key is path prefix (e.g., "/", "/2024", "/Board of Directors")
 * Value is the context description
 */
export type ContextMap = Record<string, string>;
/**
 * A single collection configuration
 */
export interface Collection {
    path: string;
    pattern: string;
    ignore?: string[];
    context?: ContextMap;
    processor?: CommandProcessorSpec;
    update?: string;
    includeByDefault?: boolean;
}
/**
 * Model configuration for embedding, reranking, and generation
 */
export interface ModelsConfig {
    embed?: string;
    embedOptions?: RemoteEmbedOptions;
    rerank?: string;
    rerankOptions?: JevRerankOptions;
    generate?: string;
}
/**
 * The complete configuration file structure
 */
export interface CollectionConfig {
    global_context?: string;
    editor_uri?: string;
    editor_uri_template?: string;
    editorUri?: string;
    "editor-uri"?: string;
    collections: Record<string, Collection>;
    models?: ModelsConfig;
}
/**
 * Collection with its name (for return values)
 */
export interface NamedCollection extends Collection {
    name: string;
}
/**
 * Set the current index name for config file lookup
 * Config file will be ~/.config/qmd/{indexName}.yml
 */
export declare function setConfigIndexName(name: string): void;
export declare function getConfigDir(): string;
/**
 * Find a project-local QMD config by walking upward from startDir.
 * The local config lives at .qmd/index.yaml or .qmd/index.yml and,
 * when used by the CLI, keeps both config and index DB writes inside
 * the project instead of the global ~/.config / ~/.cache locations.
 */
export declare function findLocalConfigPath(startDir?: string): string | undefined;
/** Return the local SQLite index path paired with a local .qmd/index.yaml file. */
export declare function getLocalDbPath(configPath: string): string;
/** How a scope should be bound to a configuration target. */
export interface ConfigSourceOptions {
    /** Path to a YAML config file (takes effect when `config` is absent) */
    configPath?: string;
    /** Inline config to own; wins over `configPath` when both are given */
    config?: CollectionConfig;
}
/** Thrown when a closed configuration scope is read or written. */
export declare class ConfigScopeClosedError extends Error {
    constructor();
}
/** The old→new mapping a published rename still owes its index half. */
export type PendingRename = {
    readonly from: string;
    readonly to: string;
};
/**
 * Thrown when a configuration mutation would destroy the only evidence of an
 * unfinished rename. Nothing is written: finish the rename first by repeating
 * it, which moves the old name's index state to the new name.
 */
export declare class PendingRenameError extends Error {
    readonly pending: PendingRename;
    constructor(pending: PendingRename);
}
/**
 * Thrown when an existing pending-rename journal cannot be read or trusted.
 *
 * The journal is the only record of a rename whose index move may not have
 * finished, so it is never read as "no journal": a mutation fails closed
 * instead of clobbering the evidence or moving unrelated state. Nothing is
 * written; the file is left for a deliberate repair or removal.
 */
export declare class CorruptPendingRenameError extends Error {
    readonly markerPath: string;
    readonly reason: string;
    constructor(markerPath: string, reason: string);
}
/** Thrown when another process keeps a config lock past the acquisition budget. */
export declare class ConfigLockTimeoutError extends Error {
    readonly lockPath: string;
    readonly timeoutMs: number;
    constructor(lockPath: string, timeoutMs: number);
}
/** Thrown when one config mutation starts from inside another on the same file. */
export declare class NestedConfigMutationError extends Error {
    readonly configPath: string;
    readonly lockPath: string;
    constructor(configPath: string, lockPath: string);
}
/**
 * Path of the sidecar database that serialises writers for a config target.
 * The file is created on demand and deliberately never unlinked.
 */
export declare function getConfigLockPath(configPath: string): string;
/**
 * Effect that mirrors a published configuration change into derived state
 * (SQLite's `store_collections`) while the config lock is still held.
 *
 * A mutation publishes the configuration first and then runs the mirror, so:
 *   - a failing publish leaves the derived state untouched (no database-only
 *     edit survives an error);
 *   - the file (or inline object) stays authoritative, and every mirror is
 *     ordered by the same lock as the publishes, so a slower mirror can never
 *     overwrite derived state that a newer publish produced;
 *   - a throwing mirror leaves the published configuration in place: the error
 *     reaches the caller and the next sync repairs the derived state from the
 *     file. Cross-resource atomicity (one commit covering both the file and
 *     SQLite) is not claimed.
 *
 * The return value reports whether the derived state changed, so a mutation can
 * report the outcome of either half.
 */
export type ConfigMirror = (published: CollectionConfig) => boolean | void;
/**
 * One owner of a collection configuration.
 *
 * Every read and write in this module goes through a scope, so the target of
 * a mutation is always the scope that owns it. The CLI uses the single
 * module-level `defaultScope`; each SDK store creates its own scope and never
 * touches another store's target, even while both stores are open, and
 * closing a store only closes its own scope.
 */
export declare class CollectionConfigScope {
    private state;
    private readonly resolveDefaultPath;
    /**
     * The index half of a rename this scope still owes for an inline config. An
     * inline config has no file to carry a marker, and the in-memory config lasts
     * exactly as long as this scope, so the scope itself is the durable record.
     */
    private pendingInlineRename?;
    constructor(options?: ConfigSourceOptions, resolveDefaultPath?: () => string);
    /**
     * Bind the scope to a different target. Allowed from any state, including
     * closed, because the CLI reuses one default scope across invocations.
     */
    setSource(options?: ConfigSourceOptions): void;
    /** Release the scope. Idempotent; later reads and writes throw. */
    close(): void;
    get isClosed(): boolean;
    /**
     * Load configuration from this scope's target.
     * Inline targets are returned as-is; missing files yield an empty config.
     *
     * Reads are lock-free: every publish is an atomic rename, so a reader always
     * gets one complete YAML document even while another process mutates.
     */
    load(): CollectionConfig;
    /**
     * Save configuration to this scope's target.
     * Inline targets are replaced in memory; file targets are published as YAML
     * under the config lock, atomically.
     *
     * This replaces the whole file: a caller that loaded it earlier and then
     * saves can drop a concurrent process's change. Prefer {@link update} for
     * read-modify-write, which is what every in-tree mutation uses. Calling
     * `save` from inside `update` (or any mutation) on the same config is
     * rejected: the enclosing mutation is the transaction's only writer, and a
     * replacement there would silently discard the edits after it.
     */
    save(config: CollectionConfig): void;
    /**
     * Read, modify and publish this scope's config while holding its exclusive
     * lock. `mutator` sees the current on-disk version and its changes are
     * written even if another process mutated the same file after this scope's
     * caller last loaded it.
     *
     * A mutation started from inside `mutator` — an `update` or any collection or
     * context helper, through this scope or any other scope bound to the same
     * file — is rejected with {@link NestedConfigMutationError} before it reads
     * or writes. Reusing the lock alone would let the nested call publish its own
     * snapshot and the enclosing update overwrite it with its older one.
     *
     * A throwing `mutator` publishes nothing. Returns the configuration that was
     * published (for inline targets, the caller's live object, which is mutated
     * directly: no publish step exists, so nested inline mutations are allowed).
     */
    update(mutator: (config: CollectionConfig) => void): CollectionConfig;
    /**
     * Read this scope's authoritative configuration and run `fn` while the
     * config lock is held. Use this to keep a derived store (SQLite's
     * `store_collections`) in step with the file: a lock-free read followed by a
     * later sync would let a mutation another process publishes in between be
     * deleted from the derived store, and would stamp a hash for the stale
     * document.
     *
     * `fn` must not start a mutation of this config (that is rejected with
     * {@link NestedConfigMutationError}); it is for the mirror half of a sync.
     * Inline targets have no file to serialize on and pass their live object.
     */
    withLockedConfig<T>(fn: (config: CollectionConfig) => T): T;
    /**
     * The rename this scope still owes its index half, read without mutating
     * anything: the exact old→new pair, or undefined when there is none.
     *
     * This is how a caller decides whether an operation has something to finish
     * *before* opening the index (or writing anything). Only a missing journal
     * means "none"; an unreadable or malformed one throws
     * {@link CorruptPendingRenameError} instead of being read as absence.
     */
    pendingRename(): PendingRename | undefined;
    /** Get this scope's config path, or `<inline>` for in-memory configs. */
    getConfigPath(): string;
    /** Check whether this scope's target exists. Inline configs always do. */
    configExists(): boolean;
    /** Get a specific collection by name, or null if not found. */
    getCollection(name: string): NamedCollection | null;
    /** List all collections in this scope. */
    listCollections(): NamedCollection[];
    /** List collections included by default in queries. */
    getDefaultCollections(): NamedCollection[];
    /** List names of collections included by default in queries. */
    getDefaultCollectionNames(): string[];
    /** Update a collection's settings. Returns false when it does not exist. */
    updateCollectionSettings(name: string, settings: {
        update?: string | null;
        includeByDefault?: boolean;
    }): boolean;
    /**
     * Add or update a collection, preserving its existing context.
     *
     * `mirror` (see {@link ConfigMirror}) runs after the publish, under the same
     * lock, so a caller that keeps its own copy of the configuration in SQLite
     * steps in with the file rather than after an unlocked window.
     */
    addCollection(name: string, path: string, pattern?: string, mirror?: ConfigMirror): void;
    /**
     * Remove a collection. Returns whether anything changed — in the
     * configuration or, through `mirror`, in the derived state — so a row that
     * only the derived store still held is still reported (and removed).
     */
    removeCollection(name: string, mirror?: ConfigMirror): boolean;
    /**
     * Rename a collection. Throws when the new name is already taken, before
     * anything is published.
     *
     * A rename has an index half as well as a file half, so its `mirror` runs
     * only against durable evidence of that rename: the marker written before
     * this publication, or the publication itself. Without it, "the file no
     * longer lists the old name and lists another one" is not evidence — that
     * other name may be an unrelated collection, and moving the old name's
     * documents into it would corrupt its ownership — so `mirrored` is false and
     * the caller reports that nothing was renamed.
     */
    renameCollection(oldName: string, newName: string, mirror?: ConfigMirror): boolean;
    /** Get the global context. */
    getGlobalContext(): string | undefined;
    /** Set the global context. `mirror` behaves as in {@link addCollection}. */
    setGlobalContext(context: string | undefined, mirror?: ConfigMirror): void;
    /** Get all contexts for a collection. */
    getContexts(collectionName: string): ContextMap | undefined;
    /**
     * Add or update a context for a path in a collection. `mirror` behaves as in
     * {@link addCollection}.
     */
    addContext(collectionName: string, pathPrefix: string, contextText: string, mirror?: ConfigMirror): boolean;
    /**
     * Remove a context from a collection path. `mirror` behaves as in
     * {@link addCollection}.
     */
    removeContext(collectionName: string, pathPrefix: string, mirror?: ConfigMirror): boolean;
    /** List all contexts across all collections in this scope. */
    listAllContexts(): Array<{
        collection: string;
        path: string;
        context: string;
    }>;
    /**
     * Find best matching context for a given collection and path.
     * Returns the most specific matching context (longest path prefix match).
     */
    findContextForPath(collectionName: string, filePath: string): string | undefined;
    /** Read and parse the YAML file, treating a missing file as empty. */
    private readConfigFile;
    /**
     * Publish a whole configuration: serialise first, then replace the file under
     * the lock with an atomic rename. Reentrant with the mutation lock.
     */
    private publish;
    /**
     * Shared read-modify-write path for file targets: the config is re-read from
     * disk under the exclusive lock, so a change another process published since
     * the caller last looked is preserved instead of being overwritten with a
     * stale copy. Inline targets are mutated in place, as before.
     *
     * A mutation started from inside another mutation on the same file is
     * rejected before it reads or writes: reusing the lock would let the nested
     * call publish its own snapshot, which the enclosing mutation would then
     * overwrite with the stale snapshot it has been mutating. The check runs
     * under the (reentrantly held) lock, so it cannot interleave with another
     * acquisition in this process.
     *
     * `mutator` returns the value to hand back and whether anything changed; an
     * unchanged result neither publishes nor touches the file. `mirror` runs
     * after the publish (after the in-place edit for inline targets) and still
     * under the same lock, whether or not the configuration changed: the derived
     * store must be able to catch up to a file that already holds the change. Its
     * throw propagates with the configuration already published; the next sync
     * repairs the derived store from it. A `rename` is the exception: see below.
     *
     * `rename` marks the mutation as one whose derived half is keyed by a name
     * pair. Its marker is written before the publication (so a crash between the
     * two leaves evidence) and removed only after the mirror succeeds; the mirror
     * runs when the mutation published, or when that marker proves the earlier
     * publication. See {@link CollectionConfigScope.renameCollection}.
     */
    private mutateConfig;
    private openState;
}
/**
 * Set the config source for the default scope.
 * - File path: load/save from a specific YAML file
 * - Inline config: use an in-memory CollectionConfig (saveConfig updates in place, no file I/O)
 * - undefined: reset to default file-based config
 */
export declare function setConfigSource(source?: ConfigSourceOptions): void;
/** Load configuration from the default scope. */
export declare function loadConfig(): CollectionConfig;
/**
 * Save configuration to the default scope.
 *
 * Replaces the whole file atomically under the config lock. A caller that
 * loaded the config earlier can drop another process's change; use
 * {@link updateConfig} for read-modify-write.
 */
export declare function saveConfig(config: CollectionConfig): void;
/**
 * Read, modify and publish the default scope's config under its exclusive
 * lock, so concurrent qmd processes cannot lose each other's changes.
 * `mutator` receives the version currently on disk. Starting another mutation
 * of the same file from inside `mutator` throws {@link NestedConfigMutationError}
 * before anything is written.
 */
export declare function updateConfig(mutator: (config: CollectionConfig) => void): CollectionConfig;
/**
 * Read the default scope's authoritative configuration and run `fn` while its
 * lock is held. This is how the CLI keeps SQLite in step with the file: a
 * lock-free {@link loadConfig} followed by a later sync can delete a
 * collection another qmd process published in between.
 *
 * `fn` must not start a mutation of the same file (rejected with
 * {@link NestedConfigMutationError}); it is for the mirror half of a sync.
 */
export declare function withConfigLocked<T>(fn: (config: CollectionConfig) => T): T;
/**
 * The default scope's unfinished rename, read without mutating anything
 * (see {@link CollectionConfigScope.pendingRename}).
 */
export declare function getPendingRename(): PendingRename | undefined;
/**
 * Whether this exact rename still owes its index half. A caller that would
 * otherwise open the index (writing nothing yet) uses this to decide whether
 * the operation has anything to finish first — a name the config no longer
 * lists is only a rename worth acting on when this pair is recorded.
 */
export declare function hasPendingRename(from: string, to: string): boolean;
/** Get a specific collection by name from the default scope. */
export declare function getCollection(name: string): NamedCollection | null;
/** List all collections in the default scope. */
export declare function listCollections(): NamedCollection[];
/** Get collections that are included by default in queries. */
export declare function getDefaultCollections(): NamedCollection[];
/** Get collection names that are included by default. */
export declare function getDefaultCollectionNames(): string[];
/** Update a collection's settings in the default scope. */
export declare function updateCollectionSettings(name: string, settings: {
    update?: string | null;
    includeByDefault?: boolean;
}): boolean;
/** Add or update a collection in the default scope. */
export declare function addCollection(name: string, path: string, pattern?: string, mirror?: ConfigMirror): void;
/** Remove a collection from the default scope. */
export declare function removeCollection(name: string, mirror?: ConfigMirror): boolean;
/** Rename a collection in the default scope. */
export declare function renameCollection(oldName: string, newName: string, mirror?: ConfigMirror): boolean;
/** Get global context from the default scope. */
export declare function getGlobalContext(): string | undefined;
/** Set global context in the default scope. */
export declare function setGlobalContext(context: string | undefined, mirror?: ConfigMirror): void;
/** Get all contexts for a collection in the default scope. */
export declare function getContexts(collectionName: string): ContextMap | undefined;
/** Add or update a context for a specific path in the default scope. */
export declare function addContext(collectionName: string, pathPrefix: string, contextText: string, mirror?: ConfigMirror): boolean;
/** Remove a context from the default scope. */
export declare function removeContext(collectionName: string, pathPrefix: string, mirror?: ConfigMirror): boolean;
/** List all contexts across all collections in the default scope. */
export declare function listAllContexts(): Array<{
    collection: string;
    path: string;
    context: string;
}>;
/** Find best matching context for a given collection and path. */
export declare function findContextForPath(collectionName: string, filePath: string): string | undefined;
/** Get the default scope's config file path (useful for error messages). */
export declare function getConfigPath(): string;
/** Check if the default scope's config file exists. */
export declare function configExists(): boolean;
/**
 * Validate a collection name
 * Collection names must be valid and not contain special characters
 */
export declare function isValidCollectionName(name: string): boolean;
