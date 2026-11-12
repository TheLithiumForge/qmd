/**
 * MCP daemon pidfile identity helpers.
 *
 * Pidfiles alone are unsafe after PID reuse (e.g. post-reboot). Callers must
 * confirm a recorded PID still belongs to a qmd process before signalling it
 * or treating it as "already running".
 */
/**
 * Pid/log filenames for the MCP HTTP daemon.
 * The default index keeps `mcp.pid` / `mcp.log` for compatibility; named
 * indexes are scoped so a named daemon can run alongside the default (#772).
 */
export declare function mcpDaemonStateFiles(indexName?: string): {
    pidFile: string;
    logFile: string;
};
/** True if a process command line looks like a qmd CLI invocation. */
export declare function looksLikeQmdMcpCommand(cmdline: string): boolean;
/** Read process cmdline (Linux /proc preferred; ps fallback for macOS). */
export declare function readProcessCmdline(pid: number): string | null;
/**
 * Returns true only if `pid` is alive AND its command line looks like qmd.
 * If cmdline cannot be read or does not match, returns false (treat as stale).
 */
export declare function isQmdMcpPid(pid: number): boolean;
