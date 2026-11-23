/**
 * Maintenance - Database cleanup operations for QMD.
 *
 * Wraps low-level store operations that the CLI needs for housekeeping.
 * Takes an internal Store in the constructor — allowed to access DB directly.
 */
import { vacuumDatabase, cleanupOrphanedContent, cleanupOrphanedVectors, deleteLLMCache, deleteInactiveDocuments, clearAllEmbeddings, optimizeDocumentsFts, previewCleanup, repackVectors, runCleanup, vectorTableLayout, } from "./store.js";
export class Maintenance {
    store;
    constructor(store) {
        this.store = store;
    }
    /** Run VACUUM on the SQLite database to reclaim space */
    vacuum() {
        vacuumDatabase(this.store.db);
    }
    /** Remove content rows that are no longer referenced by any document */
    cleanupOrphanedContent() {
        return cleanupOrphanedContent(this.store.db);
    }
    /** Remove vector embeddings for content that no longer exists */
    cleanupOrphanedVectors() {
        return cleanupOrphanedVectors(this.store.db);
    }
    /** Clear the LLM response cache (query expansion, reranking) */
    clearLLMCache() {
        return deleteLLMCache(this.store.db);
    }
    /** Delete documents marked as inactive (removed from filesystem) */
    deleteInactiveDocs() {
        return deleteInactiveDocuments(this.store.db);
    }
    /** Clear all vector embeddings; throws EmbedLockBusyError while an embed runs. */
    clearEmbeddings() {
        clearAllEmbeddings(this.store.db);
    }
    /** Compact FTS5 so deleted rows leave documents_fts_data (#550). */
    optimizeFts() {
        optimizeDocumentsFts(this.store.db);
    }
    /** Chunk layout of the vector table, or null without one. */
    vectorLayout() {
        return vectorTableLayout(this.store.db);
    }
    /** Move the live rows of mostly-empty vector chunks to the tail; see {@link repackVectors}. */
    repackVectors() {
        return repackVectors(this.store.db);
    }
    /** Preview what {@link run} would remove, without writing. */
    preview() {
        return previewCleanup(this.store.db);
    }
    /**
     * Full cleanup: cache, orphaned vectors, vector repack when the table is
     * mostly holes, inactive docs, orphaned content, FTS optimize, vacuum. Same
     * sequence as `qmd cleanup`.
     */
    run() {
        return runCleanup(this.store.db);
    }
}
