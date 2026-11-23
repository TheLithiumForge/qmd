/**
 * Maintenance - Database cleanup operations for QMD.
 *
 * Wraps low-level store operations that the CLI needs for housekeeping.
 * Takes an internal Store in the constructor — allowed to access DB directly.
 */
import type { Store } from "./store.js";
import { type CleanupStats, type VectorTableLayout } from "./store.js";
export declare class Maintenance {
    private store;
    constructor(store: Store);
    /** Run VACUUM on the SQLite database to reclaim space */
    vacuum(): void;
    /** Remove content rows that are no longer referenced by any document */
    cleanupOrphanedContent(): number;
    /** Remove vector embeddings for content that no longer exists */
    cleanupOrphanedVectors(): number;
    /** Clear the LLM response cache (query expansion, reranking) */
    clearLLMCache(): number;
    /** Delete documents marked as inactive (removed from filesystem) */
    deleteInactiveDocs(): number;
    /** Clear all vector embeddings; throws EmbedLockBusyError while an embed runs. */
    clearEmbeddings(): void;
    /** Compact FTS5 so deleted rows leave documents_fts_data (#550). */
    optimizeFts(): void;
    /** Chunk layout of the vector table, or null without one. */
    vectorLayout(): VectorTableLayout | null;
    /** Move the live rows of mostly-empty vector chunks to the tail; see {@link repackVectors}. */
    repackVectors(): VectorTableLayout | null;
    /** Preview what {@link run} would remove, without writing. */
    preview(): CleanupStats;
    /**
     * Full cleanup: cache, orphaned vectors, vector repack when the table is
     * mostly holes, inactive docs, orphaned content, FTS optimize, vacuum. Same
     * sequence as `qmd cleanup`.
     */
    run(): CleanupStats;
}
