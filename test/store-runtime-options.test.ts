import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createStore, type StoreLlmOptions } from "../src/index.js";
import { setLlamaDirWritableForTest, setNodeLlamaCppModuleForTest } from "../src/llm.js";

const ENV = ["QMD_LLAMA_GPU", "QMD_FORCE_CPU", "QMD_EMBED_PARALLELISM"] as const;
const savedEnv = new Map<string, string | undefined>();
let cacheRoot: string;

type Load = { runtime: unknown; file: unknown; model: unknown; contexts: unknown[] };

/** Stand in for node-llama-cpp and record what each embedding model was loaded with. */
function recordModelLoads(): Map<string, Load> {
  const loads = new Map<string, Load>();
  const files = new Map<string, unknown>();
  setNodeLlamaCppModuleForTest({
    LlamaLogLevel: { error: "error" },
    LlamaChatSession: vi.fn() as any,
    resolveModelFile: async (model, options) => {
      files.set(model, options);
      return join((options as { directory: string }).directory, model);
    },
    getLlama: async (runtime) => ({
      gpu: runtime.gpu,
      cpuMathCores: 8,
      getVramState: async () => ({ total: 0, used: 0, free: 0 }),
      dispose: async () => {},
      loadModel: async (model: { modelPath: string }) => {
        const name = basename(model.modelPath);
        const contexts: unknown[] = [];
        loads.set(name, { runtime, file: files.get(name), model, contexts });
        return {
          trainContextSize: 8192,
          tokenize: (text: string) => Array.from(text),
          dispose: async () => {},
          createEmbeddingContext: async (context: unknown) => {
            contexts.push(context);
            return { getEmbeddingFor: async () => ({ vector: [1, 0, 0] }), dispose: async () => {} };
          },
        };
      },
    }) as any,
  });
  // After the module double: installing it clears the writability override.
  setLlamaDirWritableForTest(true);
  return loads;
}

beforeEach(() => {
  for (const name of ENV) savedEnv.set(name, process.env[name]);
  cacheRoot = mkdtempSync(join(tmpdir(), "qmd-runtime-options-"));
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  setLlamaDirWritableForTest(undefined);
  setNodeLlamaCppModuleForTest(null);
  for (const name of ENV) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(cacheRoot, { recursive: true, force: true });
});

test("stores in one process keep separate model runtime options", async () => {
  process.env.QMD_LLAMA_GPU = "metal";
  delete process.env.QMD_FORCE_CPU;
  process.env.QMD_EMBED_PARALLELISM = "2";
  const loads = recordModelLoads();
  const cache = (name: string) => join(cacheRoot, name);
  const open = (model: string, llm: StoreLlmOptions) =>
    createStore({ dbPath: ":memory:", config: { collections: {}, models: { embed: model } }, llm });

  const stores = await Promise.all([
    // Every option set: each one wins over its environment variable.
    open("options.gguf", {
      modelCacheDir: cache("options"), skipDownload: true, gpu: "vulkan", embedParallelism: 3, embedContextSize: 512,
    }),
    // CPU by option while the environment asks for a GPU.
    open("cpu.gguf", { modelCacheDir: cache("cpu"), gpu: false, embedContextSize: 1024 }),
    // No runtime option besides the cache folder: the environment still applies.
    open("env.gguf", { modelCacheDir: cache("env") }),
  ]);

  try {
    const embedded = await Promise.all(stores.map(store => store.internal.llm!.embed("hello")));
    expect(embedded.map(result => result?.embedding)).toEqual(stores.map(() => [1, 0, 0]));

    expect(loads.get("options.gguf")).toEqual({
      runtime: expect.objectContaining({ gpu: "vulkan", build: "never", skipDownload: true }),
      file: { directory: cache("options"), cli: false, download: false },
      model: { modelPath: join(cache("options"), "options.gguf") },
      contexts: Array(3).fill({ contextSize: 512, batchSize: 512 }),
    });
    expect(loads.get("cpu.gguf")).toEqual({
      runtime: expect.objectContaining({ gpu: false }),
      file: { directory: cache("cpu"), cli: false },
      model: { modelPath: join(cache("cpu"), "cpu.gguf"), gpuLayers: 0 },
      contexts: Array(2).fill({ contextSize: 1024, batchSize: 1024, threads: 4 }),
    });
    expect(loads.get("env.gguf")).toEqual({
      runtime: expect.objectContaining({ gpu: "metal", build: "auto", skipDownload: false }),
      file: { directory: cache("env"), cli: false },
      model: { modelPath: join(cache("env"), "env.gguf") },
      contexts: Array(2).fill({ contextSize: expect.any(Number), batchSize: expect.any(Number) }),
    });
  } finally {
    await Promise.all(stores.map(store => store.close()));
  }
});

test.each([
  ["embedParallelism", 0],
  ["embedContextSize", 1.5],
] as const)("createStore rejects llm.%s = %s", async (name, value) => {
  await expect(createStore({ dbPath: ":memory:", llm: { [name]: value } })).rejects.toThrow(`Invalid ${name}`);
});
