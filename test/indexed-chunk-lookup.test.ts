import { test, expect, vi } from "vitest";
import { createStore } from "../src/store.js";

test("chunk hydration uses the hash and seq index and keeps tied document order", async () => {
  const store = createStore(":memory:");
  const now = new Date().toISOString();
  try {
    store.ensureVecTable(3);
    for (const hash of ["zzz", "aaa"]) {
      store.insertContent(hash, "indexed body", now);
      store.insertDocument("docs", `${hash}.md`, hash, hash, now, now);
      for (const seq of [0, 1]) {
        store.insertEmbedding(hash, seq, seq * 100, new Float32Array([1, 0, 0]), "test", now, 2);
      }
    }
    const prepare = vi.spyOn(store.db, "prepare");
    const hits = await store.searchVec("unused", "test", 10, "docs", undefined, [1, 0, 0]);
    expect(hits.map(hit => [hit.title, hit.chunkPos])).toEqual([["zzz", 0], ["aaa", 0]]);
    const lookup = prepare.mock.calls.map(call => call[0]).find(sql => sql.includes("WITH requested"));
    expect(lookup).toBeDefined();
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${lookup}`).all(
      "zzz", 0, "zzz", 1, "aaa", 0, "aaa", 1, "docs",
    ) as { detail: string }[];
    expect(plan.some(row => /SEARCH cv USING.*\(hash=\? AND seq=\?\)/.test(row.detail))).toBe(true);
    expect(plan.some(row => /SCAN cv\b/.test(row.detail))).toBe(false);
  } finally {
    store.close();
  }
});
