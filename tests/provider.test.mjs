import test from "node:test";
import assert from "node:assert/strict";
import { createLlamaSwapProvider } from "../llama-swap.ts";
import { createModels } from "@earendil-works/pi-ai";
import { config, listing, chat, decision, json, refresh } from "./helpers.mjs";
test("AC-REFRESH preserved: last good catalog, generation publication and offline behavior", async () => {
  let body = listing(chat(), decision()), calls = 0;
  const p = createLlamaSwapProvider(config(), async (_, init) => { calls++; assert.equal(init.redirect, "error"); return json(body); });
  const pub = await refresh(p);
  assert.equal(pub[0].persist, undefined);
  assert.equal(p.getModels().length, 1); assert.equal(p.getAllModels().length, 2);
  await refresh(p, { allowNetwork: false }); assert.equal(calls, 1);
  const c = new AbortController(); c.abort();
  await refresh(p, { signal: c.signal }); assert.equal(calls, 1);
  body = listing(chat("new"));
  await refresh(p, { publish: async () => false });
  assert.equal(p.getModels()[0].id, "chat");
  body = {};
  await assert.rejects(refresh(p)); assert.equal(p.getModels()[0].id, "chat");
});
test("AC-REFRESH preserved: metadata bound inclusive and no upstream probes", async () => {
  const text = JSON.stringify(listing(chat()));
  const p = createLlamaSwapProvider(config(), async (url) => {
    assert.equal(url, "https://swap.invalid/prefix/v1/models");
    return new Response(text.padEnd(2097152, " "));
  });
  await refresh(p); assert.equal(p.getModels().length, 1);
  const large = createLlamaSwapProvider(config(), async () => new Response(" ".repeat(2097153)));
  await assert.rejects(refresh(large), /2 MiB/);
});
test("AC-REFRESH changed: Pi AuthContext environment and missing-key isolation", async () => {
  const models = createModels({ authContext: { env: async name => name === "SYNTHETIC_ONLY" ? "ctx-key" : undefined, fileExists: async () => false } });
  const p = createLlamaSwapProvider(config({ apiKeyEnv: "SYNTHETIC_ONLY" }));
  models.setProvider(p);
  assert.equal((await models.getAuth(p.id)).auth.apiKey, "ctx-key");
  const missing = createLlamaSwapProvider(config({ id: "llama-swap-missing", apiKeyEnv: "SYNTHETIC_MISSING" }));
  models.setProvider(missing);
  assert.equal(await models.getAuth(missing.id), undefined);
});
test("AC-REFRESH changed: configured missing environment key fails before HTTP", async () => {
  let calls = 0;
  const p = createLlamaSwapProvider(config({ apiKeyEnv: "SYNTHETIC_MISSING" }), async () => { calls++; return json(listing()); });
  await assert.rejects(refresh(p));
  assert.equal(calls, 0);
});
test("AC-REFRESH preserved: provider credentials and catalog types remain isolated in Pi", async () => {
  const observed = [];
  const models = createModels();
  for (const [id, key] of [["a","key-a"],["b","key-b"]]) {
    models.setProvider(createLlamaSwapProvider(config({ id: "llama-swap-" + id }), async (_, init) => {
      observed.push(new Headers(init.headers).get("authorization"));
      return json(listing(chat(id), decision(id + "-judge")));
    }));
  }
  for (const [id,key] of [["a","key-a"],["b","key-b"]]) {
    const p = models.getProvider("llama-swap-" + id);
    await refresh(p, { credential: { type: "api_key", key } });
    assert.equal(models.getModelsOfType("classifier", p.id)[0].id, id + "-judge");
    assert.equal(models.getModels(p.id)[0].id, id);
  }
  assert.deepEqual(observed, ["Bearer key-a","Bearer key-b"]);
});
