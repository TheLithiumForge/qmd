/**
 * QMD MCP Server - Model Context Protocol server for QMD
 *
 * Exposes QMD search and document retrieval as MCP tools and resources.
 * Documents are accessible via qmd:// URIs.
 *
 * Speaks MCP spec 2026-07-28 (stateless, no initialize handshake) and dual-speaks
 * 2025-era clients via the official SDK entries (`serveStdio` / `createMcpHandler`).
 */
import { type Server } from "node:http";
export type McpStartupOptions = {
    dbPath?: string;
};
/**
 * Admission state of an MCP transport.
 *
 * The transition order is the safety property both transports depend on, so it
 * is modelled explicitly instead of being implied by the order of teardown
 * calls: work may only touch the shared store/llm while `serving`; `draining`
 * refuses new work while already-admitted work settles; `stopped` is terminal
 * and means the store has been closed. Teardown MUST go
 * `serving -> draining -> stopped` and MUST NOT close the store before it
 * reaches `draining`, or an admitted handler keeps running against a closed
 * database.
 */
export type McpLifecycleState = "serving" | "draining" | "stopped";
export type McpLifecycle = {
    state(): McpLifecycleState;
    /**
     * Admit one unit of work, or return null once admission is closed
     * (`draining`/`stopped`). The returned release function is idempotent.
     * Callers MUST NOT touch the store when admission is refused.
     */
    admit(): (() => void) | null;
    /** `serving -> draining`. False when admission was already closed. */
    beginDrain(): boolean;
    /** `draining -> stopped`. False when called from `serving` or `stopped`. */
    finishTeardown(): boolean;
    /**
     * Resolves once no admitted work runs -- or, when `timeoutMs` is given,
     * after at most that long; the boolean reports whether idle was reached.
     * Omitting the timeout waits until idle, which is the graceful default: a
     * deadline is what interrupts work that is still using the store, so only a
     * caller that asks for one gets one.
     */
    waitForIdle(timeoutMs?: number): Promise<boolean>;
};
export declare function createMcpLifecycle(): McpLifecycle;
/**
 * Default graceful-shutdown deadline.
 *
 * Both transports bound their teardown with it: admitted work gets this long
 * to finish, then the remaining requests are aborted, the sockets are severed
 * and the stop call reports a {@link McpShutdownTimeoutError}. Cleanup keeps
 * going in the background -- the store is never closed underneath an operation
 * that is still running -- so "timed out" means "reported, and abandoned to
 * finish safely", not "the listener or store was torn down under live work".
 *
 * `shutdownDrainTimeoutMs` (HTTP) and `idleTimeoutMs` (stdio) override it.
 */
export declare const MCP_SHUTDOWN_TIMEOUT_MS = 5000;
/** Which teardown step was running when the deadline expired. */
export type McpShutdownPhase = "drain" | "transport" | "listener" | "store";
/**
 * Rejection of a stop/EOF shutdown that did not finish within its deadline.
 *
 * Typed so a caller can tell "still working, reported, cleanup continues"
 * apart from a failed teardown step: the abandoned work is aborted but the
 * store stays open until it actually settles.
 */
export declare class McpShutdownTimeoutError extends Error {
    /** Stable discriminator for callers that cannot use `instanceof`. */
    readonly code: "MCP_SHUTDOWN_TIMEOUT";
    /** The step that outlasted the deadline. */
    readonly phase: McpShutdownPhase;
    /** The deadline that expired, in milliseconds. */
    readonly timeoutMs: number;
    constructor(phase: McpShutdownPhase, timeoutMs: number);
}
/**
 * Abort reason for an admitted request whose client went away (or whose
 * shutdown deadline expired). Distinct from a normal completed close so a
 * route can tell "nobody is listening any more" from "the response is done".
 */
export declare class McpRequestAbortedError extends Error {
    readonly code: "MCP_REQUEST_ABORTED";
    constructor(message?: string);
}
/**
 * One deadline for a whole teardown. Every step races the same expiry, so the
 * request drain, the transport close, the listener close and the store close
 * share one budget instead of each getting its own fresh one.
 */
