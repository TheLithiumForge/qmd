import { expect, test, vi } from "vitest";
import { cleanupOrphanedVectors, createStore } from "../src/store.js";

// The lookup as it was before it went through the hash index, to show that the same rows go.
const PREVIOUS_ORPHAN_ROWS = `
  SELECT vr.id FROM vector_rows vr
  JOIN vector_collection_ids ci ON ci.id = vr.collection_id
  WHERE NOT EXISTS (
    SELECT 1 FROM documents d WHERE d.hash = vr.hash AND d.collection = ci.name AND d.active = 1
  )
`;

test("cleanupOrphanedVectors looks documents up by hash and removes the same rows", () => {
  const store = createStore(":memory:");
  const db = store.db;
  const now = new Date().toISOString();
  try {
    store.ensureVecTable(3);
    const add = (hash: string, documents: [collection: string, path: string][]) => {
      store.insertContent(hash, `body of ${hash}`, now);
      for (const [collection, path] of documents) store.insertDocument(collection, path, hash, hash, now, now);
      store.insertEmbedding(hash, 0, 0, new Float32Array([1, 0, 0]), "test", now);
    };
    add("kept", [["a", "kept.md"]]);
    // Shared by two collections: only the partition of the collection that loses it goes.
    add("shared", [["a", "shared.md"], ["b", "shared.md"]]);
    // Held by an inactive document only.
    add("inactive", [["a", "inactive.md"]]);
    // Held by no document at all.
    add("gone", [["b", "gone.md"]]);
    store.deactivateDocument("b", "shared.md");
    store.deactivateDocument("a", "inactive.md");
    db.prepare("DELETE FROM documents WHERE hash = 'gone'").run();

    const rows = () => db.prepare(`
      SELECT vr.hash, ci.name AS collection FROM vector_rows vr
      JOIN vector_collection_ids ci ON ci.id = vr.collection_id ORDER BY vr.hash, ci.name
    `).all();
    const previous = new Set((db.prepare(PREVIOUS_ORPHAN_ROWS).all() as { id: number }[]).map(row => row.id));
    const all = (db.prepare("SELECT id FROM vector_rows").all() as { id: number }[]).map(row => row.id);
    expect(previous.size).toBe(3);

    const prepare = vi.spyOn(db, "prepare");
    expect(cleanupOrphanedVectors(db)).toBe(3);
    const remaining = (db.prepare("SELECT id FROM vector_rows").all() as { id: number }[]).map(row => row.id);
    expect(remaining).toEqual(all.filter(id => !previous.has(id)));
    expect(rows()).toEqual([{ hash: "kept", collection: "a" }, { hash: "shared", collection: "a" }]);
    expect(db.prepare("SELECT DISTINCT hash FROM content_vectors ORDER BY hash").all())
      .toEqual([{ hash: "kept" }, { hash: "shared" }]);

    const lookup = prepare.mock.calls.map(call => call[0]).find(sql => sql.includes("FROM documents d WHERE d.hash = vr.hash"));
    expect(lookup).toBeDefined();
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${lookup}`).all() as { detail: string }[]).map(row => row.detail);
    expect(plan.some(detail => /SEARCH d USING INDEX idx_documents_hash \(hash=\?\)/.test(detail))).toBe(true);
    expect(plan.some(detail => /idx_documents_collection/.test(detail))).toBe(false);
  } finally {
    store.close();
  }
});
