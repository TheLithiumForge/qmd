import { describe, test, expect } from "vitest";
import { createStore } from "../src/store.js";

describe("scoped KNN", () => {
  test("uses an allowlist even beyond the former exact-scan threshold", async () => {
    const store = createStore(":memory:");
    const now = new Date().toISOString();
    try {
      store.ensureVecTable(3);
      // More than 20,000 keys used to fall back to global KNN. Closer
      // unrelated vectors then filled its capped result before filtering.
      store.db.transaction(() => {
        for (let i = 0; i < 20_001; i++) {
          const hash = `scoped${i}`;
          store.insertContent(hash, "scoped document", now);
          store.insertDocument("small", `${i}.md`, "Scoped", hash, now, now);
          store.insertEmbedding(hash, 0, 0, new Float32Array([0, 1, 0]), "test", now);
        }
        for (let i = 0; i < 40; i++) {
          const hash = `other${i}`;
          store.insertContent(hash, "unrelated document", now);
          store.insertDocument("other", `${i}.md`, "Other", hash, now, now);
          store.insertEmbedding(hash, 0, 0, new Float32Array([1, 0, 0]), "test", now);
        }
      })();
      const hits = await store.searchVec("unused", "test", 1, "small", undefined, [1, 0, 0]);
      expect(hits).toHaveLength(1);
      expect(hits[0]!.collectionName).toBe("small");
      expect(hits[0]!.score).toBeCloseTo(0);
      expect(await store.searchVec("unused", "test", 10, "missing", undefined, [1, 0, 0])).toEqual([]);
    } finally {
      store.close();
    }
  });
});
