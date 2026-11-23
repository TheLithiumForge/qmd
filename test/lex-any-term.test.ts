import { expect, test } from "vitest";
import { createStore } from "../src/index.js";

test("anyTerm joins the terms with OR and ranks by the summed score", async () => {
  const store = await createStore({ dbPath: ":memory:" });
  const now = new Date().toISOString();
  const add = (path: string, body: string) => {
    store.internal.insertContent(path, body, now);
    store.internal.insertDocument("docs", path, "Note", path, now, now);
  };
  try {
    add("a.md", "Retries are bounded by the backoff limit.");
    add("b.md", "Retries happen after a timeout, and retries repeat.");
    add("c.md", "The queue is bounded.");
    add("d.md", "Retries are bounded, but this path is deprecated.");
    add("e.md", "Coordinate the multi-agent run.");
    add("f.md", "Nothing related lives here.");
    add("g.md", "A limit on the backoff.");
    const paths = async (query: string, anyTerm?: boolean) =>
      (await store.searchLex(query, { anyTerm })).map(hit => hit.displayPath).sort();
    // A mapped score s is |bm25| / (1 + |bm25|), so |bm25| is s / (1 - s).
    const bm25 = async (query: string, path: string, anyTerm?: boolean) => {
      const hit = (await store.searchLex(query, { anyTerm })).find(hit => hit.displayPath === path)!;
      return hit.score / (1 - hit.score);
    };

    // The default still needs every term.
    expect(await paths("retries bounded")).toEqual(["docs/a.md", "docs/d.md"]);
    expect(await paths("retries bounded", false)).toEqual(["docs/a.md", "docs/d.md"]);

    // With anyTerm, a document needs one term, and the documents with both rank first.
    const hits = await store.searchLex("retries bounded", { anyTerm: true });
    expect(hits.map(hit => hit.displayPath).sort()).toEqual(["docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md"]);
    expect(hits.map(hit => hit.score)).toEqual(hits.map(hit => hit.score).sort((x, y) => y - x));
    expect(hits.slice(0, 2).map(hit => hit.displayPath).sort()).toEqual(["docs/a.md", "docs/d.md"]);
    // The score of a document is the sum of its scores for each term.
    expect(await bm25("retries bounded", "docs/a.md", true))
      .toBeCloseTo(await bm25("retries", "docs/a.md") + await bm25("bounded", "docs/a.md"), 9);

    // A negated term excludes its documents from every term, not only from the last one.
    expect(await paths("retries bounded -deprecated", true)).toEqual(["docs/a.md", "docs/b.md", "docs/c.md"]);

    // Terms keep their escaping and prefix match: multi-agent is the phrase "multi agent",
    // and noth matches "Nothing" as a prefix. No document holds both, so only anyTerm finds them.
    expect(await paths("noth multi-agent")).toEqual([]);
    expect(await paths("noth multi-agent", true)).toEqual(["docs/e.md", "docs/f.md"]);

    // A quoted phrase stays a phrase: g.md holds both words, but not as the phrase.
    expect(await paths('"backoff limit" queue', true)).toEqual(["docs/a.md", "docs/c.md"]);
  } finally {
    await store.close();
  }
});
