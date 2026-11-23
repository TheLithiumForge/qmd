export interface CommandProcessorSpec {
    command: string[];
    version: string;
    timeoutMs?: number;
}
export interface ProcessorInput {
    version: 1;
    collection: string;
    relativePath: string;
    hash: string;
    modifiedAt: string;
    bytes: Uint8Array;
}
export interface ProcessorDocument {
    key: string;
    markdown: string;
}
export interface DocumentProcessor {
    /** Must change whenever implementation or configuration changes. */
    fingerprint: string;
    process(input: ProcessorInput, signal: AbortSignal): Promise<readonly ProcessorDocument[]>;
}
export declare const PROCESSOR_INPUT_LIMIT: number;
export declare class ProcessorFailure extends Error {
    readonly code: string;
    constructor(code: string);
}
export declare function copyCommandProcessorSpec(value: unknown): Readonly<CommandProcessorSpec>;
export declare function processorFingerprint(value: unknown): string;
export declare function snapshotProcessor(processor: DocumentProcessor): Readonly<DocumentProcessor>;
export declare function validateProcessorDocuments(value: unknown): readonly ProcessorDocument[];
/** Bounds asynchronous callbacks; synchronous CPU loops cannot be interrupted. */
export declare function executeProcessor(processor: DocumentProcessor, input: ProcessorInput, signal?: AbortSignal): Promise<readonly ProcessorDocument[]>;
/** Explicit opt-in to executing an argv command; this is not an OS sandbox. */
export declare function createCommandProcessor(spec: CommandProcessorSpec, options: {
    cwd: string;
}): DocumentProcessor;
