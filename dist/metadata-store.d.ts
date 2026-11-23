/**
 * QMD Metadata Store - Schema, persistence, and batch loading for document
 * metadata.
 *
 * Metadata attaches to document identity (`documents.id`), not content
 * identity: two paths can share one content hash while carrying different
 * metadata. SQLite stays a derived index — metadata is rebuilt from source
 * documents on `qmd update`, never mutated in place.
 *
 * `document_metadata` records extraction state per document (including
 * successful-but-empty extraction), so filtered search can distinguish
 * "extracted with no metadata" from "not yet extracted" and "extraction
 * failed". `document_metadata_values` holds one indexed row per scalar value
 * for filtering.
 */
import type { Database } from "./db.js";
import { type DocumentMetadata, type MetadataExtractionResult, type MetadataScalar, type MetadataValueType } from "./metadata.js";
import { type MetadataFilter, type MetadataMatch } from "./metadata-filter.js";
export declare function initializeMetadataSchema(db: Database): void;
/**
 * Extract and persist metadata for one document, replacing any prior rows.
 *
 * With `onlyIfStale`, extraction is skipped when the document already has a
 * current-version extraction row — the cheap path for unchanged documents
 * during re-index. Returns the extraction result, or null when skipped.
 */
export declare function syncDocumentMetadata(db: Database, documentId: number, content: string, path: string, options?: {
    onlyIfStale?: boolean;
}): MetadataExtractionResult | null;
/**
 * Replace a document's metadata rows atomically. A failed extraction persists
 * empty metadata plus the error, so stale metadata never survives a bad edit.
 */
export declare function replaceDocumentMetadata(db: Database, documentId: number, extraction: MetadataExtractionResult): void;
/**
 * Count active documents without a current, error-free metadata extraction.
 * These documents are excluded from filtered search until `qmd update` runs.
 * Scoped to `collectionNames` when given, otherwise the whole index.
 */
export declare function countDocumentsPendingMetadata(db: Database, collectionNames?: string[]): number;
/**
 * Batch-load canonical metadata for a set of result filepaths
 * (`qmd://collection/path`). One query — never per-result lookups.
 */
