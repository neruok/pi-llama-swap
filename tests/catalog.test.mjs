import test from "node:test";
import assert from "node:assert/strict";
import { mapCatalog } from "../llama-swap.ts";
import { config, listing, chat, decision } from "./helpers.mjs";
test("AC-CATALOG preserved: mixed operation mapping and context precedence", () => {
  const cfg = config({ modelOverrides: {
    chat: { contextWindow: 1000, maxTokens: 2000, reasoning: true, compat: { supportsStore: false } },
    fallback: { fallbackContextWindow: 1234 }, ignore: { type: "ignore" },
    manual: { type: "classifier", contextWindow: 2000 },
  } });
  const models = mapCatalog(listing(chat(), decision("org/judge"), { id: "fallback" },
    { id: "ignore" }, { id: "manual" },
    { id: "picture", architecture: { output_modalities: ["image"] } },
    { id: "meta", meta: { n_ctx: 99 } }), cfg);
  assert.deepEqual(models.map(m => [m.id, m.type]), [["chat","chat"],["org/judge","classifier"],["fallback","chat"],["manual","classifier"],["meta","chat"]]);
  assert.equal(models[0].maxTokens, 1000); assert.equal(models[0].contextWindow, 1000);
  assert.equal(models[0].reasoning, true); assert.equal(models[0].compat.supportsStore, false);
  assert.equal(models[1].baseUrl, "https://swap.invalid/prefix/upstream/org%2Fjudge/v1");
  assert.equal(models[2].contextWindow, 1234);
  assert.equal(models[4].contextWindow, 99);
  assert.equal(mapCatalog(listing({ ...chat(), architecture: { input_modalities: ["image"] } }), cfg)[0].input.includes("image"), true);
});
test("AC-CATALOG preserved: malformed listings fail atomically", () => {
  for (const body of [null, { data: {} }, listing(...Array.from({length:1001}, (_, i) => chat(String(i)))), listing(chat(), chat()), listing(chat("bad\nID"))]) {
    assert.throws(() => mapCatalog(body, config()));
  }
  assert.equal(mapCatalog(listing(), config()).length, 0);
});
test("AC-CATALOG changed: display controls and path-segment IDs fail", () => {
  for (const item of [{ ...chat(), name: "\u001b[31m" }, { ...chat(), name: "x".repeat(513) }, decision("."), decision("..")]) {
    assert.throws(() => mapCatalog(listing(item), config()));
  }
});
