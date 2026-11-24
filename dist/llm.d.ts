/**
 * llm.ts - LLM abstraction layer for QMD using node-llama-cpp
 *
 * Provides embeddings, text generation, and reranking using local GGUF models.
 */
import type { Llama, Token as LlamaToken } from "node-llama-cpp";
type NodeLlamaCppModule = {
    getLlama: (options: Record<string, unknown>) => Promise<Llama>;
    getLlamaGpuTypes?: (include?: "supported" | "allValid") => Promise<LlamaGpuMode[]>;
    resolveModelFile: (model: string, optionsOrDirectory?: string | {
        directory?: string;
        cli?: boolean;
        download?: "auto" | false;
    }) => Promise<string>;
    LlamaChatSession: new (options: {
        contextSequence: unknown;
    }) => {
        prompt: (prompt: string, options?: Record<string, unknown>) => Promise<string>;
    };
    LlamaLogLevel: {
        error: unknown;
    };
};
export declare function setNodeLlamaCppModuleForTest(module: NodeLlamaCppModule | null): void;
/**
 * Some node-llama-cpp native build/probe paths write library noise to stdout.
 * JSON APIs must reserve stdout for machine-readable payloads, so route that
 * noise to stderr while native llama initialization is in progress.
 */
export declare function withNativeStdoutRedirectedToStderr<T>(fn: () => Promise<T>): Promise<T>;
import { type RemoteEmbedOptions } from "./remote-embed.js";
import { type JevRerankOptions } from "./jev.js";
/**
 * Detect if a model URI uses the Qwen3-Embedding format.
 * Qwen3-Embedding uses a different prompting style than nomic/embeddinggemma.
 */
export declare function isQwen3EmbeddingModel(modelUri: string): boolean;
/**
 * Format a query for embedding.
 * Uses nomic-style task prefix format for embeddinggemma (default).
 * Uses Qwen3-Embedding instruct format when a Qwen embedding model is active.
 */
export declare function formatQueryForEmbedding(query: string, modelUri?: string): string;
/**
 * Format a document for embedding.
 * Uses nomic-style format with title and text fields (default).
 * Qwen3-Embedding encodes documents as raw text without special prefixes.
 */
export declare function formatDocForEmbedding(text: string, title?: string, modelUri?: string): string;
export declare function setLlamaDirWritableForTest(writable: boolean | undefined): void;
/** Whether node-llama-cpp can write to its llama/ directory (false on NixOS). */
export declare function canWriteLlamaDir(pkgDir?: string): boolean;
/**
 * Token with log probability
 */
export type TokenLogProb = {
    token: string;
    logprob: number;
};
/**
 * Embedding result
 */
export type EmbeddingResult = {
    embedding: number[];
    model: string;
};
/**
 * Generation result with optional logprobs
 */
export type GenerateResult = {
    text: string;
    model: string;
    logprobs?: TokenLogProb[];
    done: boolean;
};
/**
 * Rerank result for a single document
 */
export type RerankDocumentResult = {
    file: string;
    score: number;
    index: number;
};
/**
 * Batch rerank result
 */
export type RerankResult = {
    results: RerankDocumentResult[];
    model: string;
};
/**
 * Model info
 */
export type ModelInfo = {
    name: string;
    exists: boolean;
    path?: string;
};
/**
 * Options for embedding
 */
export type EmbedOptions = {
    signal?: AbortSignal;
    model?: string;
    isQuery?: boolean;
    title?: string;
};
/**
 * Options for text generation
 */
export type GenerateOptions = {
    model?: string;
    maxTokens?: number;
    temperature?: number;
};
/**
 * Options for reranking
 */
export type RerankOptions = {
    signal?: AbortSignal;
    model?: string;
};
/**
 * Options for LLM sessions
 */
export type LLMSessionOptions = {
    /** Max session duration in ms (default: 10 minutes) */
    maxDuration?: number;
    /** External abort signal */
    signal?: AbortSignal;
    /** Debug name for logging */
    name?: string;
};
/**
 * Session interface for scoped LLM access with lifecycle guarantees
 */
