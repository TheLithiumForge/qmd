import type { Database } from "./db.js";
import { scanWriteBatch, type ReindexResult, type ReindexProgress } from "./store.js";
import { type DocumentProcessor } from "./processors.js";
export declare function initializeProcessorSchema(db: Database): void;
export declare function hasProcessorMode(db: Database, collection: string): boolean;
export declare function requireProcessor(db: Database, collection: string, declared: boolean, processor?: DocumentProcessor): void;
export declare function removeProcessorState(db: Database, collection: string): void;
export declare function renameProcessorState(db: Database, oldName: string, newName: string): void;
/** Called only after successful root validation and complete enumeration. */
export declare function reindexProcessedFiles(db: Database, batch: ReturnType<typeof scanWriteBatch>, root: string, collection: string, files: string[], processor: DocumentProcessor, options?: {
    signal?: AbortSignal;
    onProgress?: (info: ReindexProgress) => void;
}): Promise<ReindexResult>;
