/**
 * MCP daemon pidfile identity + lifecycle helpers.
 *
 * A pidfile is only a *claim* about a process. It becomes unsafe after PID
 * reuse (e.g. post-reboot), when it is unparsable, when it cannot be read at
 * all, or when a starter loses a race against another starter. Every entry
 * point therefore classifies the file into an explicit state before acting:
 *
 *   absent      ENOENT                           -> nothing to stop, start freely
 *   unreadable  exists but read failed (EACCES…) -> never signalled, never deleted
 *   malformed   contents are not a positive PID  -> stale, drop the file
 *   stale       PID dead, or alive but not qmd    -> stale, drop the file, never signal
 *   running     PID alive and looks like qmd      -> the daemon this file describes
 *
 * Every *mutation* of a pidfile — publication by a starting daemon, stale
 * cleanup by start/stop/status, and the daemon unlinking its own file on exit
 * — runs inside one cross-process critical section: an exclusive SQLite write
 * transaction on a sidecar database next to the pidfile
 * (`mcp.pid.lock.sqlite`, see `mcpDaemonLockStatePath`). SQLite takes the
 * write lock before `BEGIN EXCLUSIVE` returns and the kernel drops it when the
 * process exits or dies, so:
 *
 *  - classify-then-act transitions are atomic with respect to every other qmd
 *    process. A concurrent starter/stopper/status can neither displace a live
 *    daemon's pidfile nor resurrect (or delete) one that was just
 *    republished. The earlier protocol moved a suspicious pidfile aside and
 *    linked it back, which left the name briefly absent — a window in which a
 *    concurrent `status` saw "no pidfile" and a third starter could publish
 *    into the restore path, losing track of a live daemon. There is no
 *    move-aside step left to race: recovery happens inside the section and
 *    the only files ever unlinked are the pidfile itself (after re-verifying
 *    it under the section) and a private staging file;
 *  - recovery needs no PID checks and no delete. A crashed holder's
 *    transaction is rolled back by the next opener, and the sidecar is never
 *    unlinked, so a reclaimer cannot delete a freshly acquired lock by
 *    pathname;
 *  - publication is a write to a private staging file followed by `rename`,
 *    so a lock-free reader (status, `stop`'s first look) never observes
 *    half-written contents and can never mistake a live daemon for a
 *    malformed file.
 *
 * The remaining hazard is on the *process* side, not the filesystem: a child
 * that has just been `spawn()`ed has not exec'd yet, so for a few milliseconds
 * its command line is the parent's (or empty). A starter that published that
 * PID would hand `stop`/`status` a file that classifies as `not-qmd` while a
 * real daemon owns it — the parser would "clean up" a live daemon. Three rules
 * close that window: `waitForDaemonChildIdentity` is what a starter waits on
 * before publishing, `claimMcpDaemonPidfile` refuses to publish a PID it cannot
 * itself identify as a live qmd process (a process may always publish itself),
 * and a managed daemon binds its port only after the pidfile names it
 * (`waitForDaemonPidfileOwnership`), so two concurrent starts can never both
 * serve and a child whose starter died never serves untracked.
 *
 * Sections never wait for anything else — no signal, no process exit — and are
 * bounded by a busy budget instead of queueing, so a `stop` that waits for a
 * daemon to die cannot deadlock against that daemon's own exit handler (which
 * takes the section with a zero budget and skips if it is taken).
 *
 * Start/stop transitions are driven by that state: a recycled PID is never
 * signalled, "stopped" is only reported once the PID is actually gone, of two
 * concurrent `--daemon` starts at most one ends up believing it owns the
 * pidfile, and no code path deletes a pidfile it did not first re-verify under
 * the critical section.
 */
/**
 * How long `stop` waits for a daemon to exit before giving up on it.
 *
 * Comfortably above the server's own graceful-shutdown deadline
 * (`MCP_SHUTDOWN_TIMEOUT_MS`, 5 s) plus the listener and store teardown that
 * follows it: a daemon shutting down exactly as designed must not be reported
 * as a timeout, which would keep a pidfile it is about to remove.
 */
export declare const MCP_DAEMON_STOP_TIMEOUT_MS = 15000;
/** Poll interval used while waiting for the daemon PID to disappear. */
export declare const MCP_DAEMON_STOP_POLL_MS = 50;
/** How long a start waits for its spawned child to identify itself as qmd. */
export declare const MCP_DAEMON_SPAWN_IDENTITY_TIMEOUT_MS = 10000;
/** Poll interval used while waiting for the spawned child's identity. */
export declare const MCP_DAEMON_SPAWN_IDENTITY_POLL_MS = 20;
/**
 * Exit handlers must never wait on a competitor: a `stop` is *supposed* to be
 * waiting for this process to die, so blocking here would deadlock the two
 * against each other. Zero budget means "skip if someone else is in there".
 */
