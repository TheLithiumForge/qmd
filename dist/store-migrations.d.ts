/**
 * store-migrations.ts - PRAGMA user_version steps applied when a store opens.
 *
 * Version 1 installs the FTS sync triggers. Version 2 moves every vector out
 * of the legacy `vectors_vec` table (one row per chunk, keyed by hash_seq)
 * into the layout `vec-layout.ts` describes: one row per (chunk, active
 * collection) in a vec0 table partitioned by collection id.
 *
 * The copy walks the legacy table's chunk blobs in chunk_id order, one chunk
 * per IMMEDIATE transaction, and keeps the last copied chunk_id in
 * store_config. A killed process resumes from that cursor, and two processes
 * that open the same database take turns on chunks because each reads the
 * cursor inside its own write transaction. A verification pass that copies
 * rows the walk missed, the version stamp and the drop of the legacy table
 * share one IMMEDIATE transaction, so that drop is the flip.
 */
import type { Database } from "./db.js";
import { type StoreWarningHandler } from "./warnings.js";
export declare const FTS_SYNC_TRIGGERS_VERSION = 1;
export declare const VECTOR_PARTITION_VERSION = 2;
export declare function getUserVersion(db: Database): number;
/**
 * Run `step` and stamp `version` in one IMMEDIATE transaction. The
 * double-checked read makes concurrent first opens of one database apply the
 * step once: busy_timeout serializes the transactions, and the loser sees the
 * version the winner stamped.
 */
export declare function applyVersionedStep(db: Database, version: number, step: () => void): void;
export type VectorMigrationPhase = "copy" | "verify" | "flip" | "vacuum" | "done";
export type VectorMigrationProgress = {
    phase: VectorMigrationPhase;
    /** Legacy rows processed so far. */
    copied: number;
    /** Legacy rows at the start of this process's run. */
    total: number;
};
export type VectorMigrationOptions = {
    sqliteVecAvailable: boolean;
    onProgress?: (progress: VectorMigrationProgress) => void;
    onWarning?: StoreWarningHandler;
};
export type VectorMigrationResult = "applied" | "deferred";
/**
 * A content_vectors row with no vector in any partition is a chunk to embed
 * again; without the row the pending detector picks the hash up.
 */
export declare function deleteVectorlessContentVectors(db: Database): number;
/**
 * The version 2 step. Returns "deferred" when the legacy table cannot be read
 * because sqlite-vec is not loaded: the version stays behind and the next open
 * with the extension retries, while FTS keeps working. The step keys on the
 * legacy table rather than the version so that a legacy table an older build
 * created on an already-stamped database is copied too.
 */
export declare function migrateVectorLayout(db: Database, options: VectorMigrationOptions): VectorMigrationResult;
export type StoreMigrationDeps = VectorMigrationOptions & {
    installFtsSyncTriggers: (db: Database) => void;
};
/**
 * The vector step also runs on a stamped database that holds a legacy table:
 * an older build recreates `vectors_vec` on any database it embeds into, and
 * the resolver reports that table as the layout until it is gone.
 */
export declare function runStoreMigrations(db: Database, deps: StoreMigrationDeps): void;
