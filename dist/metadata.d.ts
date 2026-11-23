/**
 * QMD Metadata - Public metadata types and frontmatter extraction.
 *
 * Documents opt into metadata through a namespaced Markdown frontmatter block:
 *
 *   ---
 *   qmd:
 *     metadata:
 *       topics:
 *         - typescript
 *         - programming
 *       status: published
 *   ---
 *
 * Extraction is source-agnostic at the persistence boundary: this module
 * produces a canonical `MetadataExtractionResult`, and future non-frontmatter
 * sources can produce the same shape without touching storage or filtering.
 *
 * The raw document is never modified — frontmatter stays part of the stored,
 * indexed, chunked, and embedded content.
 */
export type MetadataScalar = string | number | boolean;
/** The stored type of one metadata value. Arrays are homogeneous, so a key holds one type per document. */
export type MetadataValueType = "string" | "number" | "boolean";
export type MetadataScalarArray = readonly string[] | readonly number[] | readonly boolean[];
export type MetadataValue = MetadataScalar | MetadataScalarArray;
export type DocumentMetadata = Record<string, MetadataValue>;
/**
 * Result of extracting metadata from one document.
 *
 * `error` is set when the document opted into `qmd.metadata` but the value was
 * invalid — the document still indexes normally, but it is excluded from
 * filtered search until the metadata is corrected and re-indexed.
 */
export interface MetadataExtractionResult {
    metadata: DocumentMetadata;
    error?: string;
    extractionVersion: number;
}
/**
 * Bump when extraction or normalization semantics change so existing rows are
 * re-extracted on the next `qmd update`.
 */
export declare const METADATA_EXTRACTION_VERSION = 1;
/** Defensive limits for metadata from untrusted repositories. */
export declare const METADATA_LIMITS: {
    readonly maxFrontmatterBytes: number;
    readonly maxKeys: 64;
    readonly maxKeyBytes: 128;
    readonly maxStringLength: 1024;
    readonly maxArrayLength: 128;
    readonly maxYamlAliasCount: 100;
    readonly maxErrorLength: 200;
};
/**
 * Extract `qmd.metadata` from a document's leading YAML frontmatter.
 *
 * Never throws. A document without frontmatter, without a `qmd` namespace, or
 * with a non-frontmatter extension yields empty metadata with no error.
 * Invalid frontmatter or invalid metadata yields empty metadata plus a bounded
 * extraction error.
 */
export declare function extractDocumentMetadata(content: string, path: string): MetadataExtractionResult;
