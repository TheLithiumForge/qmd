/**
 * Collections configuration management
 *
 * This module manages the YAML-based collection configuration at ~/.config/qmd/index.yml.
 * Collections define which directories to index and their associated contexts.
 *
 * Several processes share that file (CLI commands, the MCP daemon, SDK stores),
 * so every mutation is a read-modify-write under an exclusive per-config lock
 * and every publish is an atomic rename: no update is lost to a concurrent
 * writer and no reader ever observes a partially written YAML document.
 */
import { closeSync, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeSync, } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { randomBytes } from "crypto";
import { qmdHomedir } from "./paths.js";
import { isBusyError, openDatabase } from "./db.js";
import YAML from "yaml";
// ============================================================================
// Configuration paths
// ============================================================================
// Current index name (default: "index") used by the default (CLI) scope.
let currentIndexName = "index";
/**
 * Set the current index name for config file lookup
 * Config file will be ~/.config/qmd/{indexName}.yml
 */
export function setConfigIndexName(name) {
    // Resolve relative paths to absolute paths and sanitize for use as filename.
    // Windows absolute paths (C:\..., \\server\share) are already absolute --
    // skip resolve() for those (POSIX path.resolve doesn't recognize a drive
    // letter as absolute and would wrongly prefix it with cwd) and sanitize
    // `:` and `\` alongside `/` so the derived filename is valid on Windows.
    const isWindowsAbsolute = /^[a-zA-Z]:[\\/]/.test(name) || /^\\/.test(name);
    if (isWindowsAbsolute || /[\\/]/.test(name)) {
        const absolutePath = isWindowsAbsolute ? name : resolve(process.cwd(), name);
        // Replace path separators with underscores to create a valid filename
        currentIndexName = absolutePath.replace(/[:\\/]+/g, '_').replace(/^_+/, '');
    }
    else {
        currentIndexName = name;
    }
}
export function getConfigDir() {
    // Allow override via QMD_CONFIG_DIR for testing
    if (process.env.QMD_CONFIG_DIR) {
        return process.env.QMD_CONFIG_DIR;
    }
    // Respect XDG Base Directory specification (consistent with store.ts)
    if (process.env.XDG_CONFIG_HOME) {
        return join(process.env.XDG_CONFIG_HOME, "qmd");
    }
    return join(qmdHomedir(), ".config", "qmd");
}
function getConfigFilePath() {
    return join(getConfigDir(), `${currentIndexName}.yml`);
}
/**
 * Find a project-local QMD config by walking upward from startDir.
 * The local config lives at .qmd/index.yaml or .qmd/index.yml and,
 * when used by the CLI, keeps both config and index DB writes inside
 * the project instead of the global ~/.config / ~/.cache locations.
 */
