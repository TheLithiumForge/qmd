import type { RerankDocument, RerankResult } from "./llm.js";
export declare const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export type JevRerankOptions = {
    revision?: string;
    /** Environment variable NAME, never a credential value. Default: TYPESAFE_API_KEY. */
    apiKeyEnv?: string;
};
export declare function isJevModel(uri: string): boolean;
export declare function parseJevModel(uri: string): string;
export declare function copyJevRerankOptions(options: JevRerankOptions): Readonly<JevRerankOptions>;
export declare class JevReranker {
    private readonly model;
    private readonly options;
    readonly modelName: string;
    constructor(uri: string, options?: JevRerankOptions);
    rerank(query: string, documents: RerankDocument[], callerSignal?: AbortSignal): Promise<RerankResult>;
}
