/**
 * QMD MCP Server - Model Context Protocol server for QMD
 *
 * Exposes QMD search and document retrieval as MCP tools and resources.
 * Documents are accessible via qmd:// URIs.
 *
 * Speaks MCP spec 2026-07-28 (stateless, no initialize handshake) and dual-speaks
 * 2025-era clients via the official SDK entries (`serveStdio` / `createMcpHandler`).
 */
export type McpStartupOptions = {
    dbPath?: string;
};
/**
 * Counts running request handlers so shutdown can wait for them to settle
 * before tearing down their llm/store dependencies. The SDK aborts in-flight
 * request controllers on close, but qmd's handlers finish their current
 * store/llm work rather than observing the signal mid-operation.
 */
export type InflightGate = {
    /** Wraps a handler so the gate counts it while it runs. */
    track<T extends (...args: never[]) => unknown>(fn: T): T;
    /** Resolves once no tracked handler runs, or after timeoutMs. Returns whether idle was reached. */
    waitForIdle(timeoutMs: number): Promise<boolean>;
};
export declare function createInflightGate(): InflightGate;
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
    /** Waits for in-flight handlers to settle (see InflightGate.waitForIdle). */
    waitForIdle?: (timeoutMs: number) => Promise<boolean>;
    /** Deadline for the in-flight wait. Defaults to 5000 ms. */
    idleTimeoutMs?: number;
    /** Defaults to process.stdin. */
    stdin?: StdioShutdownStdin;
    /** Defaults to assigning process.exitCode. */
    setExitCode?: (code: number) => void;
    /** Defaults to reading process.exitCode. */
    getExitCode?: () => number | undefined;
    /** Defaults to process.stderr. */
    stderr?: {
        write(chunk: string): unknown;
        on?(event: "error", listener: (err: unknown) => void): unknown;
    };
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
 * response — but handlers that are already running get a bounded window to
 * settle (waitForIdle) before their llm/store dependencies are torn down.
 *
 * Teardown order matters. Close the transport first so no further requests
 * are dispatched, wait for in-flight handlers, then close the store last —
 * which disposes the store's own llama.cpp instance and then the database, so
 * the dispose path cannot hit an already-closed DB. (disposeLlm is an optional
 * extra step for callers that own a separate instance; the MCP store does
 * not.) Failures are logged best-effort (the parent's death may have closed
 * stderr too) and do not stop the remaining steps. The function sets process.exitCode
 * instead of calling process.exit() so `beforeExit` still fires and
 * node-llama-cpp's auto-dispose runs before libc's static destructors —
 * process.exit() during native-addon unload has caused exit-time crashes
 * before (#59, #129; same rationale as finishSuccessfulCliCommand in the CLI).
 *
 * Returns the idempotent shutdown function: every invocation (manual, "end",
 * "close", or already-ended stdin) shares one promise, and the promise never
 * rejects.
 */
export declare function registerStdioEofShutdown(options: StdioShutdownOptions): () => Promise<void>;
export declare function startMcpServer(options?: McpStartupOptions): Promise<void>;
export type HttpServerHandle = {
    httpServer: import("http").Server;
    port: number;
    stop: () => Promise<void>;
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
 */
export declare function startMcpHttpServer(port: number, options?: ({
    quiet?: boolean;
    host?: string;
    allowedOrigins?: string[];
    allowedHosts?: string[];
} & McpStartupOptions)): Promise<HttpServerHandle>;