export function findLocalConfigPath(startDir = process.cwd()) {
    let dir = resolve(startDir);
    while (true) {
        const qmdDir = join(dir, ".qmd");
        const yamlPath = join(qmdDir, "index.yaml");
        if (existsSync(yamlPath))
            return yamlPath;
        const ymlPath = join(qmdDir, "index.yml");
        if (existsSync(ymlPath))
            return ymlPath;
        const parent = dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
}
/** Return the local SQLite index path paired with a local .qmd/index.yaml file. */
export function getLocalDbPath(configPath) {
    return join(dirname(configPath), "index.sqlite");
}
/** Thrown when a closed configuration scope is read or written. */
export class ConfigScopeClosedError extends Error {
    constructor() {
        super("Collection configuration scope is closed; create a new scope or store");
        this.name = "ConfigScopeClosedError";
    }
}
function sourceStateFrom(options) {
    if (!options) {
        return { kind: "file", path: undefined };
    }
    if (options.config) {
        // Ensure collections object exists on the caller's object: inline mode
        // mutates it in place, so callers observe every save.
        if (!options.config.collections) {
            options.config.collections = {};
        }
        return { kind: "inline", config: options.config };
    }
    if (options.configPath !== undefined) {
        if (options.configPath.trim() === "") {
            throw new Error("configPath must be a non-empty path");
        }
        return { kind: "file", path: options.configPath };
    }
    return { kind: "file", path: undefined };
}
// ============================================================================
// Atomic configuration publication and cross-process locking
// ============================================================================
/**
 * A configuration file is shared by every qmd process on the machine (the CLI,
 * the MCP daemon, and any SDK store bound to the same path), so a mutation is
 * a read-modify-write of a contended file:
 *
 *   - every mutation and every whole-file save holds an exclusive write
 *     transaction on a sidecar database beside the config (the same mechanism
 *     `src/trust.ts` and `qmd embed` use), so two processes cannot both read
 *     the same base version and then overwrite each other's change;
 *   - a save publishes by writing a sibling temp file, fsyncing it, and
 *     renaming it over the config, so readers (lock-free `load`, an editor, a
 *     human with `cat`) always observe a complete YAML document — never the
 *     truncate-then-write window of an in-place write.
 *
 * SQLite takes the write lock inside `BEGIN EXCLUSIVE`, and the kernel drops it
 * when the process exits or dies: a crashed writer cannot leave a lock a live
 * one would have to reclaim, there is no PID to recycle, and no age at which a
 * *live* writer looks abandoned. The sidecar is never unlinked — unlinking a
 * lock by pathname is what makes pidfile locks racy. A writer that cannot take
 * the lock within its budget throws instead of writing unlocked.
 */
/** Suffix of the sidecar database that serialises writers for one config. */
const LOCK_SUFFIX = ".lock.sqlite";
/** Budget for taking the write lock; the critical section is one file publish. */
const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
const MAX_SYMLINK_HOPS = 16;
/**
 * Suffix of the sidecar that records a collection rename whose index half has
 * not finished yet.
 *
 * A rename is two resources: the configuration file (published first, so a
 * refused publish cannot lose index data) and the index state keyed by the old
 * name. The publication is preceded by this marker, so a later run has durable
 * evidence of the specific old→new mapping. Without it, "the file no longer
 * lists the old name and lists another name" is not evidence of a rename: that
 * other name may be an unrelated collection, and moving documents into it would
 * corrupt its ownership. A marker that does not match is never acted on.
 */
const PENDING_RENAME_SUFFIX = ".pending-rename.json";
/**
 * The pending-rename marker for a config, or undefined when there is none.
 *
 * Only a missing file (ENOENT) proves there is no journal. Anything else —
 * unreadable, not JSON, or not a valid name pair — means an existing journal
 * cannot be ruled out, and that journal is the only record of a rename whose
 * index move may not have finished, so it fails closed instead of being read as
 * absence and letting a mutation clobber or ignore the evidence.
 */
function readPendingRename(configPath) {
    const markerPath = configSidecarPath(configPath, PENDING_RENAME_SUFFIX);
    let raw;
    try {
        raw = readFileSync(markerPath, "utf-8");
    }
    catch (error) {
        if (errnoCode(error) === "ENOENT")
            return undefined;
        throw new CorruptPendingRenameError(markerPath, `unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        throw new CorruptPendingRenameError(markerPath, `not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new CorruptPendingRenameError(markerPath, "expected an object with 'from' and 'to'");
    }
    if (!("from" in parsed) || !("to" in parsed)) {
        throw new CorruptPendingRenameError(markerPath, "expected 'from' and 'to'");
    }
    const { from, to } = parsed;
    if (typeof from !== "string" || typeof to !== "string") {
        throw new CorruptPendingRenameError(markerPath, "expected string 'from' and 'to'");
    }
    if (!isValidCollectionName(from) || !isValidCollectionName(to)) {
        throw new CorruptPendingRenameError(markerPath, `invalid collection name '${from}' -> '${to}'`);
    }
    if (from === to) {
        throw new CorruptPendingRenameError(markerPath, "a rename must change the name");
    }
    return { from, to };
}
/** Record the rename this config publication is about to make. */
function writePendingRename(configPath, pending) {
    writeFileAtomically(configSidecarPath(configPath, PENDING_RENAME_SUFFIX), JSON.stringify(pending));
}
/** Drop the marker once the index half of the rename finished. */
function clearPendingRename(configPath) {
    try {
        unlinkSync(configSidecarPath(configPath, PENDING_RENAME_SUFFIX));
    }
    catch (error) {
        if (errnoCode(error) !== "ENOENT")
            throw error;
    }
}
function isPendingRename(pending, rename) {
    return pending !== undefined && pending.from === rename.from && pending.to === rename.to;
}
/**
 * Thrown when a configuration mutation would destroy the only evidence of an
 * unfinished rename. Nothing is written: finish the rename first by repeating
 * it, which moves the old name's index state to the new name.
 */
export class PendingRenameError extends Error {
    pending;
    constructor(pending) {
        super(`The rename from '${pending.from}' to '${pending.to}' was published but its index move did not finish. ` +
            `Repeat that rename before changing either name; nothing was written.`);
        this.pending = pending;
        this.name = "PendingRenameError";
    }
}
/**
 * Thrown when an existing pending-rename journal cannot be read or trusted.
 *
 * The journal is the only record of a rename whose index move may not have
 * finished, so it is never read as "no journal": a mutation fails closed
 * instead of clobbering the evidence or moving unrelated state. Nothing is
 * written; the file is left for a deliberate repair or removal.
 */
export class CorruptPendingRenameError extends Error {
    markerPath;
    reason;
    constructor(markerPath, reason) {
        super(`The pending-rename journal at ${markerPath} cannot be trusted (${reason}). ` +
            `It records a collection rename whose index move may not have finished. ` +
            `Repair or remove that file deliberately, then retry; nothing was written.`);
        this.markerPath = markerPath;
        this.reason = reason;
        this.name = "CorruptPendingRenameError";
    }
}
/** Whether a configuration already carries the publication this marker names. */
function configHasRename(config, pending) {
    return config.collections[pending.from] === undefined && config.collections[pending.to] !== undefined;
}
/**
 * Refuse a mutation that would overwrite or invalidate a live rename marker.
 * The matching rename is the only mutation allowed to touch those names.
 */
function assertRenameEvidenceIntact(pending, intent) {
    if (pending === undefined || intent === undefined)
        return;
    if (intent.kind === "rename" && isPendingRename(pending, intent))
        return;
    if (intent.kind === "names") {
        if (!intent.names.includes(pending.from) && !intent.names.includes(pending.to))
            return;
    }
    throw new PendingRenameError(pending);
}
/** Thrown when another process keeps a config lock past the acquisition budget. */
export class ConfigLockTimeoutError extends Error {
    lockPath;
    timeoutMs;
    constructor(lockPath, timeoutMs) {
        super(`Timed out after ${timeoutMs}ms waiting for the configuration lock at ${lockPath}. ` +
            `Another qmd process is writing the config; retry once it finishes.`);
        this.lockPath = lockPath;
        this.timeoutMs = timeoutMs;
        this.name = "ConfigLockTimeoutError";
    }
}
/** Thrown when one config mutation starts from inside another on the same file. */
export class NestedConfigMutationError extends Error {
    configPath;
    lockPath;
    constructor(configPath, lockPath) {
        super(`Cannot start a config mutation for ${configPath} while another mutation of the same file ` +
            `is still running (lock ${lockPath}). Nothing was written: finish the enclosing ` +
            `update() before calling save(), update() or a collection/context mutation again.`);
        this.configPath = configPath;
        this.lockPath = lockPath;
        this.name = "NestedConfigMutationError";
    }
}
/**
 * Locks this process already holds, so a mutation that publishes (or any other
 * nested acquisition) reuses the open transaction instead of self-deadlocking.
 * Keyed by the canonical sidecar path.
 */
const heldLocks = new Map();
/**
 * Config files with a read-modify-write in flight in this process, keyed by the
 * canonical sidecar path. A second mutation on the same file is rejected
 * outright: it would publish its own snapshot, and the enclosing mutation would
 * then overwrite that publish with the stale snapshot it has been mutating.
 * Publishing (the outer mutation's own write) is not a mutation and is allowed.
 */
const mutationsInFlight = new Set();
function errnoCode(error) {
    if (typeof error !== "object" || error === null || !("code" in error))
        return undefined;
    return typeof error.code === "string" ? error.code : undefined;
}
function readMsEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "")
        return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}
