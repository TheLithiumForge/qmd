/**
 * QMD Metadata Filter - Recursive predicate AST, strict runtime validation,
 * and parameterized SQL compilation.
 *
 * The predicate has one canonical, `operator`-discriminated recursive shape
 * shared by every public search surface (CLI, SDK, MCP, HTTP):
 *
 *   { "operator": "and", "operands": [ ... ] }
 *   { "operator": "not", "operand": { ... } }
 *   { "field": "status", "operator": "eq", "value": "published" }
 *   { "field": "topics", "operator": "prefix", "value": "sql", "caseInsensitive": true }
 *
 * A condition tests one field of the record under evaluation, named by `field`,
 * against `value` using `operator`. The grammar evaluates two kinds of record:
 *
 * - A document, whose fields are its metadata keys. This is the filter
 *   (`MetadataFilter`) every search surface accepts, and it compiles to one
 *   subquery per condition over `document_metadata_values`, correlated for
 *   a few candidates or a document set for the corpus (FilterScope).
 * - A metadata entry (one row of that table), whose fields are `key` and
 *   `value`. This is the match (`MetadataMatch`) metadata discovery accepts,
 *   and it compiles to a predicate over one row.
 *
 * Both are `MetadataPredicate`, the one recursive grammar, parameterized by
 * the conditions the record admits.
 *
 * Comparison, membership, and text operators are typed by their operand: a
 * string operand only ever compares against string values, a number against
 * numbers, a boolean against booleans, and a mismatch never matches. Every
 * user value binds as a parameter. Metadata keys and values are data, never
 * SQL.
 */
import type { MetadataScalar, MetadataScalarArray, MetadataValueType } from "./metadata.js";
/**
 * The recursive grammar: a condition, or `and`/`or`/`not` over predicates.
 * `Condition` is the set of conditions the record under evaluation admits.
 */
export type MetadataPredicate<Condition> = Condition | MetadataPredicateGroup<Condition> | MetadataPredicateNegation<Condition>;
export interface MetadataPredicateGroup<Condition> {
    operator: "and" | "or";
    operands: readonly MetadataPredicate<Condition>[];
}
export interface MetadataPredicateNegation<Condition> {
    operator: "not";
    operand: MetadataPredicate<Condition>;
}
/** A predicate over a document, whose fields are its metadata keys. */
export type MetadataFilter = MetadataPredicate<MetadataCondition>;
export type MetadataFilterGroup = MetadataPredicateGroup<MetadataCondition>;
export type MetadataFilterNegation = MetadataPredicateNegation<MetadataCondition>;
/** A predicate over a metadata entry, whose fields are `key` and `value`. */
export type MetadataMatch = MetadataPredicate<MetadataEntryCondition>;
/** The fields of a metadata entry. */
export type MetadataEntryField = "key" | "value";
/**
 * The conditions every record admits, over the fields it has.
 * `caseInsensitive` folds ASCII letters on both sides and is accepted only
 * where the operand is a string or an array of strings.
 */
type SharedMetadataCondition<Field extends string> = {
    field: Field;
    operator: "eq" | "ne";
    value: MetadataScalar;
    caseInsensitive?: boolean;
} | {
    field: Field;
    operator: "gt" | "gte" | "lt" | "lte";
    value: string | number;
    caseInsensitive?: boolean;
} | {
    field: Field;
    operator: "in" | "nin";
    value: MetadataScalarArray;
    caseInsensitive?: boolean;
} | {
    field: Field;
    operator: "contains" | "prefix" | "suffix";
    value: string;
    caseInsensitive?: boolean;
} | {
    field: Field;
    operator: "type";
    value: MetadataValueType;
};
/**
 * One condition over a document. `all` and `exists` speak about the set of
 * values a document holds under a key, so only a document admits them.
 */
export type MetadataCondition = SharedMetadataCondition<string> | {
    field: string;
    operator: "all";
    value: MetadataScalarArray;
    caseInsensitive?: boolean;
} | {
    field: string;
    operator: "exists";
    value: boolean;
};
/** One condition over a metadata entry: its `key` (a string) or its `value` (typed). */
export type MetadataEntryCondition = SharedMetadataCondition<MetadataEntryField>;
export interface CompiledMetadataFilter {
    sql: string;
    params: (string | number)[];
}
/** Which record a filter is evaluated against. */
export type MetadataRecordType = "document" | "entry";
/** Raised by parseMetadataFilter and parseMetadataMatch with the JSON path of the failing node. */
export declare class MetadataFilterError extends Error {
    readonly path: string;
    /** The message without the `Invalid metadata ... at` prefix. */
    readonly detail: string;
    constructor(path: string, detail: string, recordType?: MetadataRecordType);
}
/** Defensive limits for recursive filters from untrusted callers. */
export declare const METADATA_FILTER_LIMITS: {
    readonly maxDepth: 16;
    readonly maxNodes: 256;
    readonly maxGroupOperands: 32;
    readonly maxMembershipValues: 64;
    readonly maxKeyBytes: 128;
    readonly maxStringLength: 1024;
};
/**
 * Strictly validate an untrusted value as a MetadataFilter.
 * Rejects unknown operators, unknown properties, operator-incompatible values,
 * and inputs exceeding METADATA_FILTER_LIMITS. Canonicalizes membership value
 * arrays by de-duplicating while preserving order.
 */
export declare function parseMetadataFilter(input: unknown): MetadataFilter;
/**
 * Strictly validate an untrusted value as a match over metadata entries. Same
 * grammar and limits as parseMetadataFilter. A condition's `field` names a field
 * of the entry, `key` or `value`. `exists` and `all` have no meaning for a
 * single entry and are rejected.
 */
export declare function parseMetadataMatch(input: unknown): MetadataMatch;
/**
 * The documents a compiled filter is applied to, which decides the SQL each
 * condition takes.
 *
 * - `candidates`: a few documents, as when search checks its results. Each
 *   condition is a correlated `EXISTS` that seeks the document's own rows.
 * - `corpus`: every document, as when discovery counts them. Each condition
 *   is an uncorrelated `IN (SELECT document_id ...)` that SQLite evaluates
 *   once per statement and probes per document, where a correlated predicate
 *   would be re-run for every metadata row the statement joins.
 */
export type FilterScope = "candidates" | "corpus";
/**
 * Compile a validated filter into one parameterized SQL predicate over a
 * documents-table alias (e.g. `d`). All keys and values are bound parameters.
 * The caller is responsible for restricting the surrounding query to active
 * documents with current, error-free metadata extraction.
 */
export declare function compileMetadataFilter(filter: MetadataFilter, documentsAlias: string, scope?: FilterScope): CompiledMetadataFilter;
/**
 * Compile a validated match into one parameterized SQL predicate over a
 * `document_metadata_values` row alias (e.g. `mv`). A condition's `field` names
 * the field of the entry its operand is tested against: `key`, which is always
 * a string, or `value`, which is typed by `value_type`. The caller is
 * responsible for scoping the rows to eligible documents.
 */
export declare function compileMetadataMatch(match: MetadataMatch, valuesAlias: string): CompiledMetadataFilter;
export {};
