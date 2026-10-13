import test from "node:test";
import assert from "node:assert/strict";
import { createLlamaSwapProvider, mapCatalog, parseConfig, registerLlamaSwapServers } from "../llama-swap.ts";
import { config, listing, chat, decision, refresh, fakePi, context } from "./helpers.mjs";
import { dynamicFixture, transcript } from "./dynamic-fixture.mjs";

const spinUntil = async predicate => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(Boolean(predicate()), true, "synthetic operation reached its expected boundary");
};

test("AC-DYNAMIC-1 changed: mixed catalogs publish marked placeholders without upstream probes", async () => {
  const fixture = dynamicFixture();
  fixture.entries.push(chat("loaded"));
  const p = createLlamaSwapProvider(config(), fixture.fetch);
  await refresh(p);
  assert.deepEqual(p.getModels().map(m => m.id), ["a", "b", "loaded"]);
  assert.equal(p.getModels()[0].contextWindow, 32768);
  assert.equal(p.getModels()[0].contextPending, true);
  assert.equal(p.getModels()[0].dynamicContext, true);
  assert.match(p.getModels()[0].name, /\[context pending\]/);
  assert.equal(p.getModels()[2].contextPending, false);
  assert.deepEqual(fixture.calls.map(c => c.path), ["/prefix/v1/models"]);
  assert.equal(fixture.loaded, undefined);
  assert.equal(mapCatalog(listing({ id: "missing-context" }), config())[0].contextPending, true);
});

test("AC-DYNAMIC-1 changed: loading has a separate validated deadline in both config formats", () => {
  const [defaults] = parseConfig({ servers: [{ id: "llama-swap-test", baseUrl: "https://swap.invalid" }] });
  assert.equal(defaults.loadTimeoutMs, 120000);
  for (const loadTimeoutMs of [1, 2147483647]) {
    assert.equal(parseConfig({ servers: [config({ loadTimeoutMs })] })[0].loadTimeoutMs, loadTimeoutMs);
    const { id, ...legacy } = config({ loadTimeoutMs });
    assert.equal(parseConfig(legacy)[0].loadTimeoutMs, loadTimeoutMs);
  }
  for (const loadTimeoutMs of [null, 0, -1, 0.5, "120000", 2147483648]) {
    assert.throws(() => parseConfig({ servers: [config({ loadTimeoutMs })] }));
  }
});

test("AC-DYNAMIC-2 changed: chat resolves fitted per-slot context and capabilities before either API dispatch", async () => {
  const fixture = dynamicFixture(["org/a?b"]);
  const id = fixture.entries[0].id;
  fixture.windows[id] = 512; fixture.images[id] = true; fixture.aliases[id] = "actual-upstream-name";
  const p = createLlamaSwapProvider(config({ apiKey: "synthetic-own-key" }), fixture.fetch);
  await refresh(p);
  const held = p.getModels()[0];
  for (const method of ["stream", "streamSimple"]) {
    const stream = p[method](held, transcript, { apiKey: "synthetic-supplied-key", maxTokens: 65536, maxRetries: 0 });
    assert.equal((await stream.result()).stopReason, "stop");
    assert.equal(held.contextWindow, fixture.windows[id]);
    assert.equal(held.maxTokens, fixture.windows[id]);
    assert.equal(held.contextPending, false);
    assert.equal(held.input.includes("image"), true);
    assert.equal(held.name, id);
    const request = fixture.calls.findLast(c => c.path.endsWith("/chat/completions"));
    const body = JSON.parse(request.body);
    assert.equal(body.model, id);
    // Pi's simple adapter additionally reserves 4096 context tokens; these
    // deliberately tiny fitted windows therefore leave its minimum of one.
    assert.equal(body.max_tokens ?? body.max_completion_tokens, method === "stream" ? fixture.windows[id] : 1);
    fixture.windows[id] = 1024;
  }
  assert.ok(fixture.calls.slice(1).every(c => c.key === "Bearer synthetic-supplied-key"));
  assert.ok(fixture.calls.some(c => c.path === "/prefix/upstream/org%2Fa%3Fb/v1/models"));
  assert.ok(fixture.calls.some(c => c.path === "/prefix/upstream/org%2Fa%3Fb/props"));
  assert.equal(p.getModels().length, 1);
});