/**
 * Resolve the file a save must replace. Writing to a config that is a symlink
 * must update the link's target, not replace the link with a regular file; the
 * atomic rename happens in the target's directory so it stays on one
 * filesystem. Parent-directory symlinks are left alone (equivalent path).
 */
function resolveWriteTarget(configPath) {
    let current = configPath;
    for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop++) {
        let stats;
        try {
            stats = lstatSync(current);
        }
        catch (error) {
            if (errnoCode(error) === "ENOENT")
                return current;
            throw error;
        }
        if (!stats.isSymbolicLink())
            return current;
        const link = readlinkSync(current);
        current = isAbsolute(link) ? link : resolve(dirname(current), link);
    }
    throw new Error(`Too many symlinks while resolving config path ${configPath}`);
}
/**
 * Path of a sidecar file that belongs to one config target.
 *
 * Derived from the *resolved* write target — a symlinked config and the file it
 * points at share it — and canonicalised through the real path of its
 * directory, so relative/absolute spellings and symlinked parents map to the
 * same inode.
 */
function configSidecarPath(configPath, suffix) {
    const target = resolve(resolveWriteTarget(configPath));
    let dir = dirname(target);
    try {
        // The same directory reached through a different path (relative vs
        // absolute, symlinked parent) must map to one name, including for
        // in-process reentrancy.
        dir = realpathSync(dir);
    }
    catch {
        // Missing directory: `resolve` already produced the absolute form.
    }
    return join(dir, `${basename(target)}${suffix}`);
}
/**
 * Path of the sidecar database that serialises writers for a config target.
 * The file is created on demand and deliberately never unlinked.
 */
export function getConfigLockPath(configPath) {
    return configSidecarPath(configPath, LOCK_SUFFIX);
}
/**
 * Run `fn` while holding the exclusive write transaction on the config's
 * sidecar database, handing it the canonical sidecar path so callers can key
 * their own per-target state on exactly the lock that is held. Reentrant within
 * this process (a mutation publishes while it already holds the lock); a writer
 * that cannot take it within its budget throws {@link ConfigLockTimeoutError}
 * instead of writing unlocked.
 *
 * SQLite takes the lock inside `BEGIN EXCLUSIVE` and the kernel drops it when
 * the process exits or dies, so there is no owner record to go stale, no age at
 * which a live writer looks abandoned, and no pathname anyone may unlink.
 */
