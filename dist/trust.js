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
 */
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { getConfigDir } from "./collections.js";
import { qmdHomedir } from "./paths.js";
/** Path of the trust database. Lives beside the global config. */
export function getTrustFilePath() {
    return join(getConfigDir(), "trusted.json");
}
/**
 * Whether a config path is project-local — i.e. discovered by walking up from
 * the working directory rather than written by the user in their config dir.
 *
 * `findLocalConfigPath` and `qmd init` both use `.qmd/index.y{a,}ml`, and the
 * global config lives in a directory named `qmd`, so the parent directory name
 * separates the two cases without extra bookkeeping.
 */
export function isLocalConfigPath(configPath) {
    if (!configPath || configPath === "<inline>")
        return false;
    return basename(dirname(resolve(configPath))) === ".qmd";
}
/** Directory that contains the `.qmd` folder for a project-local config. */
export function projectRootFromConfig(configPath) {
    return dirname(dirname(resolve(configPath)));
}
/** Expand a leading `~` to the user home directory. */
export function expandUserPath(raw) {
    if (raw === "~")
        return qmdHomedir();
    if (raw.startsWith("~/") || raw.startsWith("~\\")) {
        return join(qmdHomedir(), raw.slice(2));
    }
    return raw;
}
/**
 * Resolve a collection `path` from a project-local config: `~` expansion,
 * then relative paths against the project root (the directory that contains
 * `.qmd`), not against the process cwd.
 */
export function resolveConfigCollectionPath(rawPath, configPath) {
    const expanded = expandUserPath(String(rawPath ?? "").trim());
    if (!expanded)
        return projectRootFromConfig(configPath);
    if (isAbsolute(expanded))
        return resolve(expanded);
    return resolve(projectRootFromConfig(configPath), expanded);
}
function realOrResolve(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return resolve(path);
    }
}
/**
 * True if `rawPath` from a project-local config stays inside that project
 * (the directory containing `.qmd`), after `~` expansion, relative
 * resolution, and symlink realpath.
 */
export function isCollectionPathInsideProject(configPath, rawPath) {
    const root = realOrResolve(projectRootFromConfig(configPath));
    const target = realOrResolve(resolveConfigCollectionPath(rawPath, configPath));
    const rel = relative(root, target);
    if (rel === "")
        return true;
    if (isAbsolute(rel))
        return false;
    return !rel.split(/[/\\]/).includes("..");
}
export function gatedModels(models, builtins) {
    const out = [];
    for (const slot of ["embed", "rerank", "generate"]) {
        const uri = models[slot];
        if (!uri)
            continue;
        if (uri === builtins[slot])
            continue;
        out.push({ slot, uri });
    }
    return out;
}
export function gatedItems(configPath, snapshot, builtins) {
    return {
        hooks: snapshot.hooks,
        paths: snapshot.paths.filter(p => !isCollectionPathInsideProject(configPath, p.path)),
        models: gatedModels(snapshot.models, builtins),
    };
}
export function hasGatedItems(gated) {
    return gated.hooks.length > 0 || gated.paths.length > 0 || gated.models.length > 0;
}
function byFirst(a, b) {
    const left = a[0] ?? "";
    const right = b[0] ?? "";
    return left < right ? -1 : left > right ? 1 : 0;
}
/**
 * Stable digest over a hook set. Order-independent so that reordering
 * collections in the YAML does not invalidate an approval, while any change to
 * a command — or a new collection gaining one — does.
 */
export function hookDigest(hooks) {
    const canonical = JSON.stringify(hooks
        .map(h => [h.collection, h.command])
        .sort(byFirst));
    return createHash("sha256").update(canonical).digest("hex");
}
/**
 * Digest of the gated surface of a project-local config: hooks, resolved
 * collection paths, and non-default model URIs. Missing model keys and the
 * built-in default URIs are equivalent so that `qmd init` filling defaults
 * into the YAML does not invalidate an approval.
 */
