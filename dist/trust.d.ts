/**
 * trust.ts — approval gate for project-local `.qmd` config.
 *
 * A project-local `.qmd/index.yml` arrives with a `git clone`, and
 * `findLocalConfigPath` adopts it automatically for any command run inside the
 * tree. Three fields in that file can reach outside the project:
 *
 * - `update:` — a shell command run by `qmd update` (#886)
 * - `collections.*.path` — any directory the process can read (#889)
 * - `models.embed` / `models.rerank` / `models.generate` — any `hf:` repo or
 *   local GGUF path (#889)
 *
 * Global `~/.config/qmd` is never gated. In-project collection paths and the
 * built-in default model URIs are also allowed without approval: those are
 * what a local config is for. Approvals are per config file and per gated
 * set, recorded in `<config dir>/trusted.json`. Editing a hook, pointing a
 * collection outside the project, or changing a custom model URI changes the
 * digest and re-arms the gate.
 *
 * Trust lifecycle. The persisted record is the whole state; nothing else is
 * stored per config path:
 *
 *   unapproved  no record for the resolved path               → gate prompts/skips
 *   approved    record whose digest equals the current digest → gate runs
 *   stale       record for a digest that is no longer current → gate re-arms
 *
 * Transitions: `recordTrust(digest)` moves unapproved/stale → approved (and
 * refreshes an approval of the same digest); `revokeTrust` moves
 * approved/stale → unapproved; editing a hook, an out-of-project path, or a
 * custom model URI moves approved → stale without any write, because the
 * digest in the record no longer matches the config. A missing, corrupt, or
 * malformed `trusted.json` is unapproved for every path — the store fails
 * closed and is never read as "everything is trusted".
 *
 * Several processes record approvals for the same file (`qmd trust` in two
 * terminals, or an interactive approval during `qmd update` while another
 * project is approved), so every write is a locked read-modify-write
 * published with an atomic rename. A concurrent writer can therefore neither
 * drop an approval nor revive a revoked one, and a writer killed mid-write
 * leaves the previous complete store behind instead of a truncated file.
 */
import { type CommandProcessorSpec } from "./processors.js";
import { type RemoteEmbedOptions } from "./remote-embed.js";
import { type JevRerankOptions } from "./jev.js";
/** A collection's pre-update hook, as it will be executed. */
export type UpdateHook = {
    collection: string;
    command: string;
};
export type CollectionPath = {
    collection: string;
    path: string;
};
export type ModelSlot = "embed" | "rerank" | "generate";
export type ModelsSnapshot = {
    embed?: string;
    embedOptions?: RemoteEmbedOptions;
    rerank?: string;
    rerankOptions?: JevRerankOptions;
    generate?: string;
};
export type SensitiveSnapshot = {
    processors?: Array<{
        collection: string;
        spec: CommandProcessorSpec;
    }>;
    hooks: UpdateHook[];
    paths: CollectionPath[];
    models: ModelsSnapshot;
};
export type GatedItems = {
    processors?: Array<{
        collection: string;
        spec: Readonly<CommandProcessorSpec>;
    }>;
    hooks: UpdateHook[];
    paths: CollectionPath[];
    models: Array<{
        slot: ModelSlot;
        uri: string;
    }>;
    embedOptions?: Readonly<RemoteEmbedOptions>;
    rerankOptions?: Readonly<JevRerankOptions>;
};
export type BuiltinModels = Required<Pick<ModelsSnapshot, ModelSlot>>;
export type TrustRecord = {
    /** Digest of the gated set that was approved. */
    hooks: string;
    /** ISO timestamp of the approval. */
    trustedAt: string;
};
export type TrustStore = Record<string, TrustRecord>;
/** Path of the trust database. Lives beside the global config. */
export declare function getTrustFilePath(): string;
/**
 * Sidecar database whose open write transaction serialises trust-store writes,
 * like `.qmd-embed.lock.sqlite` does for `qmd embed`. Kept beside the store so
 * it shares its filesystem; leaving it on disk is deliberate — unlinking a
 * lock by pathname is what makes pidfile locks racy.
 */
