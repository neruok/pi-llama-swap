import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../llama-swap.ts";
import { config } from "./helpers.mjs";
test("AC-CONFIG preserved: formats, defaults and isolated key names", () => {
  const legacy = config(); delete legacy.id;
  assert.equal(parseConfig(legacy)[0].apiKeyEnv, "LLAMA_SWAP_API_KEY");
  const [a, b] = parseConfig({ servers: [
    { id: "llama-swap-a", baseUrl: "http://127.0.0.1:8080/" },
    { id: "llama-swap-b", baseUrl: "https://swap.invalid", apiKeyEnv: "SERVER_B" },
  ] });
  assert.equal(a.timeoutMs, 3000); assert.equal(a.defaultMaxTokens, 4096);
  assert.equal(a.baseUrl, "http://127.0.0.1:8080"); assert.equal(a.apiKeyEnv, undefined);
  assert.equal(b.apiKeyEnv, "SERVER_B");
});
test("AC-CONFIG preserved: invalid input and unknown fields fail", () => {
  for (const value of [
    null, [], {}, { servers: [] }, { servers: [config(), config()] },
    { servers: [{ ...config(), baseUrl: "https://user:secret@swap.invalid" }] },
    { servers: [{ ...config(), baseUrl: "file:///x" }] },
    { servers: [{ ...config(), apiKeyEnv: "X;cmd" }] },
    { servers: [{ ...config(), extra: true }] },
    { servers: [{ ...config(), modelOverrides: { x: { compat: { unverified: true } } } }] },
    { servers: [{ ...config(), name: "\u001b[31m" }] },
  ]) assert.throws(() => parseConfig(value));
});
test("AC-CONFIG changed: explicit upstream IDs are accepted", () => {
  const [c] = parseConfig({ servers: [config({ modelOverrides: { judge: { upstreamModelId: "gguf-name" } } })] });
  assert.equal(c.modelOverrides.judge.upstreamModelId, "gguf-name");
});
test("AC-CONFIG changed: timer and upstream path boundaries", () => {
  assert.throws(() => parseConfig({ servers: [config({ timeoutMs: 2147483648 })] }));
  assert.equal(parseConfig({ servers: [config({ timeoutMs: 2147483647 })] })[0].timeoutMs, 2147483647);
  for (const id of [".", "..", "\u001b", "x".repeat(513)]) {
    assert.throws(() => parseConfig({ servers: [config({ modelOverrides: { judge: { upstreamModelId: id } } })] }));
  }
});