function withConfigLock(targetPath, fn) {
    // Create the directory first, then derive the sidecar path: canonicalisation
    // through the real path of a directory that exists is stable, so a nested
    // acquisition in this process (mutation → publish) finds the same key.
    const pendingLockPath = getConfigLockPath(targetPath);
    mkdirSync(dirname(pendingLockPath), { recursive: true });
    const lockPath = getConfigLockPath(targetPath);
    const depth = heldLocks.get(lockPath);
    if (depth !== undefined) {
        heldLocks.set(lockPath, depth + 1);
        try {
            return fn(lockPath);
        }
        finally {
            const next = (heldLocks.get(lockPath) ?? 1) - 1;
            if (next <= 0)
                heldLocks.delete(lockPath);
            else
                heldLocks.set(lockPath, next);
        }
    }
    const timeoutMs = readMsEnv("QMD_CONFIG_LOCK_TIMEOUT_MS", DEFAULT_LOCK_TIMEOUT_MS);
    const db = openDatabase(lockPath);
    try {
        // `openDatabase` already enables WAL; this budget is the fail-closed
        // contract for *this* lock, independent of the index-write timeout.
        db.exec(`PRAGMA busy_timeout = ${timeoutMs}`);
        try {
            db.exec("BEGIN EXCLUSIVE");
        }
        catch (error) {
            if (isBusyError(error))
                throw new ConfigLockTimeoutError(lockPath, timeoutMs);
            throw error;
        }
        heldLocks.set(lockPath, 1);
        try {
            return fn(lockPath);
        }
        finally {
            heldLocks.delete(lockPath);
            if (db.inTransaction) {
                try {
                    db.exec("ROLLBACK");
                }
                catch {
                    // Connection already broken; closing it releases everything.
                }
            }
        }
    }
    finally {
        try {
            db.close();
        }
        catch {
            // best effort: the file stays for the next writer, by design.
        }
    }
}
/** Best-effort directory fsync so a completed rename survives a power loss. */
function fsyncDirectory(dir) {
    let fd;
    try {
        fd = openSync(dir, "r");
        fsyncSync(fd);
    }
    catch {
        // Not supported on every platform; the atomic rename is the contract.
    }
    finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch {
                // already closed
            }
        }
    }
}
/**
 * Publish `data` as the whole file atomically. Callers must hold the config
 * lock (the scope's publish path does); this function itself only guarantees
 * that readers see either the previous complete document or this one.
 */
