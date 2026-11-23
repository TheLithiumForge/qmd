import { expect, test, vi } from "vitest";
import type { Token } from "node-llama-cpp";
import { createStore } from "../src/index.js";
import { LlamaCpp, setDefaultLlamaCpp } from "../src/llm.js";

test("countTokens and embed use the store's tokenizer, not the global default", async () => {
  const store = await createStore({ dbPath: ":memory:" });
  const other = await createStore({ dbPath: ":memory:" });
  const llm = store.internal.llm!;
  // One token per character, so the 2,000-character body needs more than one 900-token chunk.
  const tokenize = vi.spyOn(llm, "tokenize").mockImplementation(async (text) => Array.from(text, () => 1 as Token));
  vi.spyOn(llm, "embed").mockResolvedValue({ embedding: [1, 0, 0], model: "test" });
  vi.spyOn(llm, "embedBatch").mockImplementation(async (texts) => texts.map(() => ({ embedding: [1, 0, 0], model: "test" })));
  vi.spyOn(other.internal.llm!, "tokenize").mockResolvedValue([1, 2] as Token[]);
  // The global default would count one token and keep the body in one chunk.
  const fallback = new LlamaCpp();
  const defaultTokenize = vi.spyOn(fallback, "tokenize").mockResolvedValue([1] as Token[]);
  setDefaultLlamaCpp(fallback);
  const now = new Date().toISOString();
  try {
    store.internal.insertContent("hash", "word ".repeat(400), now);
    store.internal.insertDocument("docs", "a.md", "A", "hash", now, now);

    const result = await store.embed();

    expect(result.errors).toBe(0);
    expect(result.chunksEmbedded).toBeGreaterThan(1);
    expect(tokenize).toHaveBeenCalled();
    expect(await store.countTokens("12345")).toBe(5);
    expect(await other.countTokens("12345")).toBe(2);
    expect(defaultTokenize).not.toHaveBeenCalled();
  } finally {
    setDefaultLlamaCpp(null);
    await fallback.dispose();
    await store.close();
    await other.close();
  }
});
