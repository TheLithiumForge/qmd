import { test, expect, vi } from "vitest";
import { createStore } from "../src/index.js";

test.each([undefined, 25, 0])("store idle timeout %s controls model disposal", async (timeout) => {
  vi.useFakeTimers();
  const store = await createStore({ dbPath: ":memory:", modelIdleTimeoutMs: timeout });
  const llm = store.internal.llm! as any;
  const disposeContext = vi.fn(async () => {});
  const disposeModel = vi.fn(async () => {});
  llm.embedContexts = [{ dispose: disposeContext }];
  llm.embedModel = { dispose: disposeModel };
  try {
    llm.touchActivity();
    const delay = timeout ?? 5 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(delay === 0 ? 600_000 : delay - 1);
    expect(disposeContext).not.toHaveBeenCalled();
    if (delay > 0) {
      await vi.advanceTimersByTimeAsync(1);
      expect(disposeContext).toHaveBeenCalledTimes(1);
      expect(disposeModel).toHaveBeenCalledTimes(1);
    }
  } finally {
    await store.close();
    vi.useRealTimers();
  }
  expect(disposeContext).toHaveBeenCalledTimes(1);
  expect(disposeModel).toHaveBeenCalledTimes(1);
});