export type ShutdownDeadline = {
    /**
     * The shared expiry promise, rejecting with a {@link McpShutdownTimeoutError}
     * naming `phase` (the step in progress when the timer fires).
     */
    at(phase: McpShutdownPhase): Promise<never>;
    /** Milliseconds left before the deadline; 0 once it passed. */
    remainingMs(): number;
    /** Clears the timer so a finished teardown never holds the process open. */
    dispose(): void;
};
export declare function createShutdownDeadline(timeoutMs?: number): ShutdownDeadline;
/**
 * The irreversible steps of one transport teardown, in the lifecycle order the
 * safety properties depend on:
 *
 *   beginDrain -> beginListenerClose -> drain -> closeTransport ->
 *   listenerClosed -> closeStore -> finishTeardown
 *
 * `closeTransport` and `closeStore` MUST only run once no admitted work is
 * executing: closing the transport aborts the exchanges it still tracks, and
 * closing the store disposes the LLM and the database underneath them.
 */
export type McpTeardownSteps = {
    /** `serving -> draining`; false when the lifecycle was already drained. */
    beginDrain: () => boolean;
    /** Resolves true once no admitted work runs. Omit the timeout to wait forever. */
    waitForIdle: (timeoutMs?: number) => Promise<boolean>;
    /** Tells admitted requests their result can no longer be delivered. */
    abortWork: (reason: McpShutdownTimeoutError) => void;
    /** Ends sockets a stalled exchange or a half-sent body is parked on. */
    severConnections: () => void;
    /** Stops accepting connections; `listenerClosed` reports the completion. */
    beginListenerClose: () => void;
    /** Resolves once the listener closed (every connection ended). */
    listenerClosed: () => Promise<void>;
    /** Closes the MCP transport; only valid once the drain is idle. */
    closeTransport: () => Promise<void>;
    /** Closes the store, which also disposes the LLM it owns. */
    closeStore: () => Promise<void>;
    /** `draining -> stopped`, only once the store actually closed. */
    finishTeardown: () => boolean;
};
export type McpTeardownOptions = {
    /** Overrides {@link MCP_SHUTDOWN_TIMEOUT_MS}. */
    timeoutMs?: number;
    /** Where step failures and the timeout are reported. */
    log?: (message: string) => void;
};
export type McpTeardown = {
    /**
     * Starts the teardown on first call; every caller shares one promise.
     * Resolves when the server stopped cleanly and rejects with a
     * {@link McpShutdownTimeoutError} at the deadline -- in which case cleanup
     * continues in the background.
     */
    stop: () => Promise<void>;
    /**
     * Resolves only when every teardown step actually finished (or could not be
     * retried), including a cleanup that outlived a reported timeout. Never
     * rejects. A hung store keeps it pending: "stopped" is never claimed early.
     */
    closed: Promise<void>;
};
/**
 * Tear down one transport under a single deadline.
 *
 * Until the deadline, work admitted before `beginDrain()` may finish: the
 * listener stops accepting and the drain waits. At the deadline the caller of
 * `stop()` gets a {@link McpShutdownTimeoutError} immediately, while the
 * remaining cleanup is *abandoned into the background*: admitted requests are
 * aborted (their results are undeliverable), the sockets are severed, and then
 * the unbounded wait for idle, the transport close, the listener close and the
 * store close run in the same safe order. The store is therefore never closed
 * under an active operation, and `finishTeardown()` is only reached once
 * `closeStore()` actually resolved.
 */
export declare function runMcpTeardown(steps: McpTeardownSteps, options?: McpTeardownOptions): McpTeardown;
/** Where the standalone termination policy reports and how it ends the process. */
export type McpTermination = {
    /** Ends the process (`process.exit` standalone, a spy in tests). */
    exit: (code: number) => void;
    /** Where the reason for a non-zero exit is reported. */
    log: (message: string) => void;
};
/**
 * Exit-code policy for a standalone MCP server, called from its signal
 * handler.
 *
 * A clean stop exits 0. A reported timeout exits 1 *immediately*: work is
 * still running, the process is the only thing that can end it, and the
 * abandoned cleanup cannot finish before that exit. Any other teardown failure
 * also exits 1, because the store may not have closed. Embedded hosts do not
 * use this — they own their own lifetime.
 */
