/**
 * QMD Metadata Format - Plain-text rendering of metadata discovery results.
 *
 * Shared by the CLI and the MCP `metadata` tool so both print one shape: a
 * filter line when a filter narrowed the documents, a header per key, a body
 * per type, and footers naming the remainder and the options that reach it
 * whenever a value list or the key list is windowed. The empty states render
 * here too, so the filter line survives them.
 *
 * String values print bare only when the bare form is unambiguous. A value
 * that is empty, padded, contains a quote, a backslash, a control character,
 * a line separator, or a delimiter of the compact `value (count), ...` list,
 * or that reads as a JSON number, boolean, or null, or as the list's
 * remainder tail, is printed as a JSON string, so what the reader sees is
 * exactly the value.
 */
import type { ListMetadataResult } from "./metadata-store.js";
export interface MetadataFormatColors {
    reset: string;
    dim: string;
    bold: string;
    cyan: string;
}
export interface FormatMetadataOptions {
    /** Show which collections contribute each type on type-split keys. */
    showCollections?: boolean;
    /** How the caller widens or pages the value window, e.g. `--value-limit <n>, --value-offset <n>, or --all-values`. */
    valueWindowHint: string;
    /** How the caller widens or pages the key window, e.g. `--key-limit <n>, --key-offset <n>, or --all-keys`. */
    keyWindowHint: string;
    /** The key offset the caller requested, and how the caller spells that option, e.g. `--key-offset`. */
    keyOffset: number;
    keyOffsetLabel: string;
    /** Printed in place of the key blocks when no metadata entry is in the result at all. */
    emptyMessage: string;
    /** ANSI sequences; omit for plain text. */
    colors?: MetadataFormatColors;
}
/**
 * Render the whole result: the filter line when a filter is in play, then
 * one block per key separated by blank lines and the key footer when keys
 * were left out of the window, or the one-line empty state when there are no
 * blocks to show.
 */
export declare function formatMetadataKeySummaries(result: ListMetadataResult, options: FormatMetadataOptions): string;
export interface FormatMetadataOverviewOptions {
    /** Active, extracted documents declaring at least one key. */
    documentsWithMetadata: number;
    /** Active documents awaiting extraction, mentioned so the coverage reads honestly. */
    pendingMetadata: number;
    /** Command that shows the rest, e.g. `qmd collection metadata notes`. */
    drillDownHint: string;
    colors?: MetadataFormatColors;
}
/**
 * The `Metadata:` section of `collection show`: a coverage line, then the
 * keys in the result's window as aligned rows with a short value preview,
 * then a pointer at the drill-down when keys were left out. Indented to sit
 * under the other `show` fields.
 */
export declare function formatMetadataOverview(result: ListMetadataResult, options: FormatMetadataOverviewOptions): string;
