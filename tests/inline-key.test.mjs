import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import extension, { parseConfig, createLlamaSwapProvider, registerLlamaSwapServers } from "../llama-swap.ts";
import { config, listing, chat, decision, answers, context, json, refresh, fakePi } from "./helpers.mjs";

test("AC-INLINE-KEY-1 changed: named and legacy literal keys have no implicit environment source", () => {
  const [named] = parseConfig({ servers: [config({ apiKey: "synthetic-inline" })] });
  const legacy = config({ apiKey: "synthetic-legacy" }); delete legacy.id;
  const [single] = parseConfig(legacy);
  assert.equal(named.apiKey, "synthetic-inline"); assert.equal(named.apiKeyEnv, undefined);
  assert.equal(single.apiKey, "synthetic-legacy"); assert.equal(single.apiKeyEnv, undefined);
});

test("AC-INLINE-KEY-1 preserved: invalid keys and conflicting sources fail without key contents", () => {
  for (const apiKey of [null, 1, {}, [], "", "   ", "\t", "synthetic\nprivate", "synthetic\rprivate", "synthetic\0private", "synthetic\u007fprivate"]) {
    assert.throws(() => parseConfig({ servers: [config({ apiKey })] }), error => {
      assert.equal(error.message.includes("synthetic"), false); return true;
    });
  }
  for (const apiKeyEnv of ["INLINE_OTHER", "", "  ", null]) {
    assert.throws(() => parseConfig({ servers: [config({ apiKey: "synthetic-private", apiKeyEnv })] }), error => {
      assert.equal(error.message.includes("synthetic-private"), false); return true;
    });
  }
});

