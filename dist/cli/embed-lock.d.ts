/**
 * Process-level exclusive lock for `qmd embed`.
 *
 * Concurrent embed runs against the same index race on vector_rows (UNIQUE
 * constraint on hash, seq, collection_id, #825), so a second process must skip
 * while the first one is embedding.
 *
 * Ownership is an exclusive SQLite write transaction held open for the whole
 * embed body, on a sidecar database next to the index
 * (`.qmd-embed.lock.sqlite` — never the index database itself, whose write
 * lock must stay available to `update`/`query`). SQLite takes the write lock
 * inside `BEGIN EXCLUSIVE` before that statement returns, and the kernel drops
 * it when the process exits or dies, so:
 *
 *   - ownership does not exist in a half-written state. The lock is a single
 *     client-side statement, so there is no window in which a live acquirer
 *     looks unowned and can be reclaimed by a competitor;
 *   - recovery needs neither PID checks nor deletes. A crashed holder's
 *     transaction is rolled back by the next opener, and a recycled PID is
 *     irrelevant because process identity is never part of the protocol;
 *   - nothing unlinks the sidecar, so a reclaiming process cannot delete a
 *     freshly acquired live lock by pathname, and two processes can never end
 *     up holding different inodes for the same lock.
 *
 * The sidecar (plus the `-wal`/`-shm` siblings a WAL database keeps) is created
 * on demand and deliberately left in place; removing it is only safe while no
 * embed runs. It lives in the index directory, which is already a WAL
 * location, so it has the same filesystem requirements as the index.
 *
 * Acquisition is fail-fast: a short busy timeout only absorbs an opener's
 * momentary lock install, so a second embed still skips straight away instead
 * of queueing behind hours of embedding.
 *
 * Legacy pidfile (`.qmd-embed.lock`, qmd <= 2.8.x): older versions wrote their
 * PID with an O_EXCL create and reclaimed the file by unlink-then-retry, which
 * had two races the sidecar makes impossible — the zero-byte window between
 * create and write (a competitor treats the half-written file as stale), and
 * two reclaimers each unlinking by pathname (the second removes a lock that
 * had just been acquired live). This module never creates and never takes
 * ownership from the pidfile, but it still reads it so an older qmd that is
 * embedding right now is respected: a pidfile naming a live qmd process means
 * "busy", a stale one is removed, and an empty/unparsable one — an older
 * version preempted or killed between create and write — is treated as owned
 * for a short settle window before being treated as abandoned. Legacy
 * handling is advisory and fail-safe: it runs only while this process owns the
 * sidecar, every error in it is swallowed, and the worst case is a leftover
 * pidfile — it can neither block nor fail an otherwise valid acquisition.
 *
 * Limits of mixed versions: an older qmd *started* while a newer one embeds
 * does not see the sidecar and never writes it, so it can still run an embed
 * body concurrently with a new version; and a new version skips whenever the
 * pidfile names a live qmd process, even one that is not embedding (command
 * line, not intent, is all a stale pidfile can tell us). New versions never
 * write the pidfile, so old-version detection of a new holder is impossible by
 * construction. Treat "old and new qmd on the same index" as unsupported; the
 * pidfile read only exists so a half-finished upgrade does not immediately
 * double-run.
 */
/**
 * Lock lifecycle (explicit, per handle):
 *
 *   free      → nobody holds the sidecar write transaction
 *   acquired  → this process holds it; `EmbedLockHandle.release` ends it
 *   released  → terminal; the transaction is closed and cannot be re-held
 *
 * `busy` is the other acquisition outcome: some other live holder owns it (or
 * an older qmd still owns the legacy pidfile).
 */
export type EmbedLockHandle = {
    /** Legacy pidfile path the caller asked to lock (API compatibility). */
    lockPath: string;
    /** Sidecar database whose open write transaction *is* the lock. */
    statePath: string;
    /** End ownership. Idempotent; leaves the sidecar file on disk. */
    release: () => void;
};
/** Which artifact made an acquisition attempt lose. */
export type EmbedLockBusyReason = 
/** Another process holds the sidecar write transaction (the normal case). */
{
    kind: "sidecar";
}
/** An older qmd still owns the legacy pidfile; it is deliberately respected. */
 | {
    kind: "legacy";
    pid: number;
};
/** Outcome of one acquisition attempt. */
export type EmbedLockAcquireResult = {
    status: "acquired";
    handle: EmbedLockHandle;
} | {
    status: "busy";
    reason: EmbedLockBusyReason;
};
/** Legacy pidfile path sibling to the index database. */
export declare function embedLockPathForDb(dbPath: string): string;
/** Sidecar database that carries the real lock for `lockPath`. */
export declare function embedLockStatePath(lockPath: string): string;
/** True if `pid` still owns a live embed/qmd process (or is this process). */
export declare function isLiveEmbedLockHolder(pid: number): boolean;
/**
 * Try to acquire the exclusive embed lock at `lockPath`.
 *
 * Returns `{ status: "acquired", handle }` on success or
 * `{ status: "busy", reason }` if another live holder owns the lock. Throws
 * only on unexpected I/O or database errors.
 */
export declare function acquireEmbedLock(lockPath: string): EmbedLockAcquireResult;
/**
 * Try to acquire an exclusive embed lock at `lockPath`.
 * Returns a handle with `release()` on success, or `null` if another live
 * qmd process already holds the lock.
 */
export declare function tryAcquireEmbedLock(lockPath: string): EmbedLockHandle | null;
/** User-facing message when a second embed is skipped. */
export declare const EMBED_LOCK_BUSY_MESSAGE = "Another embed process is already running. Skipping.";