export declare const MCP_DAEMON_EXIT_SECTION_BUDGET_MS = 0;
/**
 * Identity of a pidfile as observed on disk. `stale.pid` always carries the
 * recorded PID so callers can report it; it is never safe to signal.
 */
export type McpDaemonPidState = {
    status: "absent";
} | {
    status: "unreadable";
    error: string;
} | {
    status: "malformed";
    raw: string;
} | {
    status: "running";
    pid: number;
} | {
    status: "stale";
    pid: number;
    reason: "exited" | "not-qmd";
};
/** Result of the stop transition. Only `stopped` removes the pidfile of a live daemon. */
export type McpDaemonStopOutcome = {
    outcome: "not-running";
} | {
    outcome: "unreadable";
    error: string;
} | {
    outcome: "cleaned-stale";
    reason: "malformed" | "exited" | "not-qmd";
} | {
    outcome: "stopped";
    pid: number;
} | {
    outcome: "unsignalable";
    pid: number;
    error: string;
} | {
    outcome: "timeout";
    pid: number;
}
/** The pidfile kept changing, or its critical section stayed unavailable. */
 | {
    outcome: "busy";
    error: string;
};
/** Result of the start transition's pidfile claim. */
export type McpDaemonStartClaim = {
    claimed: true;
    replaced: "malformed" | "stale" | null;
}
/** Another live daemon owns the file; the caller must not keep its child. */
 | {
    claimed: false;
    reason: "running";
    runningPid: number;
}
/** Ownership could not be established without clobbering a file: give up. */
 | {
    claimed: false;
    reason: "unclaimable";
    error: string;
};
/** Result of dropping a pidfile that describes no live daemon. */
export type McpDaemonStaleCleanup = 
/** Re-verified as stale/malformed inside the section, then removed. */
{
    status: "removed";
    state: McpDaemonPidState;
}
/** Re-verification found something else (gone, live, unreadable): untouched. */
 | {
    status: "kept";
    state: McpDaemonPidState;
}
/** The critical section could not be taken: nothing was touched. */
 | {
    status: "locked-out";
    error: string;
};
/** How far a freshly spawned daemon child has got. */
export type McpDaemonSpawnReadiness = {
    status: "running";
} | {
    status: "exited";
} | {
    status: "timeout";
};
/**
 * Pid/log filenames for the MCP HTTP daemon.
 * The default index keeps `mcp.pid` / `mcp.log` for compatibility; named
 * indexes are scoped so a named daemon can run alongside the default (#772).
 */
export declare function mcpDaemonStateFiles(indexName?: string): {
    pidFile: string;
    logFile: string;
};
/**
 * Sidecar database whose exclusive write transaction *is* the pidfile critical
 * section. It sits next to the pidfile, so each index's daemon state (default
 * vs `--index <name>`) is coordinated independently. The file is created on
 * demand and deliberately left in place: unlinking it would let a
 * concurrent opener create a different inode while a straggler still holds the
 * old one.
 */
export declare function mcpDaemonLockStatePath(pidFile: string): string;
/** True if a process command line looks like a qmd CLI invocation. */
export declare function looksLikeQmdMcpCommand(cmdline: string): boolean;
/** Read process cmdline (Linux /proc preferred; ps fallback for macOS). */
export declare function readProcessCmdline(pid: number): string | null;
/** Parse pidfile contents strictly: a whole positive integer, else null. */
export declare function parsePidfileContent(raw: string | null): number | null;
/**
 * Classify a PID against the live process table.
 * `not-qmd` covers both "alive but a different program" (recycled PID) and
 * "alive but cmdline unreadable" — neither may be signalled or treated as
 * "already running".
 */
export declare function classifyProcessIdentity(pid: number): "running" | "exited" | "not-qmd";
/**
 * Returns true only if `pid` is alive AND its command line looks like qmd.
 * If cmdline cannot be read or does not match, returns false (treat as stale).
 */
export declare function isQmdMcpPid(pid: number): boolean;
/** Classify raw pidfile contents (`null` = file does not exist). */
export declare function classifyMcpDaemonPidfile(raw: string | null): McpDaemonPidState;
/**
 * Read and classify the pidfile at `pidFile`.
 *
 * Only ENOENT/ENOTDIR mean "no pidfile". Every other failure (EACCES, EIO,
 * EPERM, a directory in the way) is reported as `unreadable`: the file may
 * well belong to a live daemon, so callers must fail safe — never signal,
 * never delete, never claim over it.
 *
 * Lock-free by design: publication is a `rename` and removal re-verifies under
 * the critical section, so a reader either sees a complete old file, a
 * complete new file, or no file.
 */
