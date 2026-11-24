/**
 * warnings.ts - Warnings a store hands to its caller instead of printing them
 */
/**
 * The kinds of warning a store reports. Each code stays stable, so a caller
 * can match on it while the message wording changes.
 */
export type StoreWarningCode = 
/** sqlite-vec did not load; vector search is off and keyword search works. */
"SQLITE_VEC_UNAVAILABLE"
/** Progress of the one-time move of an old vector table to the per-collection layout. */
 | "VECTOR_UPGRADE"
/** VACUUM after the vector upgrade did not run. */
 | "VECTOR_VACUUM_FAILED"
/** An old vector table could not be copied and stays in place. */
 | "LEGACY_VECTOR_TABLE_KEPT"
/** A tree-sitter grammar did not load, so code files of that language chunk by regex. */
 | "AST_GRAMMAR_UNAVAILABLE"
/** A code file did not parse, so it chunks by regex. */
 | "AST_PARSE_FAILED"
/** An embed run reached its time limit and skipped what was left. */
 | "EMBED_SESSION_EXPIRED"
/** Too many chunks failed, so the embed run stopped. */
 | "EMBED_ERROR_RATE"
/** A text was cut to fit the embedding context. */
 | "EMBED_TEXT_TRUNCATED"
/** A text could not be embedded. */
 | "EMBED_FAILED"
/** Query expansion failed, so the search uses the query as given. */
 | "QUERY_EXPANSION_FAILED"
/** No reranking context could be created, so results stay unreranked. */
 | "RERANK_UNAVAILABLE"
/** An environment variable has an invalid value, so its default applies. */
 | "INVALID_ENV_VALUE"
/** GPU setup failed or was skipped, so models run on the CPU. */
 | "GPU_FALLBACK"
/** The llama.cpp runtime has no GPU acceleration. */
 | "NO_GPU"
/** Unloading idle models or contexts failed. */
 | "IDLE_UNLOAD_FAILED"
/** A model resource did not dispose in time or failed to dispose while closing. */
 | "DISPOSE_FAILED";
/** A warning from a store, with a stable code and the text QMD prints without a handler. */
export type StoreWarning = {
    code: StoreWarningCode;
    message: string;
    /** The error behind the warning, when there is one. */
    cause?: unknown;
};
export type StoreWarningHandler = (warning: StoreWarning) => void;
/**
 * Hand `warning` to `onWarning`. Without a handler, `print` writes it to the
 * console as QMD always has.
 */
export declare function reportWarning(onWarning: StoreWarningHandler | undefined, warning: StoreWarning, print: (message: string) => void): void;
