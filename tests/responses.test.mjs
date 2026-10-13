import test from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { createLlamaSwapProvider, mapCatalog, parseConfig, registerLlamaSwapServers } from "../llama-swap.ts";
import { config, listing, chat, decision, classifier, refresh, fakePi } from "./helpers.mjs";
import { dynamicFixture, transcript } from "./dynamic-fixture.mjs";
import { responsesFixture, responseEvents, frame } from "./responses-fixture.mjs";

const responseConfig = overrides => config({ api: "openai-responses", ...overrides });
const postCalls = fixture => fixture.calls.filter(c => c.path.endsWith("/responses") || c.path.endsWith("/chat/completions"));
const waitFor = async predicate => {
  for (let i = 0; i < 500 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(predicate(), "synthetic request reached expected boundary");
};

test("AC-API-1 changed: both configuration formats accept the selected API", () => {
  for (const api of ["openai-completions", "openai-responses"]) {
    const named = config({ api });
    const { id, ...legacy } = named;
    assert.equal(parseConfig({ servers: [named] })[0].api, api);
    assert.equal(parseConfig(legacy)[0].api, api);
  }
  assert.equal(parseConfig({ servers: [config()] })[0].api, "openai-completions");
});

test("AC-API-1 changed: Responses accepts only the shared compat flag", () => {
  for (const supportsDeveloperRole of [true, false]) {
    const cfg = responseConfig({ modelOverrides: { a: { compat: { supportsDeveloperRole } } } });
    assert.equal(parseConfig({ servers: [cfg] })[0].modelOverrides.a.compat.supportsDeveloperRole, supportsDeveloperRole);
  }
  for (const compat of [{ supportsStore: false }, { supportsReasoningEffort: false }, { maxTokensField: "max_tokens" }]) {
    assert.throws(() => parseConfig({ servers: [responseConfig({ modelOverrides: { a: { compat } } })] }));
  }
});

test("AC-API-4 preserved: invalid API values and model-level API overrides fail before side effects", async () => {
  for (const api of [null, "", "responses", "OPENAI-RESPONSES", false, 1, {}, []]) {
    for (const cfg of [{ servers: [config({ api })] }, (() => { const { id, ...legacy } = config({ api }); return legacy; })()]) {
      const pi = fakePi(); let requests = 0;
      await assert.rejects(registerLlamaSwapServers(pi.api, cfg, async () => { requests++; }));
      assert.equal(requests, 0); assert.equal(pi.providers.length, 0);
    }
  }
  assert.throws(() => parseConfig({ servers: [config({ modelOverrides: { a: { api: "openai-responses" } } })] }));
});

test("AC-API-4 preserved: omitted API retains completion routing, compat flags and small budgets", async () => {
  const fixture = dynamicFixture(["a"]);
  fixture.entries = [chat("a")];
  const cfg = config({ defaultMaxTokens: 15, modelOverrides: { a: { compat: {
    supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens",
  } } } });
  assert.doesNotThrow(() => parseConfig({ servers: [cfg] }));
  const p = createLlamaSwapProvider(cfg, fixture.fetch); await refresh(p);
  assert.equal(p.getModels()[0].api, "openai-completions");
  for (const method of ["stream", "streamSimple"]) {
    const result = await p[method](p.getModels()[0], transcript, { apiKey: "synthetic-key", maxTokens: 15 }).result();
    assert.equal(result.stopReason, "stop");
    const request = fixture.calls.at(-1);
    assert.equal(request.path, "/prefix/v1/chat/completions");
    assert.equal(JSON.parse(request.body).max_tokens, 15);
  }
});

test("AC-API-4 preserved: Responses fixture is valid with the installed SDK adapter", async () => {
  const model = { ...mapCatalog(listing(chat("a")), config())[0], api: "openai-responses" };
  const result = await openAIResponsesApi().stream(model, transcript, { apiKey: "synthetic-key", maxTokens: 16,
    fetch: async url => {
      assert.equal(String(url), "https://swap.invalid/prefix/v1/responses");
      return new Response(responseEvents().map(frame).join(""), { headers: { "content-type": "text/event-stream" } });
    },
  }).result();
  assert.equal(result.stopReason, "stop"); assert.equal(result.content[0].text, "hello");
  assert.equal(result.usage.totalTokens, 9);
});

test("AC-API-2 changed: both entrypoints use Responses, credentials, hooks, incremental text and usage", async () => {
  const fixture = responsesFixture(["a"]); fixture.holdResponse = true;
  const p = createLlamaSwapProvider(responseConfig({ apiKey: "synthetic-config-key" }), fixture.fetch);
  await refresh(p); const model = p.getModels()[0];
  assert.equal(model.api, "openai-responses");
  for (const method of ["stream", "streamSimple"]) {
    let incremental = false, payload, responseObserved = false, rawEvents = 0, callerCalls = 0;
    const stream = p[method](model, transcript, { apiKey: "synthetic-runtime-key", maxTokens: 100,
      fetch: async (...args) => { callerCalls++; return fixture.fetch(...args); },
      onPayload: value => { payload = value; return { ...value, temperature: 0.25 }; },
      onResponse: response => { assert.equal(response.status, 200); responseObserved = true; },
      onProviderStreamEvent: () => { rawEvents++; },
    });
    for await (const event of stream) {
      if (event.type === "text_delta") { incremental = true; assert.equal(event.delta, "hello"); fixture.releaseResponse(); }
    }
    const result = await stream.result();
    assert.equal(result.api, "openai-responses"); assert.equal(result.stopReason, "stop");
    assert.equal(result.content[0].text, "hello"); assert.equal(result.usage.input, 4);
    assert.equal(result.usage.cacheRead, 3); assert.equal(result.usage.output, 2); assert.equal(result.usage.totalTokens, 9);
    assert.ok(incremental && responseObserved); assert.equal(rawEvents, 5); assert.equal(callerCalls, 3);
    assert.equal(payload.model, "a"); assert.equal(payload.max_output_tokens, 100);
    const request = postCalls(fixture).at(-1);
    assert.equal(request.path, "/prefix/v1/responses"); assert.equal(request.key, "Bearer synthetic-runtime-key");
    assert.equal(JSON.parse(request.body).temperature, 0.25);
  }
  assert.equal(fixture.calls[0].key, "Bearer synthetic-config-key");
  assert.equal(fixture.calls.some(c => c.path.endsWith("/chat/completions")), false);
});

test("AC-API-1 AC-API-2 changed: mixed provider APIs remain isolated through the Pi model registry", async () => {
  const one = responsesFixture(["a"]), two = dynamicFixture(["a"]), pi = fakePi();
  await registerLlamaSwapServers(pi.api, { servers: [
    responseConfig({ id: "llama-swap-one", baseUrl: "https://one.invalid/prefix", apiKey: "synthetic-one" }),
    config({ id: "llama-swap-two", baseUrl: "https://two.invalid/prefix", api: "openai-completions", apiKey: "synthetic-two" }),
  ] }, (url, init) => new URL(url).hostname === "one.invalid" ? one.fetch(url, init) : two.fetch(url, init));
  const models = createModels(); for (const p of pi.providers) models.setProvider(p);
  for (const [id, api, fixture, path] of [["one", "openai-responses", one, "/prefix/v1/responses"], ["two", "openai-completions", two, "/prefix/v1/chat/completions"]]) {
    const model = models.getModel("llama-swap-" + id, "a");
    assert.equal(model.api, api);
    assert.equal((await models.completeSimple(model, transcript)).stopReason, "stop");
    assert.equal(postCalls(fixture)[0].path, path);
    assert.ok(fixture.calls.every(c => c.key === "Bearer synthetic-" + id));
  }
});

test("AC-API-2 changed: Responses tool arguments and tool-result follow-up use native wire shapes", async () => {
  const fixture = responsesFixture(["a"]); fixture.toolResponse = true;
  const p = createLlamaSwapProvider(responseConfig(), fixture.fetch); await refresh(p);
  for (const method of ["stream", "streamSimple"]) {
    fixture.toolResponse = true;
    const messages = [{ role: "system", content: "Use the tool.", toolsAdded: [{ name: "lookup", description: "Lookup", parameters: {
      type: "object", properties: { query: { type: "string" } }, required: ["query"],
    } }], timestamp: 1 }, ...transcript.messages];
    const result = await p[method](p.getModels()[0], { messages }, { apiKey: "synthetic-key" }).result();
    assert.equal(result.stopReason, "toolUse");
    const tool = result.content.find(c => c.type === "toolCall");
    assert.equal(tool.name, "lookup"); assert.deepEqual(tool.arguments, { query: "hello" });
    assert.equal(JSON.parse(postCalls(fixture).at(-1).body).tools[0].type, "function");
    fixture.toolResponse = false;
    messages.push(result, { role: "toolResult", toolCallId: tool.id, toolName: tool.name,
      content: [{ type: "text", text: "found" }], isError: false, timestamp: 2 });
    assert.equal((await p[method](p.getModels()[0], { messages }, { apiKey: "synthetic-key" }).result()).stopReason, "stop");
    const body = JSON.parse(postCalls(fixture).at(-1).body);
    const call = body.input.find(i => i.type === "function_call");
    const output = body.input.find(i => i.type === "function_call_output");
    assert.equal(output.call_id, call.call_id); assert.equal(output.output, "found");
    assert.equal(body.messages, undefined);
  }
});

test("AC-API-2 changed: developer-role compatibility changes the Responses wire role", async () => {
  for (const supportsDeveloperRole of [true, false]) {
    const fixture = responsesFixture(["a"]);
    const p = createLlamaSwapProvider(responseConfig({ modelOverrides: { a: { reasoning: true, compat: { supportsDeveloperRole } } } }), fixture.fetch);
    await refresh(p);
    assert.equal((await p.streamSimple(p.getModels()[0], { messages: [
      { role: "system", content: "Be concise.", timestamp: 0 }, ...transcript.messages,
    ] }, { apiKey: "synthetic-key" }).result()).stopReason, "stop");
    assert.equal(JSON.parse(postCalls(fixture)[0].body).input[0].role, supportsDeveloperRole ? "developer" : "system");
  }
});

test("AC-API-2 changed: unsupported Responses endpoint never falls back to completions", async () => {
  const fixture = responsesFixture(["a"]); fixture.failResponse = true;
  const p = createLlamaSwapProvider(responseConfig(), fixture.fetch); await refresh(p);
  const result = await p.streamSimple(p.getModels()[0], transcript, { apiKey: "synthetic-key", maxRetries: 0 }).result();
  assert.equal(result.stopReason, "error");
  assert.deepEqual(postCalls(fixture).map(c => c.path), ["/prefix/v1/responses"]);
});

test("AC-API-3 changed: Responses metadata keeps the API through encoded preparation, refitting and refresh", async () => {
  const fixture = responsesFixture(["org/a?b"]), id = fixture.entries[0].id;
  const p = createLlamaSwapProvider(responseConfig({ modelOverrides: { [id]: { contextWindow: 8192, maxTokens: 10000 } } }), fixture.fetch);
  await refresh(p); const model = p.getModels()[0];
  fixture.windows[id] = 6000;
  for (const method of ["stream", "streamSimple"]) {
    assert.equal((await p[method](model, transcript, { apiKey: "synthetic-key", maxTokens: 10000 }).result()).stopReason, "stop");
    assert.equal(model.api, "openai-responses"); assert.equal(model.contextWindow, fixture.windows[id]);
    const body = JSON.parse(postCalls(fixture).at(-1).body);
    // Pi's simple adapter reserves 4096 tokens and estimates this transcript at 2 tokens.
    assert.equal(body.max_output_tokens, method === "stream" ? 6000 : 8192 - 4096 - 2);
    // For the second load, the explicit context ceiling limits the larger fit.
    fixture.windows[id] = 8192;
  }
  assert.ok(fixture.calls.some(c => c.path === "/prefix/upstream/org%2Fa%3Fb/v1/models"));
  assert.ok(fixture.calls.some(c => c.path === "/prefix/upstream/org%2Fa%3Fb/props"));
  await refresh(p); assert.equal(p.getModels()[0].api, "openai-responses");
});

test("AC-API-3 changed: failed preparation or classifier retyping blocks Responses POST", async () => {
  for (const mode of ["failure", "classifier"]) {
    const fixture = responsesFixture(["a"]);
    fixture.failProps = mode === "failure"; fixture.types.a = mode === "classifier" ? "classifier" : "chat";
    const p = createLlamaSwapProvider(responseConfig(), fixture.fetch); await refresh(p);
    assert.equal((await p.streamSimple(p.getModels()[0], transcript, { apiKey: "synthetic-key" }).result()).stopReason, "error");
    assert.equal(postCalls(fixture).length, 0);
    if (mode === "classifier") assert.equal(p.getAllModels()[0].api, "typesafe-system-one");
  }
  const result = await classifier({ cfg: responseConfig() });
  assert.equal(result.model.api, "typesafe-system-one"); assert.equal(result.result.stopReason, "stop");
  assert.equal(result.calls.at(-1).url, "https://swap.invalid/prefix/upstream/judge/v1/systemone");
});

test("AC-API-3 changed: Responses holds the lease until completion and abort releases it", { timeout: 5000 }, async () => {
  for (const abort of [false, true]) {
    const fixture = responsesFixture(); fixture.holdResponse = true;
    const p = createLlamaSwapProvider(responseConfig(), fixture.fetch); await refresh(p);
    const controller = new AbortController();
    const first = p.stream(p.getModels()[0], transcript, { apiKey: "synthetic-key", signal: controller.signal });
    await waitFor(() => fixture.releaseResponse);
    const second = p.streamSimple(p.getModels()[1], transcript, { apiKey: "synthetic-key" });
    let received = false;
    for await (const event of first) {
      if (event.type === "text_delta") {
        received = true;
        assert.equal(fixture.calls.some(c => c.path.includes("/upstream/b/")), false);
        fixture.holdResponse = false;
        if (abort) controller.abort(); else fixture.releaseResponse();
      }
    }
    assert.ok(received);
    assert.equal((await first.result()).stopReason, abort ? "aborted" : "stop");
    assert.equal((await second.result()).stopReason, "stop");
    if (abort) assert.ok(fixture.cancelResponse);
  }
});

test("AC-API-5 changed: Responses rejects sub-16 budgets and releases the lease", async () => {
  for (const method of ["stream", "streamSimple"]) {
    for (const source of ["caller", "config", "context"]) {
      const fixture = responsesFixture(["a"]);
      if (source === "context") fixture.windows.a = 15;
      const cfg = responseConfig({ defaultMaxTokens: source === "config" ? 15 : 4096 });
      const p = createLlamaSwapProvider(cfg, fixture.fetch); await refresh(p);
      const result = await p[method](p.getModels()[0], transcript, { apiKey: "synthetic-key", maxTokens: source === "caller" ? 15 : 100 }).result();
      assert.equal(result.stopReason, "error");
      assert.equal(result.errorMessage, "llama-swap request preparation failed");
      assert.equal(postCalls(fixture).length, 0);
      // A separate valid static model exercises lease release after the rejected load.
      const valid = mapCatalog(listing(chat("valid")), responseConfig())[0];
      assert.equal((await p[method](valid, transcript, { apiKey: "synthetic-key", maxTokens: 16 }).result()).stopReason, "stop");
      assert.equal(JSON.parse(postCalls(fixture)[0].body).max_output_tokens, 16);
    }
  }
});

test("AC-API-2 changed: configured API wins over stale static metadata without caller mutation", async () => {
  for (const api of ["openai-completions", "openai-responses"]) {
    const fixture = responsesFixture(["a"]), cfg = config({ api });
    const p = createLlamaSwapProvider(cfg, fixture.fetch);
    const model = mapCatalog(listing(chat("a")), config({ api: api === "openai-responses" ? "openai-completions" : "openai-responses" }))[0];
    const before = structuredClone(model);
    for (const method of ["stream", "streamSimple"]) {
      let terminal;
      const stream = p[method](model, transcript, { apiKey: "synthetic-key" });
      for await (const event of stream) if (event.type === "done") terminal = event.message;
      assert.equal(terminal.api, api); assert.equal((await stream.result()).api, api);
      const rejected = await p[method](model, transcript, { apiKey: "synthetic-key", signal: AbortSignal.abort() }).result();
      assert.equal(rejected.api, api); assert.equal(rejected.stopReason, "aborted");
      assert.deepEqual(model, before);
    }
    assert.deepEqual(fixture.calls.map(c => c.path), Array(2).fill(api === "openai-responses" ? "/prefix/v1/responses" : "/prefix/v1/chat/completions"));
  }
});

test("AC-API-5 changed: missing and NaN static output limits cannot bypass Responses budget guards", async () => {
  const fixture = responsesFixture(["a"]), cfg = responseConfig();
  const p = createLlamaSwapProvider(cfg, fixture.fetch);
  for (const maxTokens of [undefined, NaN]) {
    const model = { ...mapCatalog(listing(chat("a")), cfg)[0], maxTokens };
    for (const method of ["stream", "streamSimple"]) {
      const result = await p[method](model, transcript, { apiKey: "synthetic-key" }).result();
      assert.equal(result.stopReason, "error"); assert.equal(result.errorMessage, "llama-swap request preparation failed");
    }
  }
  assert.equal(postCalls(fixture).length, 0);
});

test("AC-API-5 changed: static Responses requests respect their output ceiling and need no discovery", async () => {
  const fixture = responsesFixture(["a"]);
  const cfg = responseConfig({ defaultMaxTokens: 16 });
  const p = createLlamaSwapProvider(cfg, fixture.fetch);
  const model = mapCatalog(listing(chat("a")), cfg)[0];
  for (const method of ["stream", "streamSimple"]) {
    assert.equal((await p[method](model, transcript, { apiKey: "synthetic-key", maxTokens: 100 }).result()).stopReason, "stop");
    assert.equal(JSON.parse(postCalls(fixture).at(-1).body).max_output_tokens, 16);
    const small = { ...model, maxTokens: 15 };
    assert.equal((await p[method](small, transcript, { apiKey: "synthetic-key" }).result()).stopReason, "error");
  }
  assert.deepEqual(fixture.calls.map(c => c.path), ["/prefix/v1/responses", "/prefix/v1/responses"]);
});
