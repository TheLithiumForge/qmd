/**
 * vec-layout.ts - Names and resolution of the sqlite-vec vector layout.
 *
 * Vectors live in one vec0 table partitioned by an integer collection id, one
 * row per (chunk, active collection). `vector_rows` maps each vec0 rowid back
 * to its (hash, seq, collection_id), and `vector_collection_ids` maps names to
 * ids. The integer key is what makes `qmd collection rename` a one-row update:
 * vec0 rejects UPDATE on a partition key, so a name-keyed partition would have
 * to rewrite every row of the collection.
 *
 * A layout change needs a new permanent table name: `ALTER TABLE RENAME` on a
 * vec0 table leaves its shadow tables under the old name (sqlite-vec 0.1.9),
 * and SQLite refuses to rename shadow tables by hand. `vecLayout` is the one
 * place that knows which table is live, so no other module spells the names.
 */
import type { Database } from "./db.js";
export declare const VEC_TABLE = "vectors_by_collection";
export declare const VEC_ROWS_TABLE = "vector_rows";
export declare const VEC_COLLECTION_IDS_TABLE = "vector_collection_ids";
export declare const LEGACY_VEC_TABLE = "vectors_vec";
/** vec0's shadow tables for a virtual table name. */
export type VecShadowTables = {
    chunks: string;
    rowids: string;
    vectorChunks: string;
    info: string;
};
export type VecLayout = {
    kind: "none";
} | {
    kind: "legacy";
    table: typeof LEGACY_VEC_TABLE;
    dimensions: number | null;
    keyedByHashSeq: boolean;
    shadow: VecShadowTables;
} | {
    kind: "partitioned";
    table: typeof VEC_TABLE;
    dimensions: number | null;
    shadow: VecShadowTables;
};
export type ReadableVecLayout = Exclude<VecLayout, {
    kind: "none";
}>;
export declare function parseDimensions(sql: string | null): number | null;
/**
 * Which vector layout the database holds. A legacy table wins while it
 * exists: the migration drops it as its last step, so that drop is the flip.
 */
export declare function vecLayout(db: Database): VecLayout;
/** True when the partitioned vector index exists; vector search reads nothing else. */
export declare function hasVectorIndex(db: Database): boolean;
/**
 * A schema entry can outlive the vec0 module (reopening without sqlite-vec
 * loaded), in which case touching the table throws "no such module".
 */
export declare function vecTableReadable(db: Database, layout: ReadableVecLayout): boolean;
export declare function createVectorMetadataTables(db: Database): void;
export declare function createPartitionedVecTable(db: Database, dimensions: number): void;
export declare function resolveCollectionId(db: Database, name: string): number | undefined;
/** Ids of the named collections that have one; names without an id are absent. */
export declare function resolveCollectionIds(db: Database, names: readonly string[]): Map<string, number>;
export declare function allocateCollectionId(db: Database, name: string): number;
export declare function renameCollectionId(db: Database, oldName: string, newName: string): void;
export declare function deleteCollectionId(db: Database, name: string): void;
/**
 * Integer parameter for the vec0 table. better-sqlite3 binds every JS number
 * as a double, and vec0 checks the bound type of its partition key and rowid
 * instead of applying column affinity, so those parameters go in as bigint.
 */
export declare function vecInteger(value: number | bigint): bigint;
/**
 * One bound parameter for `json_each(?)`: a scoped search over many
 * partitions can return more rowids than SQLite allows as separate
 * parameters (32,766).
 */
export declare function rowidList(rowids: readonly number[]): string;
/** Deletes vector rows by rowid from the vec0 table (when it exists) and the mapping. */
export declare function deletePartitionRows(db: Database, rowids: readonly number[]): void;
/** Deletes every partition row of a hash, in every collection. */
export declare function deletePartitionRowsOfHash(db: Database, hash: string): void;
/** Names of the collections with an active document for the hash: the partitions that must hold its vectors. */
export declare function activeCollectionsOfHash(db: Database, hash: string): string[];
/**
 * Replace or insert the vector of (hash, seq) in one collection's partition.
 * vec0 ignores OR REPLACE, so an existing row is deleted and its rowid reused.
 */
export declare function upsertPartitionVector(db: Database, hash: string, seq: number, collectionId: number, embedding: Float32Array | Uint8Array): void;
/** Bulk writer that inserts a vector under a collection unless that partition row exists. */
export declare class PartitionWriter {
    private readonly db;
    private readonly ids;
    private readonly collectionsOf;
    private readonly insertRow;
    private readonly insertVec;
    constructor(db: Database);
    private idOf;
    /** True when a row was written; false when the partition already held (hash, seq). */
    writeToCollection(hash: string, seq: number, collection: string, embedding: Uint8Array | Float32Array): boolean;
    writeToActiveCollections(hash: string, seq: number, embedding: Uint8Array | Float32Array): number;
}
/**
 * Lookup of stored vector bytes by (hash, seq) from whichever partition holds
 * the chunk, with its two statements prepared once for callers that loop.
 */
export declare function storedEmbeddingLookup(db: Database): (hash: string, seq: number) => Uint8Array | undefined;
/** Stored vector bytes of (hash, seq) from whichever partition holds it. */
export declare function storedEmbedding(db: Database, hash: string, seq: number): Uint8Array | undefined;
/** (hash, seq) behind a vec0 rowid. */
export declare function partitionRowKey(db: Database, rowid: number): {
    hash: string;
    seq: number;
} | undefined;
export type MissingPartitionRow = {
    hash: string;
    seq: number;
    collection: string;
};
/**
 * Chunks recorded in content_vectors for an active document that have no row
 * in that document's collection partition. Each one is a vector to copy from
 * another partition (a hash that gained a collection) or, with no partition
 * holding it, a chunk to embed again.
 */
export declare function missingPartitionRows(db: Database, collection?: string): MissingPartitionRow[];