test("AC-DYNAMIC-2 changed: failed or missing runtime context blocks POST and guessed metadata publication", async () => {
  for (const failure of ["http", "missing"]) {
    const fixture = dynamicFixture(["a"]);
    fixture.failProps = failure === "http"; fixture.windows.a = 0;
    const p = createLlamaSwapProvider(config(), fixture.fetch); await refresh(p);
    const model = p.getModels()[0];
    const result = await p.streamSimple(model, transcript, { apiKey: "synthetic-key", maxRetries: 0 }).result();
    assert.equal(result.stopReason, "error");
    assert.equal(model.contextPending, true);
    assert.equal(fixture.calls.some(c => c.path.endsWith("/chat/completions")), false);
    assert.equal(result.errorMessage.includes("synthetic-private-body"), false);
  }
});

test("AC-DYNAMIC-2 changed: a newly identified decision model leaves chat and cannot receive chat POST", async () => {
  const fixture = dynamicFixture(["a"]); fixture.types.a = "classifier";
  const p = createLlamaSwapProvider(config(), fixture.fetch); await refresh(p);
  const result = await p.streamSimple(p.getModels()[0], transcript, { apiKey: "synthetic-key" }).result();
  assert.equal(result.stopReason, "error");
  assert.equal(fixture.calls.some(c => c.path.endsWith("/chat/completions")), false);
  assert.equal(p.getModels().length, 0);
  assert.equal(p.getAllModels()[0].type, "classifier");
  assert.equal(p.getAllModels()[0].contextWindow, 65536);
});

test("AC-DYNAMIC-4 changed: dynamic classifiers resolve context while retaining explicit alias identity", async () => {
  const fixture = dynamicFixture(["judge"]); fixture.types.judge = "classifier"; fixture.aliases.judge = "real-judge";
  fixture.entries = [{ ...decision("judge"), context_length: undefined, status: { value: "unloaded" } }];
  fixture.windows.judge = 2048;
  const p = createLlamaSwapProvider(config({ modelOverrides: { judge: { upstreamModelId: "real-judge" } } }), fixture.fetch);
  await refresh(p);
  const result = await p.classify(p.getAllModels()[0], context, { apiKey: "synthetic-classifier-key" });
  assert.equal(result.stopReason, "stop"); assert.equal(result.model, "judge");
  assert.equal(p.getAllModels()[0].contextWindow, 2048);
  assert.equal(JSON.parse(fixture.calls.find(c => c.path.endsWith("/systemone")).body).model, "real-judge");
  assert.ok(fixture.calls.slice(1).every(c => c.key === "Bearer synthetic-classifier-key"));
  fixture.aliases.judge = "wrong-model";
  const failed = await p.classify(p.getAllModels()[0], context, { apiKey: "synthetic-classifier-key" });
  assert.equal(failed.stopReason, "error");
  assert.equal(fixture.calls.filter(c => c.path.endsWith("/systemone")).length, 1);
});

test("AC-DYNAMIC-4 changed: one server holds its lease through SSE and cancelled queued loads never dispatch", async () => {
  const fixture = dynamicFixture(); fixture.holdChat = true;
  const p = createLlamaSwapProvider(config(), fixture.fetch); await refresh(p);
  const first = p.streamSimple(p.getModels()[0], transcript, { apiKey: "synthetic-key" });
  await spinUntil(() => fixture.releaseChat);
  const controller = new AbortController();
  const second = p.streamSimple(p.getModels()[1], transcript, { apiKey: "synthetic-key", signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.some(c => c.path.includes("/upstream/b/")), false);
  controller.abort();
  assert.equal((await second.result()).stopReason, "aborted");
  fixture.releaseChat();
  assert.equal((await first.result()).stopReason, "stop");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.some(c => c.path.includes("/upstream/b/")), false);
});