export declare function getTrustLockPath(): string;
/**
 * Whether a config path is project-local — i.e. discovered by walking up from
 * the working directory rather than written by the user in their config dir.
 *
 * `findLocalConfigPath` and `qmd init` both use `.qmd/index.y{a,}ml`, and the
 * global config lives in a directory named `qmd`, so the parent directory name
 * separates the two cases without extra bookkeeping.
 */
export declare function isLocalConfigPath(configPath: string): boolean;
/** Directory that contains the `.qmd` folder for a project-local config. */
export declare function projectRootFromConfig(configPath: string): string;
/** Expand a leading `~` to the user home directory. */
export declare function expandUserPath(raw: string): string;
/**
 * Resolve a collection `path` from a project-local config: `~` expansion,
 * then relative paths against the project root (the directory that contains
 * `.qmd`), not against the process cwd.
 */
export declare function resolveConfigCollectionPath(rawPath: string, configPath: string): string;
/**
 * True if `rawPath` from a project-local config stays inside that project
 * (the directory containing `.qmd`), after `~` expansion, relative
 * resolution, and symlink realpath.
 */
export declare function isCollectionPathInsideProject(configPath: string, rawPath: string): boolean;
export declare function gatedModels(models: ModelsSnapshot, builtins: BuiltinModels): Array<{
    slot: ModelSlot;
    uri: string;
}>;
export declare function gatedItems(configPath: string, snapshot: SensitiveSnapshot, builtins: BuiltinModels): GatedItems;
export declare function hasGatedItems(gated: GatedItems): boolean;
/**
 * Stable digest over a hook set. Order-independent so that reordering
 * collections in the YAML does not invalidate an approval, while any change to
 * a command — or a new collection gaining one — does.
 */
export declare function hookDigest(hooks: UpdateHook[]): string;
/**
 * Digest of the gated surface of a project-local config: hooks, resolved
 * collection paths, and non-default model URIs. Missing model keys and the
 * built-in default URIs are equivalent so that `qmd init` filling defaults
 * into the YAML does not invalidate an approval.
 */
export declare function sensitiveDigest(snapshot: SensitiveSnapshot, configPath: string, builtins: BuiltinModels): string;
/**
 * Read the store. Anything unreadable — a missing file, invalid JSON, a
 * top-level value that is not an object, or an entry that is not a trust
 * record — reads as "not approved", never as blanket trust. Entries are
 * copied out of the parsed document, so a caller never aliases parsed JSON.
 */
export declare function loadTrustStore(): TrustStore;
export declare function isTrusted(configPath: string, digest: string): boolean;
/** Approve the gated set identified by `digest` for a config path. */
export declare function recordTrust(configPath: string, digest: string): void;
/** Drop the record for a config path. Returns false if there was none. */
export declare function revokeTrust(configPath: string): boolean;
export declare function listTrusted(): Array<{
    path: string;
} & TrustRecord>;
export type HookGateDecision = {
    action: "run";
    digest: string;
} | {
    action: "prompt";
    digest: string;
} | {
    action: "skip";
    digest: string;
};
export type LocalConfigGateDecision = HookGateDecision;
/** True when the process has opted in to trusting project-local config unattended. */
export declare function isLocalConfigTrustOptedIn(env?: NodeJS.ProcessEnv): boolean;
/**
 * Decide what to do with a config's `update:` hooks.
 *
 * Non-interactive callers — agents, CI, the MCP server — get `skip` rather than
 * a hard failure: indexing is what they asked for, and failing the whole
 * command would only push people toward a blanket opt-out.
 */
export declare function decideHookGate(options: {
    configPath: string;
    hooks: UpdateHook[];
    isInteractive: boolean;
    env?: NodeJS.ProcessEnv;
    trustedCheck?: (configPath: string, digest: string) => boolean;
}): HookGateDecision;
/**
 * Decide whether a project-local config may use its gated fields (hooks,
 * out-of-project collection paths, non-default model URIs).
 *
 * In-project paths and built-in default models do not need a decision.
 * Non-interactive callers get `skip`: in-project indexing still proceeds,
 * hooks/outside paths/custom models do not.
 */
export declare function decideLocalConfigGate(options: {
    configPath: string;
    snapshot: SensitiveSnapshot;
    builtins: BuiltinModels;
    isInteractive: boolean;
    env?: NodeJS.ProcessEnv;
    trustedCheck?: (configPath: string, digest: string) => boolean;
}): LocalConfigGateDecision;
