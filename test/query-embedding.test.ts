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
    const embed = vi.spyOn(store.internal.llm!, "embed").mockResolvedValue({ embedding: [1, 0, 0] } as any);
    const embedding = await store.embedQuery("query");
    expect(embedding).toEqual([1, 0, 0]);
    expect(embed).toHaveBeenCalledWith(formatQueryForEmbedding("query", store.internal.llm!.embedModelName), {
      model: store.internal.llm!.embedModelName, isQuery: true,
    });
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