test("AC-DYNAMIC-4 changed: load deadline interrupts a metadata body and does not send inference", async () => {
  const fixture = dynamicFixture(["a"]); fixture.pendingProps = true;
  const p = createLlamaSwapProvider(config({ loadTimeoutMs: 10 }), fixture.fetch); await refresh(p);
  let watchdog;
  const result = await Promise.race([
    p.streamSimple(p.getModels()[0], transcript, { apiKey: "synthetic-key", maxRetries: 0 }).result(),
    new Promise(resolve => { watchdog = setTimeout(() => resolve(undefined), 300); }),
  ]);
  clearTimeout(watchdog);
  assert.equal(result?.stopReason, "error");
  assert.equal(fixture.cancelBody, true);
  assert.equal(fixture.calls.some(c => c.path.endsWith("/chat/completions")), false);
});

test("AC-DYNAMIC-2 verification: pending copies and legacy chat type receive resolved metadata", async () => {
  const fixture = dynamicFixture(["a"]);
  const p = createLlamaSwapProvider(config(), fixture.fetch); await refresh(p);
  await p.prepareModel(p.getModels()[0], { apiKey: "synthetic-key" });
  const copy = { ...p.getModels()[0], contextPending: true, contextWindow: 32768 };
  assert.equal(p.isPrepared(copy), false);
  const before = fixture.calls.length;
  await p.prepareModel(copy, { apiKey: "synthetic-key" });
  assert.equal(copy.contextWindow, 65536); assert.equal(copy.contextPending, false);
  assert.equal(fixture.calls.length, before);
  const legacy = { ...copy }; delete legacy.type;
  fixture.windows.a = 8192;
  assert.equal((await p.streamSimple(legacy, transcript, { apiKey: "synthetic-key" }).result()).stopReason, "stop");
  assert.equal(legacy.type, "chat"); assert.equal(legacy.contextWindow, 8192);
});

test("AC-DYNAMIC-5 preserved: explicit complete static models do not require discovery before inference", async () => {
  const fixture = dynamicFixture(["a", "judge"]);
  const cfg = config();
  const p = createLlamaSwapProvider(cfg, fixture.fetch);
  const [knownChat, knownClassifier] = mapCatalog(listing(chat("a"), decision("judge")), cfg);
  assert.equal((await p.streamSimple(knownChat, transcript, { apiKey: "synthetic-key" }).result()).stopReason, "stop");
  assert.equal((await p.classify(knownClassifier, context, { apiKey: "synthetic-key" })).stopReason, "stop");
  assert.deepEqual(fixture.calls.map(c => c.path), ["/prefix/v1/chat/completions", "/prefix/upstream/judge/v1/models", "/prefix/upstream/judge/v1/systemone"]);
  assert.equal(p.getAllModels().length, 0);
});

test("AC-DYNAMIC-3 changed: lifecycle prepares the selected identity only and gates failed input/compaction", async () => {
  const fixture = dynamicFixture(); const pi = fakePi();
  await registerLlamaSwapServers(pi.api, { servers: [config()] }, fixture.fetch);
  assert.equal(pi.providers[0].getModels().length, 2);
  let selected = pi.providers[0].getModels()[0], changes = 0, aborts = 0;
  pi.api.setModel = async model => { selected = model; changes++; return true; };
  const ctx = { get model() { return selected; }, hasUI: false, ui: {},
    modelRegistry: { getApiKeyForProvider: async () => "synthetic-runtime-key" },
    isIdle: () => true, abort: () => { aborts++; } };
  await pi.events.get("session_start")({ reason: "resume" }, ctx);
  assert.equal(selected.contextWindow, 65536);
  assert.equal(selected.contextPending, false);
  assert.equal(selected.id, "a"); assert.equal(changes, 0, "metadata refinement does not invoke an async selection setter");
  assert.equal(fixture.calls.some(c => c.path.includes("/upstream/b/")), false);
  fixture.windows.b = 1024;
  selected = pi.providers[0].getModels()[1];
  await pi.events.get("model_select")({ model: selected, source: "set" }, ctx);
  assert.equal(selected.contextWindow, 1024);
  fixture.failProps = true;
  assert.deepEqual(await pi.events.get("input")({ text: "hello" }, ctx), { action: "handled" });
  assert.deepEqual(await pi.events.get("session_before_compact")({}, ctx), { cancel: true });
  assert.ok(pi.messages.some(m => /preparation failed/i.test(m.message.content)));
  assert.equal(aborts, 0);
});

