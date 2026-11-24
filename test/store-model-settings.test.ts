import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createStore, type QMDStore, type StoreOptions } from "../src/index.js";
import { DEFAULT_GENERATE_MODEL_URI, DEFAULT_RERANK_MODEL_URI } from "../src/llm.js";

const ENV = ["QMD_GENERATE_MODEL", "QMD_RERANK_MODEL", "QMD_EXPAND_CONTEXT_SIZE", "QMD_RERANK_CONTEXT_SIZE"] as const;
const savedEnv = new Map<string, string | undefined>();

const open = (options: Omit<StoreOptions, "dbPath"> = {}) => createStore({ dbPath: ":memory:", ...options });

/** The four model settings a store resolved. The context sizes have no getter, so this reads the fields. */
function modelSettings(store: QMDStore) {
  const llm = store.internal.llm!;
  const fields = llm as any;
  return {
    generate: llm.generateModelName,
    rerank: llm.rerankModelName,
    expandContextSize: fields.expandContextSize,
    rerankContextSize: fields.rerankContextSize,
  };
}

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

test("a store configured in code reads none of the four model variables", async () => {
  process.env.QMD_GENERATE_MODEL = "env-generate.gguf";
  process.env.QMD_RERANK_MODEL = "env-rerank.gguf";
  process.env.QMD_EXPAND_CONTEXT_SIZE = "not-a-number";
  process.env.QMD_RERANK_CONTEXT_SIZE = "8192";
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const store = await open({
    config: { collections: {}, models: { generate: "generate.gguf", rerank: "rerank.gguf" } },
    llm: { expandContextSize: 1024, rerankContextSize: 2048 },
  });
  try {
    expect(modelSettings(store)).toEqual({
      generate: "generate.gguf",
      rerank: "rerank.gguf",
      expandContextSize: 1024,
      rerankContextSize: 2048,
    });
    // The invalid QMD_EXPAND_CONTEXT_SIZE is never parsed, so it prints no warning.
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).not.toContain("QMD_EXPAND_CONTEXT_SIZE");
  } finally {
    await store.close();
  }
});

test("without options, each store reads the variables when it is created", async () => {
  const defaults = await open();
  // The module loaded before these were set, so only a read at creation sees them.
  process.env.QMD_GENERATE_MODEL = "env-generate.gguf";
  process.env.QMD_RERANK_MODEL = "env-rerank.gguf";
  process.env.QMD_EXPAND_CONTEXT_SIZE = "3072";
  process.env.QMD_RERANK_CONTEXT_SIZE = "8192";
  const fromEnv = await open();

  try {
    expect(modelSettings(defaults)).toEqual({
      generate: DEFAULT_GENERATE_MODEL_URI,
      rerank: DEFAULT_RERANK_MODEL_URI,
      expandContextSize: 2048,
      rerankContextSize: 4096,
    });
    expect(modelSettings(fromEnv)).toEqual({
      generate: "env-generate.gguf",
      rerank: "env-rerank.gguf",
      expandContextSize: 3072,
      rerankContextSize: 8192,
    });
  } finally {
    await Promise.all([defaults.close(), fromEnv.close()]);
  }
});

test.each([
  ["expandContextSize", 0],
  ["rerankContextSize", 0],
  ["rerankContextSize", 1.5],
] as const)("createStore rejects llm.%s = %s", async (name, value) => {
  await expect(open({ llm: { [name]: value } })).rejects.toThrow(`Invalid ${name}`);
});