export interface ILLMSession {
    embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null>;
    embedBatch(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]>;
    expandQuery(query: string, options?: {
        context?: string;
        includeLexical?: boolean;
    }): Promise<Queryable[]>;
    rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult>;
    /** Whether this session is still valid (not released or aborted) */
    readonly isValid: boolean;
    /** Abort signal for this session (aborts on release or maxDuration) */
    readonly signal: AbortSignal;
}
/**
 * Supported query types for different search backends
 */
export type QueryType = 'lex' | 'vec' | 'hyde';
/**
 * A single query and its target backend type
 */
export type Queryable = {
    type: QueryType;
    text: string;
};
/**
 * Document to rerank
 */
export type RerankDocument = {
    file: string;
    text: string;
    title?: string;
};
export declare const LFM2_GENERATE_MODEL = "hf:LiquidAI/LFM2-1.2B-GGUF/LFM2-1.2B-Q4_K_M.gguf";
export declare const LFM2_INSTRUCT_MODEL = "hf:LiquidAI/LFM2.5-1.2B-Instruct-GGUF/LFM2.5-1.2B-Instruct-Q4_K_M.gguf";
export declare const DEFAULT_EMBED_MODEL_URI = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
export declare const DEFAULT_RERANK_MODEL_URI = "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf";
export declare const DEFAULT_GENERATE_MODEL_URI = "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf";
export type ModelResolutionConfig = {
    embed?: string;
    generate?: string;
    rerank?: string;
};
export declare function resolveEmbedModel(config?: ModelResolutionConfig): string;
export declare function resolveGenerateModel(config?: ModelResolutionConfig): string;
export declare function resolveRerankModel(config?: ModelResolutionConfig): string;
export declare function resolveModels(config?: ModelResolutionConfig): Required<ModelResolutionConfig>;
export declare const DEFAULT_MODEL_CACHE_DIR: string;
export type PullResult = {
    model: string;
    path: string;
    sizeBytes: number;
    refreshed: boolean;
};
export type GgufFileInspection = {
    exists: boolean;
    valid: boolean;
    /**
     * "html" and "invalid" mean the header was read and is confirmed bad.
     * "unreadable" means the read itself failed, so nothing is known about the
     * content. The two stay distinct because only the first justifies deleting
     * the file.
     */
    kind: "missing" | "gguf" | "html" | "invalid" | "unreadable";
    sizeBytes?: number;
    magic?: string;
    details: string;
};
/**
 * Inspect a potential GGUF model file without mutating it.
 * Used by doctor for early diagnostics and by runtime validation before load.
 */
export declare function inspectGgufFile(filePath: string): GgufFileInspection;
export declare function pullModels(models: string[], options?: {
    refresh?: boolean;
    cacheDir?: string;
    cli?: boolean;
}): Promise<PullResult[]>;
/**
 * Abstract LLM interface - implement this for different backends
 */