test("AC-DYNAMIC-2 changed: fresh props vision=false wins over listing metadata", async () => {
  const fixture = dynamicFixture(["a"]); fixture.advertisedImages.a = true; fixture.images.a = false;
  const p = createLlamaSwapProvider(config(), fixture.fetch); await refresh(p);
  await p.streamSimple(p.getModels()[0], transcript, { apiKey: "synthetic-key" }).result();
  assert.deepEqual(p.getModels()[0].input, ["text"]);
});

test("AC-DYNAMIC-2 changed: explicit context is a ceiling, not a replacement for fresh fitted context", async () => {
  const fixture = dynamicFixture(["a"]); fixture.windows.a = 2048;
  const p = createLlamaSwapProvider(config({ modelOverrides: { a: { contextWindow: 8192, maxTokens: 10000 } } }), fixture.fetch);
  await refresh(p);
  assert.equal((await p.stream(p.getModels()[0], transcript, { apiKey: "synthetic-key", maxTokens: 10000 }).result()).stopReason, "stop");
  assert.equal(p.getModels()[0].contextWindow, 2048);
  assert.equal(p.getModels()[0].maxTokens, 2048);
  fixture.windows.a = 16384;
  assert.equal((await p.stream(p.getModels()[0], transcript, { apiKey: "synthetic-key", maxTokens: 10000 }).result()).stopReason, "stop");
  assert.equal(p.getModels()[0].contextWindow, 8192);
  const body = JSON.parse(fixture.calls.findLast(c => c.path.endsWith("/chat/completions")).body);
  assert.equal(body.max_tokens ?? body.max_completion_tokens, 8192);
});

test("AC-DYNAMIC-4 changed: native non-llama.cpp context does not require llama.cpp props", async () => {
  const fixture = dynamicFixture(["judge"]);
  fixture.entries = [{ ...decision("judge"), status: { value: "unloaded" } }];
  fixture.types.judge = "classifier"; fixture.owners.judge = "typesafe"; fixture.nativeContexts.judge = 2048;
  const p = createLlamaSwapProvider(config(), fixture.fetch); await refresh(p);
  assert.equal((await p.classify(p.getAllModels()[0], context, { apiKey: "synthetic-key" })).stopReason, "stop");
  assert.equal(p.getAllModels()[0].contextWindow, 2048);
  assert.equal(fixture.calls.some(c => c.path.endsWith("/props")), false);
});

test("AC-DYNAMIC-4 changed: cancellation during preparation cancels the body and never sends POST", async () => {
  const fixture = dynamicFixture(["a"]); fixture.pendingProps = true;
  const p = createLlamaSwapProvider(config(), fixture.fetch); await refresh(p);
  const controller = new AbortController();
  const stream = p.stream(p.getModels()[0], transcript, { apiKey: "synthetic-key", signal: controller.signal });
  await spinUntil(() => fixture.calls.some(c => c.path.endsWith("/props")));
  controller.abort();
  assert.equal((await stream.result()).stopReason, "aborted");
  await spinUntil(() => fixture.cancelBody);
  assert.equal(p.getModels()[0].contextPending, true);
  assert.equal(fixture.calls.some(c => c.path.endsWith("/chat/completions")), false);
});

test("AC-DYNAMIC-4 changed: a busy provider cannot block a different server or share credentials", async () => {
  const one = dynamicFixture(["a"]), two = dynamicFixture(["a"]); one.holdChat = true;
  const p1 = createLlamaSwapProvider(config({ id: "llama-swap-one", apiKey: "synthetic-one" }), one.fetch);
  const p2 = createLlamaSwapProvider(config({ id: "llama-swap-two", apiKey: "synthetic-two" }), two.fetch);
  await Promise.all([refresh(p1), refresh(p2)]);
  const first = p1.streamSimple(p1.getModels()[0], transcript, { apiKey: "synthetic-one" });
  await spinUntil(() => one.releaseChat);
  let watchdog;
  const second = await Promise.race([p2.streamSimple(p2.getModels()[0], transcript, { apiKey: "synthetic-two" }).result(),
    new Promise(resolve => { watchdog = setTimeout(() => resolve(undefined), 300); })]);
  clearTimeout(watchdog); one.releaseChat(); await first.result();
  assert.equal(second?.stopReason, "stop");
  assert.ok(one.calls.every(c => c.key === "Bearer synthetic-one"));
  assert.ok(two.calls.every(c => c.key === "Bearer synthetic-two"));
});