export declare function terminateMcpServer(stop: () => Promise<void>, termination: McpTermination): Promise<void>;
/**
 * Counts running request handlers so shutdown can wait for them to settle
 * before tearing down their llm/store dependencies, and refuses handlers the
 * transport dispatches after admission closed. The SDK aborts in-flight
 * request controllers on close, but qmd's handlers finish their current
 * store/llm work rather than observing the signal mid-operation.
 *
 * The gate owns the lifecycle state, so the admission barrier no longer
 * depends on the caller remembering to close the transport first: a handler
 * that arrives after `beginDrain()` throws instead of touching a store that
 * shutdown is about to close (the client that sent it is gone in that window).
 */
export type InflightGate = McpLifecycle & {
    /** Wraps a handler so the gate admits and counts it while it runs. */
    track<T extends (...args: never[]) => unknown>(fn: T): T;
};
export declare function createInflightGate(lifecycle?: McpLifecycle): InflightGate;
/** Minimal stdin surface consumed by registerStdioEofShutdown, injectable for tests. */
export type StdioShutdownStdin = {
    once(event: "end" | "close", listener: () => void): unknown;
    off(event: "end" | "close", listener: () => void): unknown;
    readableEnded?: boolean;
    destroyed?: boolean;
};
export type StdioShutdownOptions = {
    /** Closes the MCP server and its transport. */
    closeServer: () => Promise<void>;
    /** Closes the SQLite store (owns disposing the per-store llama.cpp instance). */
    closeStore: () => void | Promise<void>;
    /**
     * Optional extra llama.cpp teardown, run before closeStore. The MCP store
     * disposes its own per-store LlamaCpp inside closeStore, so this is left
     * unset there; it exists for callers that own a separate instance. If
     * omitted, the step is skipped (do NOT default it to the global
     * disposeDefaultLlamaCpp — that would tear down an unrelated instance in an
     * embedded process).
     */
    disposeLlm?: () => Promise<void>;
    /**
     * Handler gate shared with the transport (see InflightGate). When given,
     * shutdown closes its admission — `serving -> draining` — before
     * closeServer(), so a request the closing transport still dispatches is
     * refused instead of touching a store that teardown is about to close, and
     * marks teardown complete (`draining -> stopped`) after closeStore().
     * Also supplies waitForIdle when the caller does not inject one.
     */
    lifecycle?: McpLifecycle;
    /**
     * Waits for in-flight handlers to settle (see InflightGate.waitForIdle).
     * Call it without a timeout for the unbounded post-timeout wait.
     */
    waitForIdle?: (timeoutMs?: number) => Promise<boolean>;
    /** Deadline for the whole teardown. Defaults to {@link MCP_SHUTDOWN_TIMEOUT_MS}. */
    idleTimeoutMs?: number;
    /** Defaults to process.stdin. */
    stdin?: StdioShutdownStdin;
    /**
     * Records the outcome. Defaults to a no-op: an embedded host owns its exit
     * status, so only the standalone stdio entry passes a setter (writing
     * `process.exitCode`) and, with it, `exitOnTimeout`.
     */
    setExitCode?: (code: number) => void;
    /** Defaults to reading process.exitCode. */
    getExitCode?: () => number | undefined;
    /** Defaults to process.stderr. */
    stderr?: {
        write(chunk: string): unknown;
        on?(event: "error", listener: (err: unknown) => void): unknown;
    };
    /**
     * Called after the outcome was recorded as 1 because the deadline expired
     * with work still running, right before the shutdown promise rejects. Only
     * the standalone stdio entry passes `process.exit(1)`: after EOF nothing can
     * consume the abandoned work, so an orphaned process would only leak (the
     * very failure #751 is about). Embedded callers leave it unset, catch the
     * rejection, and keep their own lifetime.
     */
    exitOnTimeout?: (error: McpShutdownTimeoutError) => void;
};
/**
 * The idempotent EOF shutdown plus the promise that only settles once every
 * teardown step actually finished — including cleanup abandoned after a
 * reported timeout. `closed` never rejects; the callable rejects with a
 * {@link McpShutdownTimeoutError} when the deadline expired.
 */