export declare function getMetadataByFilepath(db: Database, filepaths: readonly string[]): Map<string, DocumentMetadata>;
/** Parse a stored `metadata_json` column value, tolerating absent rows. */
export declare function parseMetadataJson(metadataJson: string | null | undefined): DocumentMetadata;
export interface ListMetadataOptions {
    /** Restrict to these collections. Undefined means every collection in the index. */
    collection?: string | string[];
    /**
     * Report only the metadata entries matching this condition. Same grammar as
     * `filter`, evaluated against each entry: a condition's `field` names the
     * entry's `key` or `value`. Undefined reports every entry.
     */
    match?: MetadataMatch;
    /** Count only documents matching this filter. Same AST as search. */
    filter?: MetadataFilter;
    /** Keys reported (default 50). `Infinity` removes the window. */
    keyLimit?: number;
    /** Keys skipped before the window, in report order (default 0). */
    keyOffset?: number;
    /** Values reported per key and type (default 10). `Infinity` removes the window. */
    valueLimit?: number;
    /** Values skipped per key and type before the window, in `sort` order (default 0). */
    valueOffset?: number;
    /** Order of values within a key (default "count"). */
    sort?: "count" | "value";
    /** Drop values held by fewer documents than this (default 1). */
    minCount?: number;
}
export interface ListMetadataResult {
    /** Active documents in scope. */
    documents: number;
    /**
     * Documents in scope that pass `filter`. Present only when a filter was
     * given, and then the denominator for every coverage count.
     */
    filteredDocuments?: number;
    /** Keys with a matching entry, before the key window. */
    totalKeys: number;
    /** The key window, by documents descending then key ascending. */
    keys: MetadataKeySummary[];
    /** Keys after the window: `totalKeys - keyOffset - keys.length`, floored at 0. */
    remainingKeys: number;
}
export interface MetadataKeySummary {
    key: string;
    /** Distinct documents holding a matching entry under any type. */
    documents: number;
    /** One entry per value_type present. Length > 1 is a type conflict. */
    types: MetadataKeyTypeSummary[];
}
export interface MetadataKeyTypeSummary {
    type: MetadataValueType;
    /**
     * True when any document holds more than one value for this key. A
     * one-element array is indistinguishable from a scalar in the index.
     */
    multiValued: boolean;
    /** Distinct documents holding a matching value of this type. */
    documents: number;
    /** Distinct matching values that meet `minCount`. */
    distinctValues: number;
    /** The value window, narrowed by `match` and `minCount`, ordered by `sort`. */
    values: MetadataValueCount[];
    /** Distinct values after the window: `distinctValues - valueOffset - values.length`, floored at 0. */
    remainingValues: number;
    /** Numbers only. Computed over every matching value row, so array elements each count. */
    range?: {
        min: number;
        median: number;
        max: number;
    };
    /** Collections contributing a matching value of this type, ascending. */
    collections: string[];
}
export interface MetadataValueCount {
    value: MetadataScalar;
    documents: number;
}
/** The light form of a key summary for status views: name, coverage, and types, no values. */
export interface MetadataKeyOverview {
    key: string;
    /** Distinct documents declaring the key with any type. */
    documents: number;
    /** By documents descending then name. Length > 1 is a type conflict. */
    types: MetadataValueType[];
}
/** Exact vocabulary size and a bounded key overview, computed together. */
export interface MetadataOverview {
    totalKeys: number;
    keys: MetadataKeyOverview[];
}
export declare const DEFAULT_METADATA_KEY_LIMIT = 50;
export declare const DEFAULT_METADATA_VALUE_LIMIT = 10;
/**
 * Application budget for the bound parameters of one discovery statement, under
 * SQLite's default variable limit (32,766) with headroom. A filter and a match
 * each pass the parser's own limits independently, and the match is bound
 * twice (once to rank keys, once to aggregate), so the combination is checked
 * here, before any statement is prepared.
 */
export declare const METADATA_SQL_BINDING_BUDGET = 30000;
/** Raised by listMetadata when an option is outside its domain. */
export declare class MetadataOptionError extends Error {
    readonly option: string;
    constructor(option: string, expected: string, received: unknown);
}
/** Raised by listMetadata when `filter` and `match` together bind more SQL parameters than the budget. */
export declare class MetadataBindingBudgetError extends Error {
    readonly bindings: number;
    readonly budget: number;
    constructor(bindings: number, budget: number);
}
/**
 * Summarize metadata keys, types, and value counts for the documents in
 * scope. Discovery sees exactly what filtering sees: the same extraction gate,
 * active-document rule, and collection scope, so every value reported here is
 * a value an `eq` filter can match.
 *
 * `filter` selects which documents are counted. `match` selects which of their
 * metadata entries are reported, with the same grammar evaluated per entry.
 * Counts are documents, not values: a document with `topics: [a, b]`
 * contributes one to each.
 *
 * The key window limits which keys receive detailed aggregation and the value
 * window limits the values returned per key and type. Exact counts, medians,
 * and ordering still process the relevant rows. These windows do not bound
 * database work, temporary storage, or the contributing collection lists.
 *
 * The report is read inside one deferred transaction, so every count comes
 * from the same database snapshot even while another connection writes.
 */
export declare function listMetadata(db: Database, options?: ListMetadataOptions): ListMetadataResult;
/**
 * Every collection's key names, coverage, and types, in coverage order,
 * windowed to the first `keyLimit` keys per collection. One GROUP BY, no
 * values: what `collection list`, `status`, and the MCP status tool print so
 * a first look reveals that metadata exists.
 */
export declare function listMetadataCollectionSummaries(db: Database, keyLimit?: number): Map<string, MetadataOverview>;
/** Distinct metadata keys declared by active, extracted documents in scope. */
export declare function countMetadataKeys(db: Database, collectionNames?: string[]): number;
/** Active, extracted documents in scope that declare at least one metadata key. */
export declare function countDocumentsWithMetadata(db: Database, collectionNames?: string[]): number;