test("AC-DYNAMIC-2 changed: an explicit caller transport owns preparation as well as inference", async () => {
  const fixture = dynamicFixture(["a"]); let defaultCalls = 0, suppliedCalls = 0;
  const p = createLlamaSwapProvider(config({ tlsVerify: false }), async (...args) => { defaultCalls++; return fixture.fetch(...args); });
  await refresh(p);
  const result = await p.streamSimple(p.getModels()[0], transcript, { apiKey: "synthetic-key",
    fetch: async (...args) => { suppliedCalls++; return fixture.fetch(...args); } }).result();
  assert.equal(result.stopReason, "stop");
  assert.equal(defaultCalls, 1); assert.equal(suppliedCalls, 3);
});

test("AC-DYNAMIC-2 changed: concurrent read-only refresh cannot leave resolved metadata in a detached catalog object", async () => {
  const fixture = dynamicFixture(["a"]); let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const p = createLlamaSwapProvider(config(), async (...args) => {
    if (String(args[0]).endsWith("/props")) { reached = true; await gate; }
    return fixture.fetch(...args);
  });
  await refresh(p); const held = p.getModels()[0];
  const stream = p.stream(held, transcript, { apiKey: "synthetic-key" });
  await spinUntil(() => reached);
  await refresh(p); release();
  assert.equal((await stream.result()).stopReason, "stop");
  assert.equal(held.contextWindow, 65536);
  assert.equal(p.getModels()[0].contextWindow, 65536);
  assert.equal(p.getModels()[0].contextPending, false);
  assert.equal(p.isPrepared(held), true);
});

test("AC-DYNAMIC-3 verification: preparation cannot overwrite a newer unrelated selection", async () => {
  const fixture = dynamicFixture(["a"]), pi = fakePi(); let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  await registerLlamaSwapServers(pi.api, { servers: [config()] }, async (...args) => {
    if (String(args[0]).endsWith("/props")) { reached = true; await gate; }
    return fixture.fetch(...args);
  });
  let selected = pi.providers[0].getModels()[0];
  const ctx = { get model() { return selected; }, hasUI: false, ui: {},
    modelRegistry: { getApiKeyForProvider: async () => "synthetic-key" }, isIdle: () => true };
  const preparation = pi.events.get("model_select")({}, ctx);
  await spinUntil(() => reached);
  const outside = { ...selected, id: "outside", provider: "unrelated", contextWindow: 123456 };
  selected = outside; release(); await preparation;
  assert.equal(selected, outside); assert.equal(selected.contextWindow, 123456);
  const before = fixture.calls.length;
  await pi.events.get("model_select")({}, ctx);
  assert.equal(fixture.calls.length, before);
});

test("AC-DYNAMIC-3 verification: authentication failure blocks compaction even after a successful load", async () => {
  const fixture = dynamicFixture(["a"]), pi = fakePi(); let key = "synthetic-key";
  await registerLlamaSwapServers(pi.api, { servers: [config()] }, fixture.fetch);
  const selected = pi.providers[0].getModels()[0];
  const ctx = { model: selected, hasUI: false, ui: {}, modelRegistry: { getApiKeyForProvider: async () => key }, isIdle: () => true };
  await pi.events.get("session_start")({}, ctx);
  assert.equal(pi.providers[0].isPrepared(selected), true);
  key = undefined;
  assert.deepEqual(await pi.events.get("input")({}, ctx), { action: "handled" });
  assert.deepEqual(await pi.events.get("session_before_compact")({}, ctx), { cancel: true });
  assert.equal(fixture.calls.some(c => c.path.endsWith("/chat/completions")), false);
});
