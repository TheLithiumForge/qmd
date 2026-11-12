/**
 * origin-guard.ts — DNS-rebinding protection for the HTTP MCP transport.
 *
 * Binding to localhost keeps *remote* clients out, but it does not keep a web
 * page out. A page served from `attacker.example` can re-point that hostname at
 * `127.0.0.1` after load (DNS rebinding); the browser then treats
 * `http://attacker.example:8181` as same-origin with the page and hands the
 * response body to attacker JavaScript. The only server-side signal that
 * distinguishes such a request from a legitimate local client is the `Origin`
 * and `Host` headers, so the MCP spec requires local HTTP servers to validate
 * them.
 *
 * The predicates here are pure so they can be unit-tested without a socket;
 * `startMcpHttpServer` applies them to every request before routing.
 */
/**
 * Hostnames that resolve to this machine's loopback interface.
 *
 * `0.0.0.0` is deliberately excluded: browsers happily route it to loopback on
 * Linux and macOS, which makes it a rebinding-free path to local servers, so an
 * `Origin: http://0.0.0.0:8181` is treated as untrusted like any other.
 */
export declare function isLoopbackHostname(hostname: string): boolean;
export type OriginGuard = {
    /** All checks disabled (`QMD_ALLOWED_ORIGINS=*`). */
    disabled: boolean;
    /** Extra origins accepted beyond the loopback defaults, normalized. */
    allowedOrigins: string[];
    /** Extra `Host` values accepted beyond the loopback defaults, lowercased. */
    allowedHosts: string[];
    /** Whether the `Host` header is checked at all — see `resolveOriginGuard`. */
    enforceHost: boolean;
};
/**
 * Build the guard for a server bound to `host`.
 *
 * `Host` validation is enforced whenever the bind address names a concrete
 * interface, since the legitimate `Host` header is then known (loopback, or the
 * bind address itself). For a wildcard bind — `--host 0.0.0.0`, e.g. Docker —
 * any of the container's names may legitimately appear, so the check is only
 * enforced when the operator supplies an explicit allowlist. `Origin`
 * validation always applies; browsers are the threat, and they always send it.
 */
export declare function resolveOriginGuard(options: {
    host: string;
    allowedOrigins?: string[];
    allowedHosts?: string[];
    env?: NodeJS.ProcessEnv;
}): OriginGuard;
export type GuardVerdict = {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/**
 * Validate a request's `Origin` and `Host` headers against the guard.
 *
 * A missing `Origin` is allowed: non-browser clients (curl, the MCP SDK's HTTP
 * client, editors) omit it, and browsers cannot. The header is the signal that
 * a request came from page JavaScript, so its *absence* is not suspicious while
 * a foreign *value* is conclusive.
 */
export declare function checkRequestOrigin(headers: {
    origin?: string | undefined;
    host?: string | undefined;
}, guard: OriginGuard): GuardVerdict;
