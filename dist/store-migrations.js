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
import { LEGACY_VEC_TABLE, PartitionWriter, VEC_ROWS_TABLE, VEC_TABLE, createPartitionedVecTable, missingPartitionRows, parseDimensions, vecLayout, vecTableReadable, } from "./vec-layout.js";
import { reportWarning } from "./warnings.js";
export const FTS_SYNC_TRIGGERS_VERSION = 1;
export const VECTOR_PARTITION_VERSION = 2;
const CURSOR_KEY = "vector_partition_cursor";
export function getUserVersion(db) {
    const row = db.prepare(`PRAGMA user_version`).get();
    const value = row ? Object.values(row)[0] : 0;
    return typeof value === "number" ? value : Number(value) || 0;
}
/**
 * Run `step` and stamp `version` in one IMMEDIATE transaction. The
 * double-checked read makes concurrent first opens of one database apply the
 * step once: busy_timeout serializes the transactions, and the loser sees the
 * version the winner stamped.
 */
export function applyVersionedStep(db, version, step) {
    if (getUserVersion(db) >= version)
        return;
    db.exec(`BEGIN IMMEDIATE`);
    try {
        if (getUserVersion(db) < version) {
            step();
            db.exec(`PRAGMA user_version = ${version}`);
        }
        db.exec(`COMMIT`);
    }
    catch (err) {
        db.exec(`ROLLBACK`);
        throw err;
    }
}
function liveSlots(chunk) {
    const slots = [];
    for (let i = 0; i < chunk.size; i++) {
        if ((chunk.validity[i >> 3] >> (i & 7)) & 1)
            slots.push(i);
    }
    return slots;
}
function splitHashSeq(key) {
    const at = key.lastIndexOf("_");
    if (at <= 0)
        return null;
    const seq = Number(key.slice(at + 1));
    return Number.isInteger(seq) ? { hash: key.slice(0, at), seq } : null;
}
function readCursor(db) {
    const row = db.prepare(`SELECT value FROM store_config WHERE key = ?`).get(CURSOR_KEY);
    const value = row ? Number(row.value) : Number.NaN;
    return Number.isFinite(value) ? value : -1;
}
function writeCursor(db, chunkId) {
    db.prepare(`INSERT INTO store_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(CURSOR_KEY, String(chunkId));
}
function copyLegacyChunks(db, legacy, dimensions, onProgress) {
    const writer = new PartitionWriter(db);
    const nextChunk = db.prepare(`SELECT chunk_id AS chunkId, size, validity, rowids FROM ${legacy.shadow.chunks} WHERE chunk_id > ? ORDER BY chunk_id LIMIT 1`);
    const vectorsOf = db.prepare(`SELECT vectors FROM ${legacy.shadow.vectorChunks} WHERE rowid = ?`);
    const keyOf = db.prepare(`SELECT id FROM ${legacy.shadow.rowids} WHERE rowid = ?`);
    const hasChunkRow = db.prepare(`SELECT 1 FROM content_vectors WHERE hash = ? AND seq = ?`);
    const bytesPerVector = dimensions * 4;
    let copied = 0;
    const copyOne = db.transaction(() => {
        if (vecLayout(db).kind !== "legacy")
            return false;
        const chunk = nextChunk.get(readCursor(db));
        if (!chunk)
            return false;
        const blob = vectorsOf.get(chunk.chunkId)?.vectors;
        const rowids = new DataView(chunk.rowids.buffer, chunk.rowids.byteOffset, chunk.rowids.byteLength);
        for (const slot of liveSlots(chunk)) {
            copied++;
            const key = keyOf.get(rowids.getBigInt64(slot * 8, true))?.id;
            const parsed = key === undefined ? null : splitHashSeq(key);
            if (!parsed || !blob || blob.byteLength < (slot + 1) * bytesPerVector)
                continue;
            if (!hasChunkRow.get(parsed.hash, parsed.seq))
                continue;
            const embedding = blob.subarray(slot * bytesPerVector, (slot + 1) * bytesPerVector);
            writer.writeToActiveCollections(parsed.hash, parsed.seq, embedding);
        }
        writeCursor(db, chunk.chunkId);
        return true;
    });
    while (copyOne.immediate()) {
        onProgress(copied);
    }
}
/**
 * Rows the chunk walk can miss: a pre-upgrade `qmd cleanup` repacking the
 * legacy table moves live rows into its newest chunk while the walk is past
 * it, and a process on the old layout keeps writing into chunks the walk has
 * left behind. They are copied by key from the legacy table. Runs inside the
 * caller's write transaction.
 */
function copyStragglers(db, legacy) {
    const legacyVector = db.prepare(`SELECT embedding FROM ${legacy.table} WHERE hash_seq = ?`);
    const writer = new PartitionWriter(db);
    for (const missing of missingPartitionRows(db)) {
        const row = legacyVector.get(`${missing.hash}_${missing.seq}`);
        if (row)
            writer.writeToCollection(missing.hash, missing.seq, missing.collection, row.embedding);
    }
}
/**
 * A content_vectors row with no vector in any partition is a chunk to embed
 * again; without the row the pending detector picks the hash up.
 */
export function deleteVectorlessContentVectors(db) {
    return db.prepare(`
    DELETE FROM content_vectors
    WHERE NOT EXISTS (SELECT 1 FROM ${VEC_ROWS_TABLE} vr WHERE vr.hash = content_vectors.hash AND vr.seq = content_vectors.seq)
  `).run().changes;
}
/**
 * The straggler copy, the vectorless cleanup and the drop hold one write
 * lock: a legacy row written between them by a process on the old layout
 * would otherwise leave a content_vectors row whose only vector is in the
 * dropped table, which the pending detector never re-embeds. `onFlip` runs
 * with that lock held, after the verification and before the drop.
 */
function flipToPartitioned(db, legacy, onFlip) {
    db.transaction(() => {
        if (vecLayout(db).kind !== "legacy")
            return;
        copyStragglers(db, legacy);
        deleteVectorlessContentVectors(db);
        onFlip();
        db.prepare(`DELETE FROM store_config WHERE key = ?`).run(CURSOR_KEY);
        db.exec(`PRAGMA user_version = ${Math.max(getUserVersion(db), VECTOR_PARTITION_VERSION)}`);
        db.exec(`DROP TABLE IF EXISTS ${LEGACY_VEC_TABLE}`);
    }).immediate();
}
/** Dimensions of the partitioned table; undefined when there is no table. */
function partitionedTableDimensions(db) {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(VEC_TABLE);
    return row ? parseDimensions(row.sql) : undefined;
}
/**
 * Check and create share one IMMEDIATE transaction with a double-checked
 * read, matching applyVersionedStep: concurrent first openers create the
 * partitioned table once and the losers reuse it.
 */
function ensurePartitionedTable(db, dimensions) {
    const exists = () => {
        const existing = partitionedTableDimensions(db);
        if (existing === undefined)
            return false;
        if (existing !== dimensions) {
            throw new Error(`Vector migration found a ${VEC_TABLE} table with ${existing ?? "unknown"} dimensions while the legacy ${LEGACY_VEC_TABLE} table holds ${dimensions}d vectors`);
        }
        return true;
    };
    if (exists())
        return;
    db.transaction(() => {
        if (!exists())
            createPartitionedVecTable(db, dimensions);
    }).immediate();
}
/**
 * The version 2 step. Returns "deferred" when the legacy table cannot be read
 * because sqlite-vec is not loaded: the version stays behind and the next open
 * with the extension retries, while FTS keeps working. The step keys on the
 * legacy table rather than the version so that a legacy table an older build
 * created on an already-stamped database is copied too.
 */
export function migrateVectorLayout(db, options) {
    const layout = vecLayout(db);
    if (layout.kind !== "legacy") {
        applyVersionedStep(db, VECTOR_PARTITION_VERSION, () => { });
        return "applied";
    }
    if (!options.sqliteVecAvailable || !vecTableReadable(db, layout))
        return "deferred";
    if (!layout.keyedByHashSeq || layout.dimensions === null) {
        applyVersionedStep(db, VECTOR_PARTITION_VERSION, () => {
            db.exec(`DROP TABLE IF EXISTS ${LEGACY_VEC_TABLE}`);
        });
        return "applied";
    }
    const dimensions = layout.dimensions;
    const total = db.prepare(`SELECT COUNT(*) AS c FROM ${layout.shadow.rowids}`).get().c;
    const report = (phase, copied) => options.onProgress?.({ phase, copied, total });
    ensurePartitionedTable(db, dimensions);
    copyLegacyChunks(db, layout, dimensions, (copied) => report("copy", copied));
    if (vecLayout(db).kind === "legacy") {
        report("verify", total);
        flipToPartitioned(db, layout, () => report("flip", total));
        report("vacuum", total);
        try {
            db.exec(`VACUUM`);
        }
        catch (err) {
            reportWarning(options.onWarning, {
                code: "VECTOR_VACUUM_FAILED",
                message: `VACUUM after the vector migration did not run (${err instanceof Error ? err.message : String(err)}); run 'qmd cleanup' to reclaim the space.`,
                cause: err,
            }, (message) => console.warn(message));
        }
    }
    report("done", total);
    return "applied";
}
/**
 * The vector step also runs on a stamped database that holds a legacy table:
 * an older build recreates `vectors_vec` on any database it embeds into, and
 * the resolver reports that table as the layout until it is gone.
 */
export function runStoreMigrations(db, deps) {
    applyVersionedStep(db, FTS_SYNC_TRIGGERS_VERSION, () => deps.installFtsSyncTriggers(db));
    if (getUserVersion(db) < VECTOR_PARTITION_VERSION) {
        migrateVectorLayout(db, deps);
        return;
    }
    // A legacy table on a stamped store came from an older build; copying it
    // here is a repair, so a failure (a dimension mismatch with the partitioned
    // table) degrades vector search instead of blocking every open. The embed
    // path raises the actionable error when it next runs.
    if (vecLayout(db).kind === "legacy") {
        try {
            migrateVectorLayout(db, deps);
        }
        catch (err) {
            reportWarning(deps.onWarning, {
                code: "LEGACY_VECTOR_TABLE_KEPT",
                message: `Legacy vector table left in place: ${err instanceof Error ? err.message : String(err)}`,
                cause: err,
            }, (message) => console.warn(message));
        }
    }
}