export interface LLM {
    /**
     * Get embeddings for text
     */
    embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null>;
    /**
     * Generate text completion
     */
    generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult | null>;
    /**
     * Check if a model exists/is available
     */
    modelExists(model: string): Promise<ModelInfo>;
    /**
     * Expand a search query into multiple variations for different backends.
     * Returns a list of Queryable objects.
     */
    expandQuery(query: string, options?: {
        context?: string;
        includeLexical?: boolean;
    }): Promise<Queryable[]>;
    /**
     * Rerank documents by relevance to a query
     * Returns list of documents with relevance scores (higher = more relevant)
     */
    rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult>;
    /**
     * Dispose of resources
     */
    dispose(): Promise<void>;
}
export type LlamaCppConfig = {
    embedModel?: string;
    embedOptions?: RemoteEmbedOptions;
    generateModel?: string;
    rerankModel?: string;
    rerankOptions?: JevRerankOptions;
    /** Folder for downloaded model files. Default: the qmd/models folder under XDG_CACHE_HOME or ~/.cache. */
    modelCacheDir?: string;
    /**
     * Never download (default: false). A model file missing from the cache fails
     * to resolve, and llama.cpp is neither downloaded nor built from source.
     */
    skipDownload?: boolean;
    /** GPU backend, or false for CPU only. Takes precedence over QMD_LLAMA_GPU and QMD_FORCE_CPU. */
    gpu?: LlamaGpuMode;
    /** Number of parallel embedding contexts, capped at 8. Takes precedence over QMD_EMBED_PARALLELISM. */
    embedParallelism?: number;
    /** Embedding context size in tokens. Takes precedence over QMD_EMBED_CONTEXT_SIZE. */
    embedContextSize?: number;
    /**
     * Context size used for query expansion generation contexts.
     * Default: 2048. Can also be set via QMD_EXPAND_CONTEXT_SIZE.
     */
    expandContextSize?: number;
    /** Reranking context size in tokens (default: 4096). Takes precedence over QMD_RERANK_CONTEXT_SIZE. */
    rerankContextSize?: number;
    /**
     * Inactivity timeout in ms before unloading contexts (default: 2 minutes, 0 to disable).
     *
     * Per node-llama-cpp lifecycle guidance, we prefer keeping models loaded and only disposing
     * contexts when idle, since contexts (and their sequences) are the heavy per-session objects.
     * @see https://node-llama-cpp.withcat.ai/guide/objects-lifecycle
     */
    inactivityTimeoutMs?: number;
    /**
     * Whether to dispose models on inactivity (default: false).
     *
     * Keeping models loaded avoids repeated VRAM thrash; set to true only if you need aggressive
     * memory reclaim.
     */
    disposeModelsOnInactivity?: boolean;
    /**
     * Run model operations while the CI environment variable is set (default: false).
     * Without it, embedBatch, generate, expandQuery and rerank throw in CI.
     */
    allowInCI?: boolean;
};
export type LlamaGpuMode = "auto" | "metal" | "vulkan" | "cuda" | false;
type ParallelismOptions = {
    gpu: string | false;
    platform?: NodeJS.Platform;
    computed: number;
    envValue?: string;
};
export declare function resolveParallelismOverride(envValue?: string | undefined): number | undefined;
export declare function resolveSafeParallelism(options: ParallelismOptions): number;
/** Measured nomic-embed / embeddinggemma-300M embedding-context cost at 2048 tokens. */
export declare const BASELINE_EMBED_CONTEXT_MB = 150;
/**
 * VRAM to leave free when sizing the embedding-context pool so `query` can
 * still create a rerank context afterwards. Matches the 1000 MB figure
 * `ensureRerankContexts` already uses as its per-context cost.
 */
export declare const EMBED_POOL_RERANK_RESERVE_MB = 1000;
/**
 * GPU embedding-context pool size from free VRAM.
 *
 * Uses 25% of (free − reserve), then clamps to `[1, cap]`. The reserve keeps
 * the pool from consuming the memory `query` needs next for the reranker (#799).
 */
export declare function computeGpuContextPoolSize(options: {
    freeMB: number;
    perContextMB: number;
    reserveMB?: number;
    cap?: number;
}): number;
/**
 * Estimate one embedding context's VRAM from the GGUF weight-file size.
 *
 * Small models (nomic / embeddinggemma-class, ≲350 MB) stay at the measured
 * 150 MB baseline so default `qmd embed` throughput is unchanged. Larger
 * files — Qwen3-Embedding-0.6B-Q8 is ~640 MB — were measured at ~1190 MB per
 * 2048-token context, about 1.85× the weight file, because the KV cache
 * dominates (#799).
 */
export declare function estimateEmbedContextMB(options: {
    modelBytes: number;
    contextSize?: number;
}): number;
export declare function resolveLlamaGpuMode(envValue?: string | undefined, forceCpuValue?: string | undefined): LlamaGpuMode;
/**
 * Explicit resource lifecycle for one LlamaCpp instance:
 *
 *   ready      → models/contexts may be loaded, borrowed and idle-unloaded.
 *   unloading  → an idle unload is disposing detached contexts; new work parks
 *                until the real disposal completes.
 *   disposing  → terminal dispose() is running; new work is rejected and
 *                already-running operations plus any idle unload finish before
 *                resources are freed.
 *   disposed   → terminal; every operation is rejected.
 *
 * Entering "unloading"/"disposing" happens synchronously, before the first
 * await of the routine that owns it. That makes the readiness check and lease
 * acquisition atomic with respect to each other: a caller either takes a lease
 * first (and an idle unload then declines), or observes "unloading" and parks
 * on its completion instead of borrowing a context that is being disposed.
 */
