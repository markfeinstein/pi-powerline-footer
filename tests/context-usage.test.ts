import test from "node:test";
import assert from "node:assert/strict";
import { readCoreContextUsage } from "../context-usage.ts";

test("readCoreContextUsage returns Pi context estimates for branch summaries", () => {
  const usage = readCoreContextUsage({
    getContextUsage() {
      return { tokens: 1250, contextWindow: 5000, percent: 25 };
    },
  });

  assert.deepEqual(usage, {
    contextTokens: 1250,
    contextWindow: 5000,
    contextPercent: 25,
  });
});

test("readCoreContextUsage computes percent when Pi returns only token totals", () => {
  const usage = readCoreContextUsage({
    getContextUsage() {
      return { tokens: 1000, contextWindow: 4000 };
    },
  });

  assert.deepEqual(usage, {
    contextTokens: 1000,
    contextWindow: 4000,
    contextPercent: 25,
  });
});

test("readCoreContextUsage ignores unknown or unusable estimates", () => {
  assert.equal(readCoreContextUsage({}), null);
  assert.equal(readCoreContextUsage({ getContextUsage: () => undefined }), null);
  assert.equal(readCoreContextUsage({ getContextUsage: () => ({ tokens: null, contextWindow: 5000, percent: null }) }), null);
  assert.equal(readCoreContextUsage({ getContextUsage: () => ({ tokens: 100, contextWindow: 0, percent: 0 }) }), null);
  assert.equal(readCoreContextUsage({ getContextUsage: () => { throw new Error("boom"); } }), null);
  assert.equal(readCoreContextUsage(Object.defineProperty({}, "getContextUsage", {
    get() {
      throw new Error("getter boom");
    },
  })), null);
  assert.equal(readCoreContextUsage({
    getContextUsage() {
      return Object.defineProperty({}, "tokens", {
        get() {
          throw new Error("tokens getter");
        },
      });
    },
  }), null);
});