export type StdioShutdown = (() => Promise<void>) & {
    closed: Promise<void>;
};
/**
 * Shut the stdio MCP server down when stdin reaches EOF (#751).
 *
 * The SDK's StdioServerTransport subscribes to stdin "data"/"error" only and
 * never notices "end"/"close". When the parent MCP client dies, nothing tears
 * the process down: the warm llama.cpp model's native handles keep the event
 * loop alive, so the server reparents to PID 1, leaks RAM, and keeps the
 * SQLite index open. stdin EOF means the client is gone, so this treats it as
 * a disconnect: no new requests are accepted and nobody is left to read a
 * response — but handlers that are already running get the same bounded
 * window the HTTP transport grants (waitForIdle) before their llm/store
 * dependencies are torn down.
 *
 * Teardown order matters, and it is the lifecycle's transitions.
 * `serving -> draining` closes handler admission *and* the transport (either
 * alone is not enough: the transport can still hand us a request it read just
 * before closing), then in-flight handlers get their bounded window, then the
 * store is closed last — which disposes the store's own llama.cpp instance and
 * then the database, so the dispose path cannot hit an already-closed DB —
 * then `draining -> stopped`. (disposeLlm is an optional extra step for
 * callers that own a separate instance; the MCP store does not.) Failures are
 * logged best-effort (the parent's death may have closed stderr too) and do
 * not stop the remaining steps.
 *
 * One deadline (default {@link MCP_SHUTDOWN_TIMEOUT_MS}) bounds the whole
 * chain: the transport close, the drain, the llama disposal and the store
 * close. When it expires, the shutdown promise rejects with a
 * {@link McpShutdownTimeoutError} and the remaining cleanup continues in the
 * background — unbounded when it has to be, because the store MUST NOT close
 * underneath an operation that is still running, and the lifecycle is only
 * marked stopped once it really closed. `closed` is what reports that finish.
 *
 * This function never calls process.exit itself, and it only writes
 * `process.exitCode` through a caller-supplied `setExitCode`. The standalone
 * entry supplies both (setter plus `exitOnTimeout`), because a process that
 * outlived its deadline with work remaining can only be ended by itself;
 * writing the code rather than calling process.exit() lets `beforeExit` fire
 * and node-llama-cpp's auto-dispose run before libc's static destructors —
 * process.exit() during native-addon unload has caused exit-time crashes
 * before (#59, #129; same rationale as finishSuccessfulCliCommand in the CLI).
 *
 * Returns the idempotent shutdown function: every invocation (manual, "end",
 * "close", or already-ended stdin) shares one promise. On a reported timeout
 * that promise REJECTS with {@link McpShutdownTimeoutError} while `closed`
 * keeps tracking the background cleanup; every other outcome resolves.
 * Nothing here exits the process and, unless `setExitCode` is supplied, nothing
 * touches `process.exitCode`: the standalone entry opts into both.
 */
export declare function registerStdioEofShutdown(options: StdioShutdownOptions): StdioShutdown;
/** Options for the stdio entry, plus who owns the process lifetime. */
export type McpStdioServerOptions = McpStartupOptions & {
    /**
     * Standalone CLI/server-main only. The EOF shutdown then records its outcome
     * in `process.exitCode` and forces `process.exit(1)` when the deadline
     * expires with work still running: after EOF nothing can consume that work,
     * and a process outliving its deadline is exactly the #751 leak.
     *
     * Omitted (embedded), a reported timeout rejects the returned `shutdown`
     * promise and cleanup continues in the background, while neither
     * `process.exitCode` nor the process itself is touched.
     */
    standalone?: boolean;
};
/**
 * What `startMcpServer` hands back so an embedder can follow the lifecycle.
 */
export type StdioServerHandle = {
    /**
     * The idempotent stdin-EOF shutdown. Rejects with a
     * {@link McpShutdownTimeoutError} when the deadline expired; resolves for
     * every other outcome.
     */
    shutdown: StdioShutdown;
    /**
     * Resolves once every teardown step actually finished, including cleanup
     * abandoned after a reported timeout. Never rejects.
     */
    closed: Promise<void>;
};
/**
 * Serve MCP over stdio until stdin reaches EOF.
 *
 * Programmatic startup never terminates the caller's process: pass
 * `standalone: true` only from a process-serving entry (the CLI, this module's
 * main block), which is the sole owner of `process.exit`.
 */