export function sensitiveDigest(snapshot, configPath, builtins) {
    const gated = gatedItems(configPath, snapshot, builtins);
    const canonical = JSON.stringify({
        hooks: gated.hooks.map(h => [h.collection, h.command]).sort(byFirst),
        paths: gated.paths
            .map(p => [p.collection, resolveConfigCollectionPath(p.path, configPath)])
            .sort(byFirst),
        models: gated.models
            .map(m => [m.slot, m.uri])
            .sort(byFirst),
    });
    return createHash("sha256").update(canonical).digest("hex");
}
export function loadTrustStore() {
    const path = getTrustFilePath();
    if (!existsSync(path))
        return {};
    try {
        const parsed = JSON.parse(readFileSync(path, "utf-8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return {};
        return parsed;
    }
    catch {
        // A corrupt trust file must not be treated as "everything is trusted".
        return {};
    }
}
function saveTrustStore(store) {
    const path = getTrustFilePath();
    const dir = dirname(path);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
}
/** Trust records are keyed on the resolved config path. */
function trustKey(configPath) {
    return resolve(configPath);
}
export function isTrusted(configPath, digest) {
    const record = loadTrustStore()[trustKey(configPath)];
    return record?.hooks === digest;
}
export function recordTrust(configPath, digest) {
    const store = loadTrustStore();
    store[trustKey(configPath)] = { hooks: digest, trustedAt: new Date().toISOString() };
    saveTrustStore(store);
}
/** Drop the record for a config path. Returns false if there was none. */
export function revokeTrust(configPath) {
    const store = loadTrustStore();
    const key = trustKey(configPath);
    if (!(key in store))
        return false;
    delete store[key];
    saveTrustStore(store);
    return true;
}
export function listTrusted() {
    return Object.entries(loadTrustStore()).map(([path, record]) => ({ path, ...record }));
}
function isTruthyEnv(value) {
    if (!value)
        return false;
    return !["0", "false", "off", "no", "none"].includes(value.trim().toLowerCase());
}
/** True when the process has opted in to trusting project-local config unattended. */
export function isLocalConfigTrustOptedIn(env = process.env) {
    return isTruthyEnv(env.QMD_TRUST_LOCAL_CONFIG) || isTruthyEnv(env.QMD_TRUST_UPDATE_HOOKS);
}
/**
 * Decide what to do with a config's `update:` hooks.
 *
 * Non-interactive callers — agents, CI, the MCP server — get `skip` rather than
 * a hard failure: indexing is what they asked for, and failing the whole
 * command would only push people toward a blanket opt-out.
 */
export function decideHookGate(options) {
    const env = options.env ?? process.env;
    const digest = hookDigest(options.hooks);
    if (options.hooks.length === 0)
        return { action: "run", digest };
    if (isTruthyEnv(env.QMD_TRUST_UPDATE_HOOKS) || isTruthyEnv(env.QMD_TRUST_LOCAL_CONFIG)) {
        return { action: "run", digest };
    }
    if (!isLocalConfigPath(options.configPath))
        return { action: "run", digest };
    const trusted = options.trustedCheck ?? isTrusted;
    if (trusted(options.configPath, digest))
        return { action: "run", digest };
    return { action: options.isInteractive ? "prompt" : "skip", digest };
}
/**
 * Decide whether a project-local config may use its gated fields (hooks,
 * out-of-project collection paths, non-default model URIs).
 *
 * In-project paths and built-in default models do not need a decision.
 * Non-interactive callers get `skip`: in-project indexing still proceeds,
 * hooks/outside paths/custom models do not.
 */
export function decideLocalConfigGate(options) {
    const env = options.env ?? process.env;
    const digest = sensitiveDigest(options.snapshot, options.configPath, options.builtins);
    const gated = gatedItems(options.configPath, options.snapshot, options.builtins);
    if (!hasGatedItems(gated))
        return { action: "run", digest };
    if (isLocalConfigTrustOptedIn(env))
        return { action: "run", digest };
    if (!isLocalConfigPath(options.configPath))
        return { action: "run", digest };
    const trusted = options.trustedCheck ?? isTrusted;
    if (trusted(options.configPath, digest))
        return { action: "run", digest };
    return { action: options.isInteractive ? "prompt" : "skip", digest };
}
