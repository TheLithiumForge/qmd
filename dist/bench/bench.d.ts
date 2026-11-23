/**
 * QMD Benchmark Harness
 *
 * Runs queries from a fixture file against multiple search backends
 * and measures precision@k, recall, MRR, F1, and latency.
 *
 * Usage:
 *   qmd bench <fixture.json> [--json] [--collection <name>]
 *
 * Backends tested:
 *   - bm25: BM25 keyword search (searchLex)
 *   - vector: Vector similarity search (searchVector)
 *   - hybrid: BM25 + vector RRF fusion without reranking
 *   - full: Full hybrid pipeline with LLM reranking
 */
import type { BenchmarkResult } from "./types.js";
export type BenchCollectionInfo = {
    name: string;
    active_count: number;
};
/**
 * Fail fast when the fixture's collection is missing or empty so `qmd bench`
 * does not spend minutes printing a wall of 0.00 (#716).
 */
export declare function assertBenchCollectionReady(collections: BenchCollectionInfo[], collection?: string): void;
export declare function benchSummaryAllZero(summary: BenchmarkResult["summary"]): boolean;
export declare function allZeroBenchWarning(collection?: string): string;
export declare function runBenchmark(fixturePath: string, options?: {
    json?: boolean;
    collection?: string;
    backends?: string[];
    dbPath?: string;
    configPath?: string;
    config?: import("../collections.js").CollectionConfig;
}): Promise<BenchmarkResult>;