export type LlamaCppLifecycleState = "ready" | "unloading" | "disposing" | "disposed";
export declare class LlamaCpp implements LLM {
    private readonly _ciMode;
    private llama;
    private embedModel;
    private embedModelPath;
    private embedContexts;
    private generateModel;
    private rerankModel;
    private rerankContexts;
    private embedModelUri;
    private readonly remoteEmbedder?;
    private generateModelUri;
    private rerankModelUri;
    private readonly jevReranker?;
    private modelCacheDir;
    private skipDownload;
    private gpu;
    private embedParallelism;
    private embedContextSize;
    private expandContextSize;
    private rerankContextSize;
    private embedModelLoadPromise;
    private generateModelLoadPromise;
    private rerankModelLoadPromise;
    private rerankContextsCreatePromise;
    private llamaLoadPromise;
    private inactivityTimer;
    private inactivityTimeoutMs;
    private disposeModelsOnInactivity;
    /**
     * Guards every resource borrow and disposal for this instance. Shared with
     * sessions opened through withLLMSession/withLLMSessionForLlm, and with the
     * inactivity timer, so all of them agree on one lifecycle.
     */
    private readonly lifecycle;
    constructor(config?: LlamaCppConfig);
    /** Current resource lifecycle state (diagnostics and lifecycle tests). */
    get lifecycleState(): LlamaCppLifecycleState;
    get embedModelName(): string;
    private embedRemote;
    get generateModelName(): string;
    get rerankModelName(): string;
    /**
     * Reset the inactivity timer. Called after each model operation.
     *
     * The timer only unloads when THIS instance's lifecycle reports no leased
     * work (sessions and in-flight operations), so a session opened through
     * withLLMSessionForLlm is as visible as one opened on the default instance.
     */
    private touchActivity;
    /**
     * Inactivity timer callback: unload when nothing is leased, otherwise look
     * again after another idle window.
     *
     * Kept as a named method so lifecycle tests can exercise the exact decision
     * the timer makes without depending on platform timer APIs.
     */
    private handleInactivityTimeout;
    /**
     * Check if any contexts are currently loaded (and therefore worth unloading on inactivity).
     */
    private hasLoadedContexts;
    /**
     * Begin an idle unload when the lifecycle permits it.
     *
     * Returns the completion promise, or null when work is still leased (or a
     * transition owns the resources). The transition into "unloading" happens
     * synchronously, so no caller can borrow a pooled context between the
     * decision and the disposal.
     */
    private startIdleUnload;
    /**
     * Unload idle resources but keep the instance alive for future use.
     *
     * By default, this disposes contexts (and their dependent sequences), while keeping models loaded.
     * This matches the intended lifecycle: model → context → sequence, where contexts are per-session.
     *
     * Declines (and resolves) when sessions or operations are leased, or while
     * another transition already owns the resources: a borrowed context must
     * never be disposed underneath its user.
     */
    unloadIdleResources(): Promise<void>;
    /**
     * Detach the current context pools from the instance.
     *
     * Nothing can borrow what ensureEmbedContexts()/ensureRerankContexts() no
     * longer publish, which is what makes the awaits in the disposers safe.
     */
    private drainContextPools;
    /**
     * Dispose what an idle unload owns.
     *
     * Disposal is awaited to real completion, deliberately without a timeout:
     * admission reopens only once the contexts (and, when opted in, models) are
     * actually gone. Letting a timed-out dispose keep running while admission
     * resumes would allow a fresh borrow to overlap it, or a model teardown to
     * overlap its context's disposal. This matches the pre-existing idle path.
     */
    private disposeIdleResources;
    /**
     * Run a model/context operation under an operation lease.
     *
     * The lease keeps an idle unload from starting mid-operation, and admission
     * parks while an idle unload is already disposing resources instead of
     * borrowing a context that is about to be (or is being) disposed.
     */
    private withOperationLease;
    /**
     * Ensure model cache directory exists
     */
    private ensureModelCacheDir;
    /**
     * Initialize the llama instance (lazy)
     */
    private ensureLlama;
    private loadLlamaRuntime;
    private resolveGpuMode;
    private isCpuOffloadForced;
    private modelLoadOptions;
    /**
     * Resolve a model URI to a local path, downloading if needed.
     * Validates the downloaded file is actually a GGUF model (not an HTML error page
     * from a proxy or firewall).
     */
    private resolveModel;
    /**
     * Load embedding model (lazy)
     */
    private ensureEmbedModel;
    /**
     * Compute how many parallel contexts to create.
     *
     * GPU: constrained by VRAM (25% of free, capped at 8).
     * CPU: constrained by cores. Splitting threads across contexts enables
     *      true parallelism (each context runs on its own cores). Use at most
     *      half the math cores, with at least 4 threads per context.
     */
    private computeParallelism;
    /**
     * Get the number of threads each context should use, given N parallel contexts.
     * Splits available math cores evenly across contexts.
     */
    private threadsPerContext;
    /**
     * Load embedding contexts (lazy). Creates multiple for parallel embedding.
     * Uses promise guard to prevent concurrent context creation race condition.
     */
    private embedContextsCreatePromise;
    private ensureEmbedContexts;
    /**
     * Get a single embed context (for single-embed calls). Uses first from pool.
     */
    private ensureEmbedContext;
    /**
     * Load generation model (lazy) - context is created fresh per call
     */
    private ensureGenerateModel;
    /**
     * Load rerank model (lazy)
     */
    private ensureRerankModel;
    /**
     * Load rerank contexts (lazy). Creates multiple contexts for parallel ranking.
     * Each context has its own sequence, so they can evaluate independently.
     *
     * VRAM per context is governed by contextSize alone —
     * LlamaRankingContextOptions has no flashAttention option.
     */
    private static readonly EMBED_CONTEXT_SIZE;
    private ensureRerankContexts;
    /**
     * Tokenize text using the embedding model's tokenizer
     * Returns tokenizer tokens (opaque type from node-llama-cpp)
     */
    tokenize(text: string): Promise<readonly LlamaToken[]>;
    /**
     * Count tokens in text using the embedding model's tokenizer
     */
    countTokens(text: string): Promise<number>;
    /**
     * Detokenize token IDs back to text
     */
    detokenize(tokens: readonly LlamaToken[]): Promise<string>;
    /**
     * Truncate text to fit within the embedding model's context window.
     * Uses the model's own tokenizer for accurate token counting, then
     * detokenizes back to text if truncation is needed.
     * Returns the (possibly truncated) text and whether truncation occurred.
     */
    private resolveEmbedTokenLimit;
    private truncateToContextSize;
    embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null>;
    /**
     * Batch embed multiple texts efficiently
     * Uses Promise.all for parallel embedding - node-llama-cpp handles batching internally
     */
    embedBatch(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]>;
    /**
     * Body of embedBatch, run under an operation lease: the pooled contexts it
     * borrows cannot be disposed by an idle unload until it returns.
     */
    private embedBatchOnContexts;
    generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult | null>;
    /** Body of generate(), run under an operation lease. */
    private generateOnContext;
    modelExists(modelUri: string): Promise<ModelInfo>;
    expandQuery(query: string, options?: {
        context?: string;
        includeLexical?: boolean;
    }): Promise<Queryable[]>;
    /** Body of expandQuery(), run under an operation lease. */
    private expandQueryOnContext;
    private static readonly RERANK_TEMPLATE_OVERHEAD;
    private static readonly RERANK_TARGET_DOCS_PER_CONTEXT;
    rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult>;
    /** Body of rerank(), run under an operation lease. */
    private rerankOnContexts;
    /**
     * Get device/GPU info for status display.
     * Initializes llama if not already done.
     */
    getDeviceInfo(options?: {
        allowBuild?: boolean;
    }): Promise<{
        gpu: string | false;
        gpuOffloading: boolean;
        gpuDevices: string[];
        vram?: {
            total: number;
            used: number;
            free: number;
        };
        cpuCores: number;
    }>;
    /**
     * Terminate the instance.
     *
     * The terminal transition is synchronous and rejects new sessions and
     * operations. Already-running operations and any idle unload already in
     * progress are then awaited to ACTUAL completion before their contexts and
     * models are destroyed, so no native object is torn down while it is still
     * in use. Resource safety wins over bounded close: a stuck operation or
     * native disposal can therefore delay termination indefinitely.
     *
     * Session leases are deliberately NOT awaited: a session callback may call
     * dispose() after its awaited operation and must not deadlock itself.
     *
     * Concurrent callers share one teardown: the first performs it, every other
     * caller awaits the same completion, so none of them continues (for example
     * to close SQLite) while resources are still being drained. Calls after
     * "disposed" resolve immediately.
     */
    dispose(): Promise<void>;
    /**
     * Dispose every native resource in dependency order (terminal path only).
     * The caller owns the lifecycle transition and publishes its completion.
     */
    private teardownResources;
}
/**
 * Error thrown when an operation is attempted on a released or aborted session.
 */