export declare function startMcpServer(options?: McpStdioServerOptions): Promise<StdioServerHandle>;
export type HttpServerHandle = {
    httpServer: Server;
    port: number;
    /**
     * Stops the server. Every caller shares one teardown promise. Resolves when
     * the listener and the store are closed; rejects with a
     * {@link McpShutdownTimeoutError} at the deadline (default
     * {@link MCP_SHUTDOWN_TIMEOUT_MS}), in which case the remaining cleanup
     * continues in the background.
     *
     * It never calls process.exit: an embedded host decides what a reported
     * timeout means for its own lifetime.
     */
    stop: () => Promise<void>;
    /**
     * Resolves once every teardown step actually finished — including cleanup
     * abandoned after a reported timeout — so it never claims "stopped" before
     * the store is really closed. Never rejects. A hung store keeps it pending.
     */
    closed: Promise<void>;
};
/** Options for the HTTP transport: the startup options plus listener knobs. */
export type McpHttpServerOptions = McpStartupOptions & {
    quiet?: boolean;
    host?: string;
    allowedOrigins?: string[];
    allowedHosts?: string[];
    /**
     * How long the whole stop() may take: the drain of already-admitted
     * requests, the MCP transport close, the listener close and the store close
     * all share this one deadline. Defaults to {@link MCP_SHUTDOWN_TIMEOUT_MS}.
     *
     * Until the deadline, admitted work is allowed to finish. At the deadline
     * the admitted requests are aborted (their responses can no longer be
     * delivered), their sockets are severed, and stop() rejects with a
     * {@link McpShutdownTimeoutError}. The store is NOT closed underneath the
     * abandoned work: the remaining cleanup continues in the background, in the
     * same safe order, and the lifecycle only reaches `stopped` once closeStore()
     * actually resolved. A standalone entry exits non-zero at that point; an
     * embedded caller keeps running and can await `handle.closed`.
     */
    shutdownDrainTimeoutMs?: number;
    /**
     * The lifecycle every request is admitted through. Defaults to a fresh one.
     * Pass a shared lifecycle to drain the listener from an owner that knows
     * more than the HTTP transport does: after `beginDrain()` the listener
     * answers 503 instead of touching the store, and stop() still tears down
     * (the transition is idempotent).
     */
    lifecycle?: McpLifecycle;
};
/**
 * Start MCP server over Streamable HTTP (JSON responses by default).
 * Binds to `options.host` (default "localhost", overridable via the QMD_HOST
 * env var) — set "0.0.0.0" to accept connections from other hosts, e.g. a
 * container liveness probe. Returns a handle for shutdown and port discovery.
 *
 * HTTP is sessionless (MCP 2026-07-28): there is no `Mcp-Session-Id`, no
 * initialize handshake, and no idle-session TTL. 2025-era clients are still
 * served per-request via the SDK's stateless legacy fallback (initialize
 * works as a standalone call; subsequent 2025 methods need a modern envelope
 * or a stdio connection). The previous session reaper (#816) is gone because
 * there are no sessions to reap.
 *
 * Every request is admitted through one lifecycle (see createMcpLifecycle),
 * so `stop()` drains what it admitted before closing the shared store, the
 * MCP transport, or a socket underneath one.
 *
 * `stop()` is bounded end to end. It closes admission and the listener at
 * once, lets the requests it already admitted finish until the deadline
 * (default {@link MCP_SHUTDOWN_TIMEOUT_MS}, overridable with
 * `shutdownDrainTimeoutMs`), and then closes the MCP transport, finishes the
 * listener and closes the store — all inside that one deadline. A request that
 * never completes (a client that stalls mid-body, a long-lived
 * `subscriptions/listen` stream, a hung LLM call) is aborted at the deadline:
 * `stop()` rejects with a {@link McpShutdownTimeoutError} while the abandoned
 * cleanup continues in the background, so the store is never closed under live
 * work and `stop()` never hangs the caller.
 *
 * The module installs no process signal handlers and never exits the process:
 * a standalone entry (`qmd mcp --http`) owns SIGTERM/SIGINT handling and maps a
 * reported timeout to a non-zero exit, while an embedded host decides for
 * itself and can await `handle.closed`.
 */
export declare function startMcpHttpServer(port: number, options?: McpHttpServerOptions): Promise<HttpServerHandle>;
