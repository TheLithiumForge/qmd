/**
 * Process-level exclusive lock for `qmd embed`.
 *
 * Concurrent embed runs against the same index can race on vectors_vec
 * (UNIQUE constraint on hash_seq). This lockfile keeps a second process from
 * starting while another embed holds the lock. Stale files left by crashed
 * processes are recovered via PID identity checks (same spirit as mcp-pid.ts).
 */
export type EmbedLockHandle = {
    lockPath: string;
    release: () => void;
};
/** Lockfile path sibling to the index database. */
export declare function embedLockPathForDb(dbPath: string): string;
/** True if `pid` still owns a live embed/qmd process (or is this process). */
export declare function isLiveEmbedLockHolder(pid: number): boolean;
/**
 * Try to acquire an exclusive embed lock at `lockPath`.
 * Returns a handle with `release()` on success, or `null` if another live
 * qmd process already holds the lock.
 */
export declare function tryAcquireEmbedLock(lockPath: string): EmbedLockHandle | null;
/** User-facing message when a second embed is skipped. */
export declare const EMBED_LOCK_BUSY_MESSAGE = "Another embed process is already running. Skipping.";
