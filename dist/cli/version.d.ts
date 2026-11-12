/**
 * Build/commit identification for `qmd --version`.
 *
 * The commit is *stamped at build time* (scripts/build.mjs writes
 * build-info.json next to the compiled CLI) rather than discovered at runtime.
 * A published tarball carries no git history of its own, so a runtime lookup
 * can only ever find some *other* repository's HEAD: `git -C <dir> rev-parse`
 * walks up the tree, and a global install under a git-managed prefix (e.g.
 * Homebrew's /opt/homebrew) reported that prefix's commit as qmd's.
 *
 * Running from a source checkout has no stamp, so the git lookup remains as a
 * fallback — but only after confirming the enclosing repository is the package
 * we are actually running from.
 */
/** Written next to the compiled CLI (dist/cli/) by scripts/build.mjs. */
export declare const BUILD_INFO_FILENAME = "build-info.json";
export type BuildInfo = {
    commit: string;
    builtAt?: string;
};
/**
 * Read the commit stamped into this build, or "" when there is none.
 *
 * Deliberately looks beside the running script rather than in the package's
 * dist/ directory: a source run (src/cli/) must not pick up the stamp left by
 * an earlier, possibly unrelated, build in dist/.
 */
export declare function readStampedCommit(scriptDir: string): string;
/**
 * Short HEAD of the checkout we are running from, or "" when we are not
 * running from one.
 *
 * The guard is the whole point: an enclosing repository is only qmd's if its
 * top level *is* this package's root. Without that check, any install nested
 * inside an unrelated repository reports that repository's HEAD.
 */
export declare function gitCommitForCheckout(scriptDir: string, packageRoot: string): string;
/**
 * The commit to report for this invocation: the build stamp when there is one,
 * otherwise the verified checkout HEAD, otherwise nothing.
 */
export declare function resolveCommit(scriptDir: string, packageRoot: string): string;