test("AC-INLINE-KEY-2 changed: startup, refresh, chat and classifiers use isolated literal keys without credential writes", async () => {
  const observed = [], pi = fakePi(); let writes = 0;
  // Dollar signs and command-like syntax are literal, not environment or shell expressions.
  const keys = { a: "$INLINE_UNSET", b: "!printf synthetic-inline-b" };
  const servers = Object.keys(keys).map(id => config({ id: "llama-swap-" + id, baseUrl: `https://${id}.invalid`, apiKey: keys[id] }));
  await registerLlamaSwapServers(pi.api, { servers }, async (url, init) => {
    const server = new URL(url).hostname.split(".")[0];
    observed.push({ server, key: new Headers(init.headers).get("authorization") });
    if (String(url).endsWith("/upstream/judge/v1/models")) return json(listing({ id: "judge" }));
    if (String(url).endsWith("/systemone")) return json({ model: "judge", answers });
    return json(listing(chat(), decision()));
  });
  const models = createModels({
    authContext: { env: async () => assert.fail("inline configuration consulted environment"), fileExists: async () => false },
    credentials: { read: async () => undefined, list: async () => [],
      modify: async () => { writes++; assert.fail("credential write"); }, delete: async () => { writes++; assert.fail("credential deletion"); } },
  });
  for (const provider of pi.providers) models.setProvider(provider);
  assert.equal(observed.length, 2); // Startup discovery used the configuration before Pi registration.
  assert.equal((await models.refresh({ allowNetwork: true })).errors.size, 0);
  assert.equal((await models.getAvailableOfType("classifier")).length, 2);
  for (const id of Object.keys(keys)) {
    const provider = "llama-swap-" + id;
    assert.equal((await models.getAuth(provider)).auth.apiKey, keys[id]);
    const classified = await models.classify(models.getModelOfType("classifier", provider, "judge"), context);
    assert.equal(classified.stopReason, "stop");
    const result = await models.completeSimple(models.getModel(provider, "chat"), {
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    }, { fetch: async (url, init) => {
      assert.equal(String(url), `https://${id}.invalid/v1/chat/completions`);
      observed.push({ server: id, key: new Headers(init.headers).get("authorization") });
      const chunk = { id: "synthetic-chat", object: "chat.completion.chunk", created: 1, model: "chat",
        choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    } });
    assert.equal(result.stopReason, "stop");
  }
  assert.equal(observed.length, 10); assert.equal(writes, 0);
  for (const request of observed) assert.equal(request.key, "Bearer " + keys[request.server]);
});

test("AC-INLINE-KEY-2 changed: stored credential wins and a blank credential does not fall back", async () => {
  let selected, calls = 0;
  const provider = createLlamaSwapProvider(config({ apiKey: "synthetic-inline" }), async (_, init) => {
    calls++; assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-stored");
    return json(listing(chat()));
  });
  const models = createModels({
    authContext: { env: async () => assert.fail("inline configuration consulted environment"), fileExists: async () => false },
    credentials: { read: async () => selected, list: async () => [], modify: async () => assert.fail("credential write"), delete: async () => assert.fail("credential deletion") },
  });
  models.setProvider(provider);
  assert.equal((await models.getAuth(provider.id)).auth.apiKey, "synthetic-inline");
  selected = { type: "api_key", key: "synthetic-stored" };
  assert.equal((await models.getAuth(provider.id)).auth.apiKey, "synthetic-stored");
  await refresh(provider, { credential: selected }); assert.equal(calls, 1);
  for (const key of ["", "   "]) {
    selected = { type: "api_key", key };
    assert.equal(await models.getAuth(provider.id), undefined);
    await assert.rejects(refresh(provider, { credential: selected }), /API key is not configured/);
  }
  assert.equal(calls, 1);
});

test("AC-INLINE-KEY-2 changed: inline, environment and keyless providers can coexist", async () => {
  const variable = "LLAMA_SWAP_INLINE_TEST_ENV", old = process.env[variable];
  const observed = [], pi = fakePi();
  try {
    process.env[variable] = "synthetic-env";
    await registerLlamaSwapServers(pi.api, { servers: [
      config({ id: "llama-swap-inline", apiKey: "local" }),
      config({ id: "llama-swap-env", apiKeyEnv: variable }),
      config({ id: "llama-swap-keyless" }),
    ] }, async (_, init) => { observed.push(new Headers(init.headers).get("authorization")); return json(listing(chat())); });
    assert.deepEqual(observed, ["Bearer local", "Bearer synthetic-env", "Bearer local"]);
    const envReads = [];
    const models = createModels({ authContext: { env: async name => { envReads.push(name); return "synthetic-ctx-env"; }, fileExists: async () => false } });
    for (const provider of pi.providers) models.setProvider(provider);
    assert.equal((await models.getAuth("llama-swap-inline")).auth.apiKey, "local");
    assert.equal((await models.getAuth("llama-swap-env")).auth.apiKey, "synthetic-ctx-env");
    assert.equal((await models.getAuth("llama-swap-keyless")).auth.apiKey, "local");
    assert.deepEqual(envReads, [variable]);
  } finally {
    if (old === undefined) delete process.env[variable]; else process.env[variable] = old;
  }
});

test("AC-INLINE-KEY-3 changed: config-file loading accepts inline keys and invalid data stays private", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-llama-swap-inline-key-"));
  const old = process.env.LLAMA_SWAP_CONFIG, offline = process.env.PI_OFFLINE;
  try {
    process.env.PI_OFFLINE = "1"; process.env.LLAMA_SWAP_CONFIG = join(dir, "config.json");
    await writeFile(process.env.LLAMA_SWAP_CONFIG, JSON.stringify({ servers: [config({ apiKey: "synthetic-file-key" })] }), { mode: 0o600 });
    const pi = fakePi(); await extension(pi.api);
    assert.equal(pi.providers.length, 1);
    const models = createModels(); models.setProvider(pi.providers[0]);
    assert.equal((await models.getAuth(pi.providers[0].id)).auth.apiKey, "synthetic-file-key");
    await writeFile(process.env.LLAMA_SWAP_CONFIG, JSON.stringify({ servers: [config({ apiKey: "synthetic-file-key\n" })] }));
    await assert.rejects(extension(fakePi().api), error => error.message === "Invalid llama-swap configuration");
  } finally {
    if (old === undefined) delete process.env.LLAMA_SWAP_CONFIG; else process.env.LLAMA_SWAP_CONFIG = old;
    if (offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = offline;
    await rm(dir, { recursive: true, force: true });
  }
});

test("AC-INLINE-KEY-3 changed: startup, status and refresh messages never include literal keys", async () => {
  const pi = fakePi(), key = "synthetic-warning-key", notifications = [];
  await registerLlamaSwapServers(pi.api, { servers: [config({ apiKey: key })] }, async () => { throw Error(key); });
  const ctx = { hasUI: true, signal: new AbortController().signal, ui: { notify: text => notifications.push(text) },
    waitForIdle: async () => {}, modelRegistry: { refresh: async () => ({ errors: new Map([["llama-swap-test", Error(key)]]), aborted: false }) } };
  await pi.events.get("session_start")({}, ctx);
  await pi.commands.get("llama-swap").handler("status", ctx);
  await pi.commands.get("llama-swap").handler("refresh", ctx);
  ctx.hasUI = false;
  await pi.commands.get("llama-swap").handler("refresh", ctx);
  assert.equal(notifications.length, 3); assert.equal(pi.messages.length, 1);
  for (const text of [...notifications, pi.messages[0].message.content, JSON.stringify(pi.providers[0])]) {
    assert.equal(text.includes(key), false);
  }
});