export declare function readMcpDaemonPidState(pidFile: string): McpDaemonPidState;
/**
 * True if `pidFile` records exactly `pid`. Pure file check — no process-table
 * probe — so it is cheap enough for exit handlers, which only need to know
 * whether the file is theirs. A plain read; deleting on the strength of it
 * requires `removeMcpDaemonPidfileIfRecords`, which re-checks under the
 * critical section.
 */
export declare function pidfileRecordsPid(pidFile: string, pid: number): boolean;
/** True if a process exists for `pid` (zombies included; EPERM counts as alive). */
export declare function isProcessAlive(pid: number): boolean;
/**
 * Claim `pidFile` for the daemon `pid`.
 *
 * The decision runs entirely inside the critical section, so of two concurrent
 * starters exactly one wins and a live daemon's file is never replaced. A
 * successful claim republishes the name atomically, so a reader sees either the
 * previous owner's PID or the new one — never "no PID file".
 *
 * `pid` is the daemon process the caller is about to rely on. Unless it is this
 * process (a daemon publishing itself), it must already classify as a live qmd
 * process: otherwise the file would be published for a PID nobody can identify,
 * and the next `stop`/`status` would read it as stale and lose the daemon.
 * Starters wait for that with `waitForDaemonChildIdentity` before calling this.
 */
export declare function claimMcpDaemonPidfile(pidFile: string, pid: number): McpDaemonStartClaim;
/**
 * Remove `pidFile` if, re-verified inside the critical section, it still
 * describes no live daemon.
 *
 * This is the only way stale state is dropped: the caller's earlier read is
 * only a hint. A daemon that a concurrent start published in the meantime is
 * `kept` untouched, which is what makes a racing `status`/`stop`/`start`
 * combination harmless. Callers pass an unreadable file through untouched, as
 * it may describe a daemon we cannot inspect.
 */
export declare function removeStaleMcpDaemonPidfile(pidFile: string): McpDaemonStaleCleanup;
/**
 * Remove `pidFile` if it still records `pid`, inside the critical section.
 *
 * This is the only safe unlink for an owner: read-then-unlink without the
 * section can delete a pidfile that a concurrent starter republished after the
 * owner's PID was replaced. Returns false when the file is not ours, when the
 * check could not run, or when the section was unavailable — leaving the file
 * behind is always safe, since the next transition re-classifies it.
 *
 * `budgetMs` is the section budget; exit handlers pass
 * `MCP_DAEMON_EXIT_SECTION_BUDGET_MS` so they skip instead of waiting on a
 * `stop` that is waiting for them.
 */
export declare function removeMcpDaemonPidfileIfRecords(pidFile: string, pid: number, options?: {
    budgetMs?: number;
}): boolean;
/**
 * Wait until the freshly spawned daemon `pid` identifies itself as qmd.
 *
 * `spawn()` returns before the child execs. Until it does, its command line is
 * the parent's or empty, so the PID classifies as `not-qmd` — the exact window
 * in which a published pidfile would look stale to a competitor. Starters wait
 * here first and publish only afterwards.
 *
 * `hasExited` lets the caller surface a child that died before exec (failed
 * exec, or a bind error) as `exited` rather than burning the whole timeout.
 */
export declare function waitForDaemonChildIdentity(pid: number, options?: {
    timeoutMs?: number;
    pollMs?: number;
    hasExited?: () => boolean;
}): Promise<McpDaemonSpawnReadiness>;
/**
 * Wait until `pidFile` names `pid` — or names another live daemon.
 *
 * A daemon spawned by `qmd mcp --http --daemon` uses this as its start gate:
 * the pidfile is the ownership token that decides which of two concurrent
 * starts is allowed to serve, so the loser exits instead of racing the winner
 * for the port. The same gate covers the crashed-starter case: a child whose
 * parent died before publishing is never named by any pidfile and exits
 * instead of serving untracked.
 */
export declare function waitForDaemonPidfileOwnership(pidFile: string, pid: number, options?: {
    timeoutMs?: number;
    pollMs?: number;
}): Promise<"owned" | "taken" | "timeout">;
/**
 * Stop the daemon described by `pidFile`.
 *
 * Only `running` is signalled. Absent/malformed/stale files are dropped
 * without touching any process; `unreadable` files are left exactly as they
 * are (they may describe a live daemon we cannot inspect). A live daemon keeps
 * its pidfile until its PID is actually gone, so a daemon that ignores SIGTERM
 * is not orphaned as untracked: the caller sees `timeout` and can retry.
 *
 * Each decision is taken under the critical section and re-verified there, so
 * a stale file can only be dropped if it is *still* stale at that moment; if a
 * concurrent start republished the file, this loop decides again with the new
 * content (and stops that daemon) instead of deleting its file.
 */
export declare function stopMcpDaemon(pidFile: string, options?: {
    timeoutMs?: number;
    pollMs?: number;
}): Promise<McpDaemonStopOutcome>;
