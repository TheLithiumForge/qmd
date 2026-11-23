import { afterEach, beforeEach, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/index.js";
import { openDatabase } from "../src/db.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qmd-read-only-"));
  dbPath = join(dir, "index.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("two read-only stores read one index while a writer holds the write lock", async () => {
  const writer = await createStore({ dbPath, config: { collections: { docs: { path: join(dir, "docs"), pattern: "**/*.md" } } } });
  const db = writer.internal.db;
  const now = new Date().toISOString();
  const add = (name: string) => {
    writer.internal.insertContent(name, `# ${name}\n\nNotes about ${name}`, now);
    writer.internal.insertDocument("docs", `${name}.md`, name, name, now, now);
  };
  // data_version changes only when another connection writes to the database.
  const dataVersion = () => db.prepare(`PRAGMA data_version`).get();
  const paths = async (reader: typeof writer, query: string) =>
    (await reader.searchLex(query)).map(hit => hit.displayPath);
  add("alpha");
  const before = dataVersion();

  // The writer keeps its write lock for as long as the readers open and search.
  db.exec("BEGIN IMMEDIATE");
  add("beta");
  const readers = [
    await createStore({ dbPath, readOnly: true }),
    // A reader's config is not synced: the collections stay the writer's.
    await createStore({ dbPath, readOnly: true, config: { collections: { other: { path: dir, pattern: "**/*.md" } } } }),
  ];
  try {
    for (const reader of readers) {
      expect(await paths(reader, "alpha")).toEqual(["docs/alpha.md"]);
      expect(await paths(reader, "beta")).toEqual([]);
      expect((await reader.listCollections()).map(collection => collection.name)).toEqual(["docs"]);
    }
    db.exec("COMMIT");

    for (const reader of readers) {
      expect(await paths(reader, "beta")).toEqual(["docs/beta.md"]);
      expect(await reader.get("docs/alpha.md")).toMatchObject({ title: "alpha", collectionName: "docs" });
      expect((await reader.getStatus()).totalDocuments).toBe(2);

      for (const write of [
        () => reader.update(),
        () => reader.embed(),
        () => reader.addCollection("more", { path: dir }),
        () => reader.removeCollection("docs"),
        () => reader.renameCollection("docs", "renamed"),
        () => reader.addContext("docs", "/", "context"),
        () => reader.removeContext("docs", "/"),
        () => reader.setGlobalContext("context"),
      ]) {
        await expect(write()).rejects.toThrow("needs a writable store");
      }
      // The connection itself is read-only, and the cache is left alone instead of failing a search.
      expect(() => reader.internal.insertContent("gamma", "body", now)).toThrow(/readonly/i);
      reader.internal.setCachedResult("key", "value");
      reader.internal.invalidateExpansionCache("alpha");
      expect(reader.internal.getCachedResult("key")).toBeNull();
    }
    expect((await writer.listCollections()).map(collection => collection.name)).toEqual(["docs"]);
    expect(dataVersion()).toEqual(before);
  } finally {
    for (const store of [...readers, writer]) await store.close();
  }
});

test("a read-only store fails at open when the database, a table or the current schema is missing", async () => {
  await expect(createStore({ dbPath, readOnly: true })).rejects.toThrow("no database at");
  expect(existsSync(dbPath)).toBe(false);

  openDatabase(dbPath).close();
  await expect(createStore({ dbPath, readOnly: true })).rejects.toThrow(/has no content, documents, .* table/);

  await (await createStore({ dbPath })).close();
  const db = openDatabase(dbPath);
  db.exec("PRAGMA user_version = 1");
  db.close();
  await expect(createStore({ dbPath, readOnly: true })).rejects.toThrow("has an older schema");
});
