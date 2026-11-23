export type RemoteEmbedOptions = {
    dimensions?: number;
    revision?: string;
    /** Environment variable NAME, never a credential value. Absent means keyless. */
    apiKeyEnv?: string;
};
export declare function isRemoteEmbedModel(uri: string): boolean;
export declare function copyRemoteEmbedOptions(options: RemoteEmbedOptions): Readonly<RemoteEmbedOptions>;
export declare function parseRemoteEmbedUri(uri: string): Readonly<{
    apiBase: string;
    modelId: string;
}>;
/** No tokenizer, model discovery, normalization, fallback, or implicit auth. */
export declare class RemoteEmbedder {
    private readonly endpoint;
    private readonly options;
    readonly modelName: string;
    constructor(uri: string, options?: RemoteEmbedOptions);
    embedBatch(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}
