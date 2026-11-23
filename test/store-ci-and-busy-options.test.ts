import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type QMDStore } from "../src/index.js";
import { setNodeLlamaCppModuleForTest, type LlamaCpp } from "../src/llm.js";

const ENV = ["CI", "QMD_SQLITE_BUSY_TIMEOUT"] as const;
const CI_ERROR = "LLM operations are disabled in CI";
const savedEnv = new Map<string, string | undefined>();
let dir: string;

function setEnv(name: (typeof ENV)[number], value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Stand in for node-llama-cpp. Loading the runtime fails, so no model ever loads. */
function recordRuntimeLoads() {
  const getLlama = vi.fn(async () => {
    throw new Error("no llama.cpp runtime in this test");
  });
  setNodeLlamaCppModuleForTest({
    LlamaLogLevel: { error: "error" },
    LlamaChatSession: vi.fn() as any,
    resolveModelFile: vi.fn() as any,
    getLlama: getLlama as any,
  });
  return getLlama;
}

function busyTimeout(store: QMDStore): number {
  const row = store.internal.db.prepare("PRAGMA busy_timeout").get() as Record<string, number>;
  return Object.values(row)[0]!;
}

beforeEach(() => {
  for (const name of ENV) savedEnv.set(name, process.env[name]);
  dir = mkdtempSync(join(tmpdir(), "qmd-ci-busy-options-"));
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  setNodeLlamaCppModuleForTest(null);
  for (const name of ENV) setEnv(name, savedEnv.get(name));
  rmSync(dir, { recursive: true, force: true });
});

const operations: Record<string, (llm: LlamaCpp) => Promise<unknown>> = {
  embedBatch: llm => llm.embedBatch(["hello"]),
  generate: llm => llm.generate("hello"),
  expandQuery: llm => llm.expandQuery("hello"),
  rerank: llm => llm.rerank("hello", [{ file: "a.md", text: "hello" }]),
};

/** The error message of a failed call, or "" when it resolves. */
const failure = (call: Promise<unknown>) => call.then(() => "", (error: Error) => error.message);

test.each(Object.keys(operations))("%s follows CI by default and runs in CI with llm.allowInCI", async (name) => {
  const operation = operations[name]!;
  const loads = recordRuntimeLoads();
  setEnv("CI", undefined);
  const local = await createStore({ dbPath: ":memory:" });
  setEnv("CI", "1");
  const ci = await createStore({ dbPath: ":memory:" });
  const allowed = await createStore({ dbPath: ":memory:", llm: { allowInCI: true } });

  try {
    // Default with CI set: the guard throws before any runtime load.
    expect(await failure(operation(ci.internal.llm!))).toContain(CI_ERROR);
    expect(loads).not.toHaveBeenCalled();

    // Default without CI, and the option with CI set: the call passes the guard
    // and goes on to load the runtime, which the stand-in refuses.
    for (const store of [local, allowed]) {
      loads.mockClear();
      expect(await failure(operation(store.internal.llm!))).not.toContain(CI_ERROR);
      expect(loads).toHaveBeenCalled();
    }
  } finally {
    await Promise.all([local, ci, allowed].map(store => store.close()));
  }
});

test.each([
  // [QMD_SQLITE_BUSY_TIMEOUT, busyTimeoutMs, expected]
  [undefined, undefined, 120_000],
  ["750", undefined, 750],
  [undefined, 250, 250],
  ["750", 250, 250],
  ["750", 0, 0],
] as const)("QMD_SQLITE_BUSY_TIMEOUT=%s with busyTimeoutMs=%s gives %s ms", async (env, option, expected) => {
  setEnv("QMD_SQLITE_BUSY_TIMEOUT", env);
  const store = await createStore({ dbPath: ":memory:", busyTimeoutMs: option });
  try {
    expect(busyTimeout(store)).toBe(expected);
  } finally {
    await store.close();
  }
});

test("stores on one database keep their own busy timeout", async () => {
  setEnv("QMD_SQLITE_BUSY_TIMEOUT", undefined);
  const dbPath = join(dir, "index.sqlite");
  const first = await createStore({ dbPath, busyTimeoutMs: 50 });
  const second = await createStore({ dbPath });
  try {
    expect([busyTimeout(first), busyTimeout(second)]).toEqual([50, 120_000]);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test.each([-1, 1.5, Number.NaN])("createStore rejects busyTimeoutMs = %s", async (value) => {
  await expect(createStore({ dbPath: ":memory:", busyTimeoutMs: value })).rejects.toThrow("Invalid busyTimeoutMs");
});
