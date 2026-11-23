import { test, expect, vi } from "vitest";
import { createStore } from "../src/index.js";
import { formatQueryForEmbedding } from "../src/store.js";

test("one formatted query embedding can be reused across collections and refills", async () => {
  const store = await createStore({ dbPath: ":memory:" });
  const now = new Date().toISOString();
  try {
    store.internal.ensureVecTable(3);
    store.internal.insertContent("hash", "body", now);
    for (const collection of ["docs", "notes"]) {
      store.internal.insertDocument(collection, "a.md", "A", "hash", now, now);
    }
    store.internal.insertEmbedding("hash", 0, 0, new Float32Array([1, 0, 0]), "test", now);
    const embed = vi.spyOn(store.internal.llm!, "embed").mockResolvedValue({ embedding: [1, 0, 0], model: "test" });
    const embedding = await store.embedQuery("query");
    expect(embedding).toEqual([1, 0, 0]);
    expect(embed).toHaveBeenCalledWith(
      formatQueryForEmbedding("query", store.internal.llm!.embedModelName),
      expect.objectContaining({ model: store.internal.llm!.embedModelName, isQuery: true }),
    );
    for (const limit of [1, 10]) {
      const hits = await store.searchVector("query", { collection: ["docs", "notes"], limit, embedding: embedding! });
      expect(hits).toHaveLength(Math.min(limit, 2));
    }
    expect(embed).toHaveBeenCalledTimes(1);
    embed.mockResolvedValue(null);
    expect(await store.embedQuery("failed")).toBeNull();
  } finally {
    await store.close();
  }
});

test("close() waits for a running embedQuery() before it releases the models", async () => {
  const store = await createStore({ dbPath: ":memory:" });
  const llm = store.internal.llm!;
  const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();
  const { promise: entered, resolve: signalEntered } = Promise.withResolvers<void>();
  vi.spyOn(llm, "embed").mockImplementation(async () => {
    signalEntered();
    await gate;
    return { embedding: [1, 0, 0], model: "test" };
  });
  const dispose = vi.spyOn(llm, "dispose");
  try {
    const embedding = store.embedQuery("query");
    await entered;
    const closing = store.close();
    const early = await Promise.race([closing.then(() => "closed"), new Promise(resolve => setTimeout(resolve, 50, "pending"))]);
    expect(early).toBe("pending");
    expect(dispose).not.toHaveBeenCalled();
    openGate();
    expect(await embedding).toEqual([1, 0, 0]);
    await closing;
    expect(dispose).toHaveBeenCalledTimes(1);
  } finally {
    openGate();
    await store.close();
  }
});

test("an abort signal stops embedQuery() before and during the model call", async () => {
  const store = await createStore({ dbPath: ":memory:" });
  const { promise: entered, resolve: signalEntered } = Promise.withResolvers<void>();
  const embed = vi.spyOn(store.internal.llm!, "embed").mockImplementation((_text, options) => {
    signalEntered();
    return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    });
  });
  try {
    // A signal that is already aborted fails the call without a model call.
    await expect(store.embedQuery("query", { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(embed).not.toHaveBeenCalled();

    // A signal aborted during the call reaches the model call and fails it.
    const controller = new AbortController();
    const embedding = store.embedQuery("query", { signal: controller.signal });
    await entered;
    controller.abort(new Error("caller gave up"));
    await expect(embedding).rejects.toThrow("caller gave up");
    expect(embed).toHaveBeenCalledTimes(1);
  } finally {
    await store.close();
  }
});