export declare class SessionReleasedError extends Error {
    constructor(message?: string);
}
/**
 * Execute a function with a scoped LLM session.
 * The session provides lifecycle guarantees - resources won't be disposed mid-operation.
 *
 * @example
 * ```typescript
 * await withLLMSession(async (session) => {
 *   const expanded = await session.expandQuery(query);
 *   const embeddings = await session.embedBatch(texts);
 *   const reranked = await session.rerank(query, docs);
 *   return reranked;
 * }, { maxDuration: 10 * 60 * 1000, name: 'querySearch' });
 * ```
 */
export declare function withLLMSession<T>(fn: (session: ILLMSession) => Promise<T>, options?: LLMSessionOptions): Promise<T>;
/**
 * Execute a function with a scoped LLM session using a specific LlamaCpp instance.
 * Unlike withLLMSession, this does not use the global singleton.
 *
 * The session is counted on that instance's lifecycle, so its idle timer will
 * not unload resources while the session is open.
 */
export declare function withLLMSessionForLlm<T>(llm: LlamaCpp, fn: (session: ILLMSession) => Promise<T>, options?: LLMSessionOptions): Promise<T>;
/**
 * Check if idle unload is safe for the default LLM instance: no active
 * sessions, no in-flight operations, and no lifecycle transition in progress.
 */
