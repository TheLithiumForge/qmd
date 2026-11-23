/**
 * Maintenance - Database cleanup operations for QMD.
 *
 * Wraps low-level store operations that the CLI needs for housekeeping.
 * Takes an internal Store in the constructor — allowed to access DB directly.
 */
import { vacuumDatabase, cleanupOrphanedContent, cleanupOrphanedVectors, deleteLLMCache, deleteInactiveDocuments, clearAllEmbeddings, optimizeDocumentsFts, previewCleanup, runCleanup, } from "./store.js";
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
    /** Clear all vector embeddings (forces re-embedding) */
    clearEmbeddings() {
        clearAllEmbeddings(this.store.db);
    }
    /** Compact FTS5 so deleted rows leave documents_fts_data (#550). */
    optimizeFts() {
        optimizeDocumentsFts(this.store.db);
    }
    /** Preview what {@link run} would remove, without writing. */
    preview() {
        return previewCleanup(this.store.db);
    }
    /**
     * Full cleanup: cache, orphaned vectors, inactive docs, orphaned content,
     * FTS optimize, vacuum. Same sequence as `qmd cleanup`.
     */
    run() {
        return runCleanup(this.store.db);
    }
}
