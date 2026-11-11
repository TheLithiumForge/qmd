import { test, expect, vi } from "vitest";
import { createStore } from "../src/index.js";

test("search hydration switches keep paths and scores across collections", async () => {
  const store = await createStore({ dbPath: ":memory:", config: { collections: {
    docs: { path: "/docs", context: { "/": "Docs context" } },
    notes: { path: "/notes", context: { "/": "Notes context" } },
  } } });
  const now = new Date().toISOString();
  try {
    store.internal.ensureVecTable(3);
    for (const collection of ["docs", "notes"]) {
      const body = `# Authentication\nAuthentication in ${collection}`;
      store.internal.insertContent(collection, body, now);
      store.internal.insertDocument(collection, "auth.md", "Authentication", collection, now, now);
      store.internal.insertEmbedding(collection, 0, 0, new Float32Array([1, 0, 0]), "test", now);
    }
    vi.spyOn(store.internal.llm!, "embed").mockResolvedValue({ embedding: [1, 0, 0] } as any);
    for (const search of [store.searchLex, store.searchVector]) {
      const full = await search("authentication", { collection: ["docs", "notes"] });
      expect(full).toHaveLength(2);
      expect(full.every(hit => hit.body && hit.context && hit.bodyLength > 0)).toBe(true);
      for (const flags of [
        { includeBody: false }, { includeContext: false },
        { includeBody: false, includeContext: false },
      ]) {
        const hits = await search("authentication", { collection: ["docs", "notes"], ...flags });
        expect(hits.map(hit => [hit.filepath, hit.score])).toEqual(full.map(hit => [hit.filepath, hit.score]));
        for (let i = 0; i < hits.length; i++) {
          expect(hits[i]!.body).toBe(flags.includeBody === false ? undefined : full[i]!.body);
          expect(hits[i]!.bodyLength).toBe(flags.includeBody === false ? 0 : full[i]!.bodyLength);
          expect(hits[i]!.context).toBe(flags.includeContext === false ? null : full[i]!.context);
        }
      }
    }
  } finally {
    await store.close();
  }
});