function writeFileAtomically(filePath, data) {
    const target = resolveWriteTarget(filePath);
    const dir = dirname(target);
    mkdirSync(dir, { recursive: true });
    // Preserve the mode of the file being replaced; a fresh file keeps the
    // process umask default that writeFileSync used to apply.
    let mode;
    try {
        mode = statSync(target).mode & 0o777;
    }
    catch (error) {
        if (errnoCode(error) !== "ENOENT")
            throw error;
    }
    const tempPath = join(dir, `.${basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    const bytes = Buffer.from(data, "utf-8");
    let fd;
    try {
        fd = openSync(tempPath, "wx", mode ?? 0o666);
        // `open`'s mode goes through the umask; the replaced file's exact mode wins.
        if (mode !== undefined)
            fchmodSync(fd, mode);
        let offset = 0;
        while (offset < bytes.length)
            offset += writeSync(fd, bytes, offset, bytes.length - offset);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(tempPath, target);
    }
    catch (error) {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch {
                // already closed
            }
        }
        try {
            unlinkSync(tempPath);
        }
        catch {
            // the temp file may not exist yet
        }
        throw error;
    }
    fsyncDirectory(dir);
}
/**
 * One owner of a collection configuration.
 *
 * Every read and write in this module goes through a scope, so the target of
 * a mutation is always the scope that owns it. The CLI uses the single
 * module-level `defaultScope`; each SDK store creates its own scope and never
 * touches another store's target, even while both stores are open, and
 * closing a store only closes its own scope.
 */
export class CollectionConfigScope {
    state;
    resolveDefaultPath;
    /**
     * The index half of a rename this scope still owes for an inline config. An
     * inline config has no file to carry a marker, and the in-memory config lasts
     * exactly as long as this scope, so the scope itself is the durable record.
     */
    pendingInlineRename;
    constructor(options, resolveDefaultPath = getConfigFilePath) {
        this.resolveDefaultPath = resolveDefaultPath;
        this.state = sourceStateFrom(options);
    }
    /**
     * Bind the scope to a different target. Allowed from any state, including
     * closed, because the CLI reuses one default scope across invocations.
     */
    setSource(options) {
        this.state = sourceStateFrom(options);
        // A different target must not inherit this scope's in-memory rename
        // evidence: it would authorize moving another config's index state.
        this.pendingInlineRename = undefined;
    }
    /** Release the scope. Idempotent; later reads and writes throw. */
    close() {
        this.state = { kind: "closed" };
    }
    get isClosed() {
        return this.state.kind === "closed";
    }
    /**
     * Load configuration from this scope's target.
     * Inline targets are returned as-is; missing files yield an empty config.
     *
     * Reads are lock-free: every publish is an atomic rename, so a reader always
     * gets one complete YAML document even while another process mutates.
     */
    load() {
        const state = this.openState();
        if (state.kind === "inline") {
            return state.config;
        }
        return this.readConfigFile(state.path ?? this.resolveDefaultPath());
    }
    /**
     * Save configuration to this scope's target.
     * Inline targets are replaced in memory; file targets are published as YAML
     * under the config lock, atomically.
     *
     * This replaces the whole file: a caller that loaded it earlier and then
     * saves can drop a concurrent process's change. Prefer {@link update} for
     * read-modify-write, which is what every in-tree mutation uses. Calling
     * `save` from inside `update` (or any mutation) on the same config is
     * rejected: the enclosing mutation is the transaction's only writer, and a
     * replacement there would silently discard the edits after it.
     */
    save(config) {
        const state = this.openState();
        if (state.kind === "inline") {
            state.config = config;
            return;
        }
        const configPath = state.path ?? this.resolveDefaultPath();
        const lockPath = getConfigLockPath(resolveWriteTarget(configPath));
        if (mutationsInFlight.has(lockPath)) {
            throw new NestedConfigMutationError(configPath, lockPath);
        }
        // A whole-file replacement can produce or erase the very shapes a rename
        // marker speaks about, so it must not run while that evidence is live.
        withConfigLock(resolveWriteTarget(configPath), () => {
            const pending = readPendingRename(configPath);
            if (pending !== undefined && configHasRename(this.readConfigFile(configPath), pending)) {
                throw new PendingRenameError(pending);
            }
            if (pending !== undefined)
                clearPendingRename(configPath);
            this.publish(configPath, config);
        });
    }
    /**
     * Read, modify and publish this scope's config while holding its exclusive
     * lock. `mutator` sees the current on-disk version and its changes are
     * written even if another process mutated the same file after this scope's
     * caller last loaded it.
     *
     * A mutation started from inside `mutator` — an `update` or any collection or
     * context helper, through this scope or any other scope bound to the same
     * file — is rejected with {@link NestedConfigMutationError} before it reads
     * or writes. Reusing the lock alone would let the nested call publish its own
     * snapshot and the enclosing update overwrite it with its older one.
     *
     * A throwing `mutator` publishes nothing. Returns the configuration that was
     * published (for inline targets, the caller's live object, which is mutated
     * directly: no publish step exists, so nested inline mutations are allowed).
     */
    update(mutator) {
        return this.mutateConfig((config) => {
            mutator(config);
            return { value: config, changed: true };
        }, undefined, { kind: "any" }).value;
    }
    /**
     * Read this scope's authoritative configuration and run `fn` while the
     * config lock is held. Use this to keep a derived store (SQLite's
     * `store_collections`) in step with the file: a lock-free read followed by a
     * later sync would let a mutation another process publishes in between be
     * deleted from the derived store, and would stamp a hash for the stale
     * document.
     *
     * `fn` must not start a mutation of this config (that is rejected with
     * {@link NestedConfigMutationError}); it is for the mirror half of a sync.
     * Inline targets have no file to serialize on and pass their live object.
     */
    withLockedConfig(fn) {
        const state = this.openState();
        if (state.kind === "inline") {
            // No publish step and no lock: a nested inline mutation edits the same
            // live object the caller is deriving from, so no change can be lost.
            return fn(state.config);
        }
        const configPath = state.path ?? this.resolveDefaultPath();
        return withConfigLock(resolveWriteTarget(configPath), (lockPath) => {
            if (mutationsInFlight.has(lockPath)) {
                throw new NestedConfigMutationError(configPath, lockPath);
            }
            mutationsInFlight.add(lockPath);
            try {
                return fn(this.readConfigFile(configPath));
            }
            finally {
                mutationsInFlight.delete(lockPath);
            }
        });
    }
    /**
     * The rename this scope still owes its index half, read without mutating
     * anything: the exact old→new pair, or undefined when there is none.
     *
     * This is how a caller decides whether an operation has something to finish
     * *before* opening the index (or writing anything). Only a missing journal
     * means "none"; an unreadable or malformed one throws
     * {@link CorruptPendingRenameError} instead of being read as absence.
     */
    pendingRename() {
        const state = this.openState();
        if (state.kind === "inline")
            return this.pendingInlineRename;
        return readPendingRename(state.path ?? this.resolveDefaultPath());
    }
    /** Get this scope's config path, or `<inline>` for in-memory configs. */
    getConfigPath() {
        const state = this.openState();
        if (state.kind === "inline")
            return "<inline>";
        return state.path ?? this.resolveDefaultPath();
    }
    /** Check whether this scope's target exists. Inline configs always do. */
    configExists() {
        const state = this.openState();
        if (state.kind === "inline")
            return true;
        return existsSync(state.path ?? this.resolveDefaultPath());
    }
    /** Get a specific collection by name, or null if not found. */
    getCollection(name) {
        const collection = this.load().collections[name];
        if (!collection)
            return null;
        return { name, ...collection };
    }
    /** List all collections in this scope. */
    listCollections() {
        return Object.entries(this.load().collections).map(([name, collection]) => ({
            name,
            ...collection,
        }));
    }
    /** List collections included by default in queries. */
    getDefaultCollections() {
        return this.listCollections().filter(c => c.includeByDefault !== false);
    }
    /** List names of collections included by default in queries. */
    getDefaultCollectionNames() {
        return this.getDefaultCollections().map(c => c.name);
    }
    /** Update a collection's settings. Returns false when it does not exist. */
    updateCollectionSettings(name, settings) {
        return this.mutateConfig((config) => {
            const collection = config.collections[name];
            if (!collection)
                return { value: false, changed: false };
            if (settings.update !== undefined) {
                if (settings.update === null) {
                    delete collection.update;
                }
                else {
                    collection.update = settings.update;
                }
            }
            if (settings.includeByDefault !== undefined) {
                if (settings.includeByDefault === true) {
                    // true is default, remove the field
                    delete collection.includeByDefault;
                }
                else {
                    collection.includeByDefault = settings.includeByDefault;
                }
            }
            return { value: true, changed: true };
        }).value;
    }
    /**
     * Add or update a collection, preserving its existing context.
     *
     * `mirror` (see {@link ConfigMirror}) runs after the publish, under the same
     * lock, so a caller that keeps its own copy of the configuration in SQLite
     * steps in with the file rather than after an unlocked window.
     */
    addCollection(name, path, pattern = "**/*.md", mirror) {
        this.mutateConfig((config) => {
            config.collections[name] = {
                path,
                pattern,
                context: config.collections[name]?.context, // Preserve existing context
            };
            return { value: undefined, changed: true };
        }, mirror, { kind: "names", names: [name] });
    }
    /**
     * Remove a collection. Returns whether anything changed — in the
     * configuration or, through `mirror`, in the derived state — so a row that
     * only the derived store still held is still reported (and removed).
     */
    removeCollection(name, mirror) {
        const { value, mirrored } = this.mutateConfig((config) => {
            if (!config.collections[name]) {
                return { value: false, changed: false };
            }
            delete config.collections[name];
            return { value: true, changed: true };
        }, mirror, { kind: "names", names: [name] });
        return value || mirrored;
    }
    /**
     * Rename a collection. Throws when the new name is already taken, before
     * anything is published.
     *
     * A rename has an index half as well as a file half, so its `mirror` runs
     * only against durable evidence of that rename: the marker written before
     * this publication, or the publication itself. Without it, "the file no
     * longer lists the old name and lists another one" is not evidence — that
     * other name may be an unrelated collection, and moving the old name's
     * documents into it would corrupt its ownership — so `mirrored` is false and
     * the caller reports that nothing was renamed.
     */
    renameCollection(oldName, newName, mirror) {
        const { value, mirrored } = this.mutateConfig((config) => {
            if (!config.collections[oldName]) {
                return { value: false, changed: false };
            }
            if (config.collections[newName]) {
                throw new Error(`Collection '${newName}' already exists`);
            }
            config.collections[newName] = config.collections[oldName];
            delete config.collections[oldName];
            return { value: true, changed: true };
        }, mirror, { kind: "rename", from: oldName, to: newName });
        return value || mirrored;
    }
    /** Get the global context. */
    getGlobalContext() {
        return this.load().global_context;
    }
    /** Set the global context. `mirror` behaves as in {@link addCollection}. */
    setGlobalContext(context, mirror) {
        this.mutateConfig((config) => {
            config.global_context = context;
            return { value: undefined, changed: true };
        }, mirror);
    }
    /** Get all contexts for a collection. */
    getContexts(collectionName) {
        return this.getCollection(collectionName)?.context;
    }
    /**
     * Add or update a context for a path in a collection. `mirror` behaves as in
     * {@link addCollection}.
     */
    addContext(collectionName, pathPrefix, contextText, mirror) {
        const { value, mirrored } = this.mutateConfig((config) => {
            const collection = config.collections[collectionName];
            if (!collection) {
                return { value: false, changed: false };
            }
            if (!collection.context) {
                collection.context = {};
            }
            collection.context[pathPrefix] = contextText;
            return { value: true, changed: true };
        }, mirror);
        return value || mirrored;
    }
    /**
     * Remove a context from a collection path. `mirror` behaves as in
     * {@link addCollection}.
     */
    removeContext(collectionName, pathPrefix, mirror) {
        const { value, mirrored } = this.mutateConfig((config) => {
            const collection = config.collections[collectionName];
            if (!collection?.context?.[pathPrefix]) {
                return { value: false, changed: false };
            }
            delete collection.context[pathPrefix];
            // Remove empty context object
            if (Object.keys(collection.context).length === 0) {
                delete collection.context;
            }
            return { value: true, changed: true };
        }, mirror);
        return value || mirrored;
    }
    /** List all contexts across all collections in this scope. */
    listAllContexts() {
        const config = this.load();
        const results = [];
        // Add global context if present
        if (config.global_context) {
            results.push({
                collection: "*",
                path: "/",
                context: config.global_context,
            });
        }
        // Add collection contexts
        for (const [name, collection] of Object.entries(config.collections)) {
            if (collection.context) {
                for (const [path, context] of Object.entries(collection.context)) {
                    results.push({
                        collection: name,
                        path,
                        context,
                    });
                }
            }
        }
        return results;
    }
    /**
     * Find best matching context for a given collection and path.
     * Returns the most specific matching context (longest path prefix match).
     */
    findContextForPath(collectionName, filePath) {
        const config = this.load();
        const collection = config.collections[collectionName];
        if (!collection?.context) {
            return config.global_context;
        }
        // Find all matching prefixes
        const matches = [];
        for (const [prefix, context] of Object.entries(collection.context)) {
            // Normalize paths for comparison
            const normalizedPath = filePath.startsWith("/") ? filePath : `/${filePath}`;
            const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
            if (normalizedPath.startsWith(normalizedPrefix)) {
                matches.push({ prefix: normalizedPrefix, context });
            }
        }
        // Return most specific match (longest prefix)
        if (matches.length > 0) {
            matches.sort((a, b) => b.prefix.length - a.prefix.length);
            return matches[0].context;
        }
        // Fallback to global context
        return config.global_context;
    }
    /** Read and parse the YAML file, treating a missing file as empty. */
    readConfigFile(configPath) {
        if (!existsSync(configPath)) {
            return { collections: {} };
        }
        try {
            const content = readFileSync(configPath, "utf-8");
            const parsed = YAML.parse(content);
            const config = parsed ?? { collections: {} };
            // Ensure collections object exists
            if (!config.collections) {
                config.collections = {};
            }
            return config;
        }
        catch (error) {
            throw new Error(`Failed to parse ${configPath}: ${error}`);
        }
    }
    /**
     * Publish a whole configuration: serialise first, then replace the file under
     * the lock with an atomic rename. Reentrant with the mutation lock.
     */
    publish(configPath, config) {
        try {
            const yaml = YAML.stringify(config, {
                indent: 2,
                lineWidth: 0, // Don't wrap lines
            });
            withConfigLock(resolveWriteTarget(configPath), () => {
                writeFileAtomically(configPath, yaml);
            });
        }
        catch (error) {
            if (error instanceof ConfigLockTimeoutError)
                throw error;
            throw new Error(`Failed to write ${configPath}: ${error}`);
        }
    }
    /**
     * Shared read-modify-write path for file targets: the config is re-read from
     * disk under the exclusive lock, so a change another process published since
     * the caller last looked is preserved instead of being overwritten with a
     * stale copy. Inline targets are mutated in place, as before.
     *
     * A mutation started from inside another mutation on the same file is
     * rejected before it reads or writes: reusing the lock would let the nested
     * call publish its own snapshot, which the enclosing mutation would then
     * overwrite with the stale snapshot it has been mutating. The check runs
     * under the (reentrantly held) lock, so it cannot interleave with another
     * acquisition in this process.
     *
     * `mutator` returns the value to hand back and whether anything changed; an
     * unchanged result neither publishes nor touches the file. `mirror` runs
     * after the publish (after the in-place edit for inline targets) and still
     * under the same lock, whether or not the configuration changed: the derived
     * store must be able to catch up to a file that already holds the change. Its
     * throw propagates with the configuration already published; the next sync
     * repairs the derived store from it. A `rename` is the exception: see below.
     *
     * `rename` marks the mutation as one whose derived half is keyed by a name
     * pair. Its marker is written before the publication (so a crash between the
     * two leaves evidence) and removed only after the mirror succeeds; the mirror
     * runs when the mutation published, or when that marker proves the earlier
     * publication. See {@link CollectionConfigScope.renameCollection}.
     */
    mutateConfig(mutator, mirror, intent) {
        const state = this.openState();
        if (state.kind === "inline") {
            // No publish step: a nested inline mutation edits the caller's live
            // object, so no change can be lost and no rejection is needed. An inline
            // config has no file to carry the marker, so the scope object itself
            // remembers the rename it still owes while it stays open.
            let pending = this.pendingInlineRename;
            if (pending !== undefined && !configHasRename(state.config, pending)) {
                this.pendingInlineRename = undefined;
                pending = undefined;
            }
            assertRenameEvidenceIntact(pending, intent);
            const { value, changed } = mutator(state.config);
            if (intent?.kind === "rename" && mirror !== undefined && changed) {
                this.pendingInlineRename = { from: intent.from, to: intent.to };
            }
            const evidence = intent?.kind !== "rename"
                || changed
                || isPendingRename(pending, intent);
            if (!evidence)
                return { value, changed, mirrored: false };
            const mirrored = mirror?.(state.config) === true;
            if (intent?.kind === "rename")
                this.pendingInlineRename = undefined;
            return { value, changed, mirrored };
        }
        const configPath = state.path ?? this.resolveDefaultPath();
        return withConfigLock(resolveWriteTarget(configPath), (lockPath) => {
            if (mutationsInFlight.has(lockPath)) {
                throw new NestedConfigMutationError(configPath, lockPath);
            }
            const config = this.readConfigFile(configPath);
            mutationsInFlight.add(lockPath);
            try {
                // A marker is evidence only while the file reflects its publication. One
                // left by a publish that failed names an attempt, not a rename, so it is
                // dropped rather than allowed to block a change or authorize a move.
                let pending = readPendingRename(configPath);
                if (pending !== undefined && !configHasRename(config, pending)) {
                    clearPendingRename(configPath);
                    pending = undefined;
                }
                assertRenameEvidenceIntact(pending, intent);
                const { value, changed } = mutator(config);
                if (intent?.kind === "rename" && mirror !== undefined && changed) {
                    // Durable intent first: a crash after the publication but before the
                    // index half leaves this behind, and it is the only thing that may
                    // authorize moving the old name's index state later.
                    writePendingRename(configPath, { from: intent.from, to: intent.to });
                }
                if (changed)
                    this.publish(configPath, config);
                const evidence = intent?.kind !== "rename"
                    || changed
                    || isPendingRename(pending, intent);
                if (!evidence)
                    return { value, changed, mirrored: false };
                // The file is published before the derived state changes, so a failed
                // publish (lock budget, permissions, disk) leaves no database-only
                // edit behind. Holding the lock through the mirror keeps every mirror
                // ordered with the publishes it was derived from.
                const mirrored = mirror?.(config) === true;
                if (intent?.kind === "rename" && mirror !== undefined)
                    clearPendingRename(configPath);
                return { value, changed, mirrored };
            }
            finally {
                mutationsInFlight.delete(lockPath);
            }
        });
    }
    openState() {
        if (this.state.kind === "closed") {
            throw new ConfigScopeClosedError();
        }
        return this.state;
    }
}
// ============================================================================
// Module-level API: the CLI's default scope
// ============================================================================
/**
 * The scope the module-level helpers below read and write. CLI code binds it
 * once per invocation via `setConfigSource` / `setConfigIndexName`; SDK
 * consumers should own a `CollectionConfigScope` per store instead.
 */
const defaultScope = new CollectionConfigScope();
/**
 * Set the config source for the default scope.
 * - File path: load/save from a specific YAML file
 * - Inline config: use an in-memory CollectionConfig (saveConfig updates in place, no file I/O)
 * - undefined: reset to default file-based config
 */
export function setConfigSource(source) {
    defaultScope.setSource(source);
}
/** Load configuration from the default scope. */
export function loadConfig() {
    return defaultScope.load();
}
/**
 * Save configuration to the default scope.
 *
 * Replaces the whole file atomically under the config lock. A caller that
 * loaded the config earlier can drop another process's change; use
 * {@link updateConfig} for read-modify-write.
 */
export function saveConfig(config) {
    defaultScope.save(config);
}
/**
 * Read, modify and publish the default scope's config under its exclusive
 * lock, so concurrent qmd processes cannot lose each other's changes.
 * `mutator` receives the version currently on disk. Starting another mutation
 * of the same file from inside `mutator` throws {@link NestedConfigMutationError}
 * before anything is written.
 */
export function updateConfig(mutator) {
    return defaultScope.update(mutator);
}
/**
 * Read the default scope's authoritative configuration and run `fn` while its
 * lock is held. This is how the CLI keeps SQLite in step with the file: a
 * lock-free {@link loadConfig} followed by a later sync can delete a
 * collection another qmd process published in between.
 *
 * `fn` must not start a mutation of the same file (rejected with
 * {@link NestedConfigMutationError}); it is for the mirror half of a sync.
 */
export function withConfigLocked(fn) {
    return defaultScope.withLockedConfig(fn);
}
/**
 * The default scope's unfinished rename, read without mutating anything
 * (see {@link CollectionConfigScope.pendingRename}).
 */
export function getPendingRename() {
    return defaultScope.pendingRename();
}
/**
 * Whether this exact rename still owes its index half. A caller that would
 * otherwise open the index (writing nothing yet) uses this to decide whether
 * the operation has anything to finish first — a name the config no longer
 * lists is only a rename worth acting on when this pair is recorded.
 */
export function hasPendingRename(from, to) {
    return isPendingRename(defaultScope.pendingRename(), { from, to });
}
/** Get a specific collection by name from the default scope. */
export function getCollection(name) {
    return defaultScope.getCollection(name);
}
/** List all collections in the default scope. */
export function listCollections() {
    return defaultScope.listCollections();
}
/** Get collections that are included by default in queries. */
export function getDefaultCollections() {
    return defaultScope.getDefaultCollections();
}
/** Get collection names that are included by default. */
export function getDefaultCollectionNames() {
    return defaultScope.getDefaultCollectionNames();
}
/** Update a collection's settings in the default scope. */
export function updateCollectionSettings(name, settings) {
    return defaultScope.updateCollectionSettings(name, settings);
}
/** Add or update a collection in the default scope. */
export function addCollection(name, path, pattern = "**/*.md", mirror) {
    defaultScope.addCollection(name, path, pattern, mirror);
}
/** Remove a collection from the default scope. */
export function removeCollection(name, mirror) {
    return defaultScope.removeCollection(name, mirror);
}
/** Rename a collection in the default scope. */
export function renameCollection(oldName, newName, mirror) {
    return defaultScope.renameCollection(oldName, newName, mirror);
}
/** Get global context from the default scope. */
export function getGlobalContext() {
    return defaultScope.getGlobalContext();
}
/** Set global context in the default scope. */
export function setGlobalContext(context, mirror) {
    defaultScope.setGlobalContext(context, mirror);
}
/** Get all contexts for a collection in the default scope. */
export function getContexts(collectionName) {
    return defaultScope.getContexts(collectionName);
}
/** Add or update a context for a specific path in the default scope. */
export function addContext(collectionName, pathPrefix, contextText, mirror) {
    return defaultScope.addContext(collectionName, pathPrefix, contextText, mirror);
}
/** Remove a context from the default scope. */
export function removeContext(collectionName, pathPrefix, mirror) {
    return defaultScope.removeContext(collectionName, pathPrefix, mirror);
}
/** List all contexts across all collections in the default scope. */
export function listAllContexts() {
    return defaultScope.listAllContexts();
}
/** Find best matching context for a given collection and path. */
export function findContextForPath(collectionName, filePath) {
    return defaultScope.findContextForPath(collectionName, filePath);
}
/** Get the default scope's config file path (useful for error messages). */
export function getConfigPath() {
    return defaultScope.getConfigPath();
}
/** Check if the default scope's config file exists. */
export function configExists() {
    return defaultScope.configExists();
}
/**
 * Validate a collection name
 * Collection names must be valid and not contain special characters
 */
export function isValidCollectionName(name) {
    // Allow alphanumeric, hyphens, underscores
    return /^[a-zA-Z0-9_-]+$/.test(name);
}
