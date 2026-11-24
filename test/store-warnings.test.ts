/**
 * A store created with onWarning hands its warnings to the caller and prints
 * nothing. Without it, the same warnings print as before. An embed run that the
 * caller stops through its own signal reports nothing either way.
 *
 * Stand-ins replace the embedding model and node-llama-cpp, so no model loads.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type StoreOptions, type StoreWarning } from "../src/index.js";
import { setNodeLlamaCppModuleForTest } from "../src/llm.js";
import { generateEmbeddings } from "../src/store.js";

let testDir: string;
let docsDir: string;
let dbCount = 0;
const ENV = ["QMD_EXPAND_CONTEXT_SIZE", "QMD_LLAMA_GPU", "QMD_FORCE_CPU"] as const;
const savedEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-store-warnings-"));
  docsDir = join(testDir, "docs");
  await mkdir(docsDir);
  await writeFile(join(docsDir, "a.md"), "# A\n\nThe first note.\n");
  await writeFile(join(docsDir, "b.md"), "# B\n\nThe second note.\n");
});

afterAll(async () => {
  // Bun on Windows can still hold the embed lock database open here.
  await rm(testDir, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  for (const name of ENV) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of ENV) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const open = (options: Omit<StoreOptions, "dbPath"> = {}) => createStore({
  dbPath: join(testDir, `index-${++dbCount}.sqlite`),
  config: { collections: { docs: { path: docsDir, pattern: "**/*.md" } } },
  ...options,
});

/** Collects every console and stderr write until the mocks are restored. */
function captureConsole(): string[] {
  const output: string[] = [];
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });
  }
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  });
  return output;
}

/** A stand-in embedding model. With `waitForTimeLimit`, embed() returns only once the run's time limit ends it. */
function fakeModel(waitForTimeLimit = false) {
  const vector = { embedding: [0.1, 0.2, 0.3], model: "fake-embed" };
  return {
    async tokenize(text: string) {
      return new Array(Math.max(1, Math.ceil(text.length / 16))).fill(1);
    },
    async detokenize(tokens: readonly number[]) {
      return "x".repeat(tokens.length * 16);
    },
    async embed(_text: string, options?: { signal?: AbortSignal }) {
      const signal = options?.signal;
      if (waitForTimeLimit && signal && !signal.aborted) {
        await new Promise<void>((resolve) => {
          // The time limit runs on an unref'd timer, which Bun doesn't fire
          // while nothing else keeps the event loop running.
          const keepAlive = setTimeout(resolve, 10_000);
          signal.addEventListener("abort", () => {
            clearTimeout(keepAlive);
            resolve();
          }, { once: true });
        });
      }
      return vector;
    },
    async embedBatch(texts: string[]) {
      return texts.map(() => vector);
    },
  };
}

/** Creates a store with an invalid QMD_EXPAND_CONTEXT_SIZE, then embeds one document per batch past a 50 ms limit. */
async function runPastTimeLimit(options: Omit<StoreOptions, "dbPath">): Promise<void> {
  process.env.QMD_EXPAND_CONTEXT_SIZE = "many";
  const store = await open(options);
  try {
    store.internal.llm = fakeModel(true) as any;
    await store.update();
    await generateEmbeddings(store.internal, { maxDocsPerBatch: 1, maxDurationMs: 50 });
  } finally {
    await store.close();
  }
}

test("a store with onWarning hands its warnings to the handler and prints nothing", async () => {
  const output = captureConsole();
  const warnings: StoreWarning[] = [];

  await runPastTimeLimit({ onWarning: (warning) => warnings.push(warning) });

  expect(warnings).toEqual([
    {
      code: "INVALID_ENV_VALUE",
      message: `invalid QMD_EXPAND_CONTEXT_SIZE="many", using default 2048.`,
    },
    { code: "EMBED_SESSION_EXPIRED", message: "Session expired — skipping 1 remaining chunks" },
    { code: "EMBED_SESSION_EXPIRED", message: "Session expired — skipping remaining document batches" },
  ]);
  expect(output).toEqual([]);
});

test("without onWarning, the same warnings print as before", async () => {
  const output = captureConsole();

  await runPastTimeLimit({});

  expect(output).toEqual([
    `QMD Warning: invalid QMD_EXPAND_CONTEXT_SIZE="many", using default 2048.\n`,
    "⚠ Session expired — skipping 1 remaining chunks",
    "⚠ Session expired — skipping remaining document batches",
  ]);
});

test.each([
  ["with onWarning", true],
  ["without onWarning", false],
])("an embed run the caller stops through its signal reports nothing, %s", async (_label, withHandler) => {
  const output = captureConsole();
  const warnings: StoreWarning[] = [];
  const store = await open(withHandler ? { onWarning: (warning) => warnings.push(warning) } : {});
  try {
    store.internal.llm = fakeModel() as any;
    await store.update();
    const controller = new AbortController();

    const result = await store.embed({
      signal: controller.signal,
      maxDocsPerBatch: 1,
      // Stop once the first document is stored, so a later run continues with the second.
      onProgress: (info) => {
        if (info.chunksEmbedded > 0) controller.abort();
      },
    });

    expect(result.chunksEmbedded).toBe(1);
    expect(store.internal.getHashesNeedingEmbedding()).toBe(1);
  } finally {
    await store.close();
  }
  expect(warnings).toEqual([]);
  expect(output).toEqual([]);
});

test("llama.cpp log lines reach onWarning through node-llama-cpp's logger option", async () => {
  const output = captureConsole();
  const warnings: StoreWarning[] = [];
  type LoggerOptions = { logger?: (level: string, message: string) => void };
  // Stands in for node-llama-cpp. The real getLlama() passes llama.cpp's log
  // lines to `logger`, or prints them when no logger is given.
  const getLlama = vi.fn(async (options: LoggerOptions) => {
    options.logger?.("error", "llama_model_load: error loading model vocabulary\n");
    options.logger?.("info", "llama_context: n_ctx = 2048\n");
    return { gpu: "metal", dispose: async () => {} };
  });
  setNodeLlamaCppModuleForTest({
    getLlama,
    LlamaLogLevel: { error: "error" },
    resolveModelFile: vi.fn(),
    LlamaChatSession: vi.fn(),
  } as any);
  try {
    const withHandler = await open({ onWarning: (warning) => warnings.push(warning) });
    const withoutHandler = await open();
    try {
      // Loads the llama.cpp runtime, as the first model call does.
      await (withHandler.internal.llm as any).ensureLlama();
      await (withoutHandler.internal.llm as any).ensureLlama();
    } finally {
      await Promise.all([withHandler.close(), withoutHandler.close()]);
    }
  } finally {
    setNodeLlamaCppModuleForTest(null);
  }

  expect(warnings).toEqual([
    { code: "LLAMA_CPP_LOG", message: "llama_model_load: error loading model vocabulary" },
  ]);
  expect(output).toEqual([]);
  // Without onWarning, getLlama() gets no logger and keeps its console logger.
  expect(getLlama.mock.calls[1]![0]).not.toHaveProperty("logger");
});

test("createStore rejects an onWarning that is not a function", async () => {
  await expect(open({ onWarning: "console" as any })).rejects.toThrow("onWarning must be a function");
});
