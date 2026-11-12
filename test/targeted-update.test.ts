import { test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore, type QMDStore } from "../src/index.js";

async function fixture(run: (store: QMDStore, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "qmd-targeted-"));
  await writeFile(join(root, "a.md"), "# Alpha\nOriginal alpha content");
  await writeFile(join(root, "b.md"), "# Bravo\nOriginal bravo content");
  const store = await createStore({ dbPath: ":memory:", config: { collections: {
    docs: { path: root, pattern: "**/*.md", ignore: ["ignored/**", "other/**"] },
  } } });
  try {
    await store.update();
    await run(store, root);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function seedVectors(store: QMDStore, path = "a.md", chunks = 1) {
  const row = store.internal.db.prepare("SELECT hash FROM documents WHERE path = ? AND active = 1").get(path) as { hash: string };
  store.internal.ensureVecTable(3);
  for (let seq = 0; seq < chunks; seq++) {
    store.internal.insertEmbedding(row.hash, seq, seq * 100, new Float32Array([1, 0, 0]),
      store.internal.llm!.embedModelName, new Date().toISOString(), chunks);
  }
  return row.hash;
}

test("updates only named files and an empty target list does no scan", async () => {
  await fixture(async (store, root) => {
    await writeFile(join(root, "a.md"), "# Changed\nNew searchable needle");
    await writeFile(join(root, "b.md"), "# Unlisted\nUnexpected mutation");
    await writeFile(join(root, "c.md"), "# Unlisted new file");
    expect(await store.update({ changed: [], removed: [] })).toMatchObject({ collections: 0, updated: 0 });
    const progress: string[] = [];
    expect(await store.update({ changed: [join(root, "a.md"), join(root, "a.md")], removed: [],
      onProgress: info => progress.push(info.file) })).toMatchObject({ collections: 1, indexed: 0, updated: 1, removed: 0 });
    expect(progress).toEqual(["a.md"]);
    expect((await store.searchLex("needle"))[0]!.filepath).toBe("qmd://docs/a.md");
    expect(await store.searchLex("unexpected")).toEqual([]);
    expect((await store.listCollections())[0]!.active_count).toBe(2);
    expect(await store.update()).toMatchObject({ indexed: 1, updated: 1, unchanged: 1 });
  });
});

test("rename uses removed plus changed and keeps shared chunk embeddings", async () => {
  await fixture(async (store, root) => {
    const hash = seedVectors(store);
    await rename(join(root, "a.md"), join(root, "renamed.md"));
    expect(await store.update({ changed: ["qmd://docs/renamed.md"], removed: ["qmd://docs/a.md"] }))
      .toMatchObject({ indexed: 1, removed: 1 });
    const hits = await store.internal.searchVec("unused", "test", 10, "docs", undefined, [1, 0, 0]);
    expect(hits.map(hit => hit.filepath)).toEqual(["qmd://docs/renamed.md"]);
    expect(store.internal.db.prepare("SELECT hash FROM content_vectors").all()).toEqual([{ hash }]);
  });
});

test.each([1, 3])("removing the last document deletes all %s chunks from both vector tables", async chunks => {
  await fixture(async (store, root) => {
    seedVectors(store, "a.md", chunks);
    await rm(join(root, "a.md"));
    expect(await store.update({ removed: ["a.md"] })).toMatchObject({ removed: 1, indexed: 0, updated: 0 });
    expect(store.internal.db.prepare("SELECT * FROM content_vectors").all()).toEqual([]);
    expect(store.internal.db.prepare("SELECT hash_seq FROM vectors_vec").all()).toEqual([]);
    expect(await store.internal.searchVec("unused", "test", 10, undefined, undefined, [1, 0, 0])).toEqual([]);
    expect((await store.listCollections())[0]!.active_count).toBe(1);
    expect(await store.update({ removed: ["a.md"] })).toMatchObject({ removed: 0 });
  });
});

test("removing one document keeps embeddings referenced by another", async () => {
  await fixture(async (store, root) => {
    const hash = seedVectors(store);
    store.internal.insertDocument("docs", "shared.md", "Shared", hash, "now", "now");
    await store.update({ removed: ["a.md"] });
    expect(store.internal.db.prepare("SELECT hash FROM content_vectors").all()).toEqual([{ hash }]);
  });
});

test("changed content invalidates only its old chunks", async () => {
  await fixture(async (store, root) => {
    const old = seedVectors(store);
    const kept = seedVectors(store, "b.md");
    await writeFile(join(root, "a.md"), "# Alpha\nReplacement content");
    expect(await store.update({ changed: ["a.md"] })).toMatchObject({ updated: 1, needsEmbedding: 1 });
    expect(store.internal.db.prepare("SELECT hash FROM content_vectors").all()).toEqual([{ hash: kept }]);
    expect(store.internal.db.prepare("SELECT hash_seq FROM vectors_vec WHERE hash_seq = ?").get(`${old}_0`)).toBeUndefined();
  });
});

test("empty replacement removes the old searchable document and final chunk", async () => {
  await fixture(async (store, root) => {
    seedVectors(store);
    await writeFile(join(root, "a.md"), "\n");
    expect(await store.update({ changed: ["a.md"] })).toMatchObject({ removed: 1 });
    expect(await store.searchLex("alpha")).toEqual([]);
    expect(store.internal.db.prepare("SELECT hash_seq FROM vectors_vec").all()).toEqual([]);
  });
});

test("rename across collections keeps embeddings until all targets finish", async () => {
  await fixture(async (store, root) => {
    const hash = seedVectors(store);
    const other = join(root, "other");
    await mkdir(other);
    await store.addCollection("other", { path: other });
    await rename(join(root, "a.md"), join(other, "moved.md"));
    expect(await store.update({ changed: [join(other, "moved.md")], removed: [join(root, "a.md")] }))
      .toMatchObject({ collections: 2, indexed: 1, removed: 1 });
    expect(store.internal.db.prepare("SELECT hash FROM content_vectors").all()).toEqual([{ hash }]);
  });
});

test("validates all paths before writing and respects ignore and glob rules", async () => {
  await fixture(async (store, root) => {
    await writeFile(join(root, "a.md"), "# Changed\nNew content");
    await expect(store.update({ changed: ["a.md", "../escape.md"] })).rejects.toThrow("outside selected collections");
    expect(await store.searchLex("original")).toHaveLength(2);
    await mkdir(join(root, "ignored"));
    await writeFile(join(root, "ignored", "x.md"), "# Hidden ignored");
    await writeFile(join(root, "x.txt"), "Wrong extension");
    await writeFile(join(root, ".hidden.md"), "Hidden path");
    expect(await store.update({ changed: ["ignored/x.md", "x.txt", ".hidden.md"] }))
      .toMatchObject({ indexed: 0, updated: 0 });
    await store.addCollection("other", { path: join(root, "other") });
    await expect(store.update({ changed: ["a.md"] })).rejects.toThrow("exactly one selected collection");
    expect(await store.update({ collections: ["docs"], changed: ["a.md"] })).toMatchObject({ updated: 1 });
  });
});