export declare function canUnloadLLM(): boolean;
/**
 * Whether QMD's darwin Metal exit-crash mitigation is active in this process:
 *   true  → residency sets disabled, process exit completes silently
 *   false → either non-darwin, or `QMD_METAL_KEEP_RESIDENCY=1` overrode it,
 *           in which case the libggml-metal teardown assertion may fire
 */
export declare function isDarwinMetalMitigationActive(): boolean;
/**
 * Compatibility shim: previous releases installed a `process.on('exit')` hook
 * that tried to skip the C++ static destructor by calling `process.reallyExit`.
 * That mechanism didn't work on Node (Environment::Exit still calls libc
 * `exit()`), so it was replaced by `GGML_METAL_NO_RESIDENCY=1` from bin/qmd.
 * Kept as a no-op for code paths that still call it; safe to remove once no
 * production launcher predates the residency-set fix.
 */
export declare function installDarwinExitGuard(): void;
/** @deprecated Replaced by isDarwinMetalMitigationActive. */
export declare function isDarwinExitGuardInstalled(): boolean;
/**
 * Get the default LlamaCpp instance (creates one if needed). The LlamaCpp
 * constructor installs the darwin exit guard, so any code path that obtains
 * the singleton is protected.
 */
export declare function getDefaultLlamaCpp(): LlamaCpp;
/**
 * Set a custom default LlamaCpp instance (useful for testing). Setting a
 * non-null instance also ensures the darwin exit guard is installed — keeps
 * the invariant intact for test doubles that didn't go through the real
 * constructor.
 */
export declare function setDefaultLlamaCpp(llm: LlamaCpp | null): void;
/**
 * Peek at the default LlamaCpp instance without instantiating one. Used by
 * doctor and lifecycle diagnostics.
 */
export declare function hasDefaultLlamaCpp(): boolean;
/**
 * Dispose the default LlamaCpp instance if it exists.
 * Call this before process exit to prevent NAPI crashes.
 */
export declare function disposeDefaultLlamaCpp(): Promise<void>;
export {};
