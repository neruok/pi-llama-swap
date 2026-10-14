import test from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai";
import { createLlamaSwapProvider, parseConfig, registerLlamaSwapServers } from "../llama-swap.ts";
import { config, chat, classifier, refresh, fakePi } from "./helpers.mjs";
import { transcript } from "./dynamic-fixture.mjs";
import { responsesFixture } from "./responses-fixture.mjs";

const apis = ["openai-completions", "openai-responses"];
const methods = ["stream", "streamSimple"];
const chatCalls = fixture => fixture.calls.filter(c => c.path.endsWith("/responses") || c.path.endsWith("/chat/completions"));
const payload = fixture => JSON.parse(chatCalls(fixture).at(-1).body);
const toolTranscript = { messages: [{ role: "system", content: "Use lookup when needed.", timestamp: 0,
  toolsAdded: [{ name: "lookup", description: "Lookup", parameters: {
    type: "object", properties: { query: { type: "string" } }, required: ["query"],
  } }],
}, ...transcript.messages] };

async function setup(api, settings = {}, dynamic = false) {
  const fixture = responsesFixture(["a", "b"]);
  if (!dynamic) fixture.entries = [chat("a"), chat("b")];
  const provider = createLlamaSwapProvider(config({ api, ...settings }), fixture.fetch);
  await refresh(provider);
  return { fixture, provider };
}

// AC-PARALLEL-1
test("AC-PARALLEL-1 changed: both formats and APIs retain explicit booleans", () => {
  for (const api of apis) for (const parallelToolCalls of [false, true]) {
    const named = config({ api, parallelToolCalls });
    const { id, ...legacy } = named;
    assert.equal(parseConfig({ servers: [named] })[0].parallelToolCalls, parallelToolCalls);
    assert.equal(parseConfig(legacy)[0].parallelToolCalls, parallelToolCalls);
  }
});

// AC-PARALLEL-2
test("AC-PARALLEL-2 changed: both entrypoints send server values for every static and dynamic model", async () => {
  for (const api of apis) for (const parallelToolCalls of [false, true]) for (const dynamic of [false, true]) {
    const { fixture, provider } = await setup(api, { parallelToolCalls }, dynamic);
    for (const model of provider.getModels()) for (const method of methods) {
      const result = await provider[method](model, toolTranscript, { apiKey: "synthetic-key", maxTokens: 128 }).result();
      assert.equal(result.stopReason, "stop");
      assert.equal(payload(fixture).parallel_tool_calls, parallelToolCalls);
      assert.equal(payload(fixture).model, model.id);
      assert.equal(payload(fixture).tools[0].type, "function");
      assert.equal(chatCalls(fixture).at(-1).path,
        api === "openai-responses" ? "/prefix/v1/responses" : "/prefix/v1/chat/completions");
      if (dynamic) {
        assert.ok(fixture.calls.some(c => c.path === `/prefix/upstream/${model.id}/v1/models`));
        assert.ok(fixture.calls.some(c => c.path === `/prefix/upstream/${model.id}/props`));
      }
    }
    if (!dynamic) assert.equal(fixture.calls.some(c => c.path.includes("/upstream/")), false);
  }
});

// AC-PARALLEL-3
test("AC-PARALLEL-3 changed: server precedence preserves sampling, hooks and frozen caller options", async () => {
  for (const api of apis) for (const method of methods) for (const parallelToolCalls of [false, true]) {
    const { fixture, provider } = await setup(api, { parallelToolCalls });
    const model = provider.getModels()[0];
    model.samplingParams = Object.freeze({ parallel_tool_calls: !parallelToolCalls, top_p: 0.8 });
    const samplingParams = Object.freeze({ parallel_tool_calls: !parallelToolCalls, temperature: 0.25 });
    for (const hookMode of ["observe", "mutate", "replace"]) {
      let hooks = 0, responses = 0, events = 0;
      const options = Object.freeze({ apiKey: "synthetic-key", maxTokens: 128, samplingParams,
        onPayload: async body => {
          hooks++;
          assert.equal(body.parallel_tool_calls, parallelToolCalls);
          assert.equal(body.top_p, 0.8);
          assert.equal(body.temperature, 0.25);
          if (hookMode === "mutate") body.parallel_tool_calls = !parallelToolCalls;
          if (hookMode === "replace") return { ...body, parallel_tool_calls: !parallelToolCalls, temperature: 0.5 };
        },
        onResponse: () => { responses++; },
        onProviderStreamEvent: () => { events++; },
      });
      const result = await provider[method](model, toolTranscript, options).result();
      assert.equal(result.stopReason, "stop");
      assert.equal(payload(fixture).parallel_tool_calls, hookMode === "observe" ? parallelToolCalls : !parallelToolCalls);
      assert.equal(payload(fixture).top_p, 0.8);
      assert.equal(payload(fixture).temperature, hookMode === "replace" ? 0.5 : 0.25);
      assert.equal(hooks, 1); assert.equal(responses, 1); assert.ok(events > 0);
      assert.equal(options.samplingParams, samplingParams);
      assert.deepEqual(samplingParams, { parallel_tool_calls: !parallelToolCalls, temperature: 0.25 });
      assert.deepEqual(model.samplingParams, { parallel_tool_calls: !parallelToolCalls, top_p: 0.8 });
    }
  }
});

// AC-PARALLEL-3
test("AC-PARALLEL-3 changed: mixed providers retain independent flags and credentials", async () => {
  const fixtures = Object.fromEntries(["one", "two", "three"].map(id => [id, responsesFixture(["a"])]));
  const pi = fakePi();
  await registerLlamaSwapServers(pi.api, { servers: [
    config({ id: "llama-swap-one", baseUrl: "https://one.invalid/prefix", api: "openai-responses", apiKey: "synthetic-one", parallelToolCalls: false }),
    config({ id: "llama-swap-two", baseUrl: "https://two.invalid/prefix", apiKey: "synthetic-two", parallelToolCalls: true }),
    config({ id: "llama-swap-three", baseUrl: "https://three.invalid/prefix", api: "openai-responses", apiKey: "synthetic-three" }),
  ] }, (url, init) => fixtures[new URL(url).hostname.split(".")[0]].fetch(url, init));
  const models = createModels(); for (const provider of pi.providers) models.setProvider(provider);
  for (const [id, expected] of [["one", false], ["two", true], ["three", undefined]]) {
    const model = models.getModel("llama-swap-" + id, "a");
    assert.equal((await models.completeSimple(model, toolTranscript)).stopReason, "stop");
    assert.equal(payload(fixtures[id]).parallel_tool_calls, expected);
    if (expected === undefined) assert.equal(Object.hasOwn(payload(fixtures[id]), "parallel_tool_calls"), false);
    assert.ok(fixtures[id].calls.every(c => c.key === "Bearer synthetic-" + id));
  }
});

// AC-PARALLEL-3
test("AC-PARALLEL-3 changed: server chat flag does not enter native classifier requests", async () => {
  for (const api of apis) for (const parallelToolCalls of [false, true]) {
    const { result, calls } = await classifier({ cfg: config({ api, parallelToolCalls }) });
    assert.equal(result.stopReason, "stop");
    const post = calls.find(c => c.init?.method === "POST");
    assert.ok(post.url.endsWith("/systemone"));
    assert.equal(Object.hasOwn(JSON.parse(post.init.body), "parallel_tool_calls"), false);
  }
});

// AC-PARALLEL-4
test("AC-PARALLEL-4 preserved: omission retains existing model, request and hook behavior", async () => {
  for (const api of apis) for (const method of methods) {
    const { fixture, provider } = await setup(api);
    assert.equal(parseConfig({ servers: [config({ api })] })[0].parallelToolCalls, undefined);
    for (const [modelValue, callerValue, expected] of [[undefined, undefined, undefined], [true, undefined, true], [true, false, false], [undefined, true, true]]) {
      const model = provider.getModels()[0];
      model.samplingParams = modelValue === undefined ? undefined : { parallel_tool_calls: modelValue };
      const options = { apiKey: "synthetic-key", maxTokens: 128,
        ...(callerValue === undefined ? {} : { samplingParams: { parallel_tool_calls: callerValue } }) };
      assert.equal((await provider[method](model, toolTranscript, options).result()).stopReason, "stop");
      assert.equal(payload(fixture).parallel_tool_calls, expected);
      if (expected === undefined) assert.equal(Object.hasOwn(payload(fixture), "parallel_tool_calls"), false);
    }
    assert.equal((await provider[method](provider.getModels()[0], toolTranscript, { apiKey: "synthetic-key", maxTokens: 128,
      onPayload: body => ({ ...body, parallel_tool_calls: false }),
    }).result()).stopReason, "stop");
    assert.equal(payload(fixture).parallel_tool_calls, false);
  }
});

// AC-PARALLEL-4
test("AC-PARALLEL-4 preserved: invalid values and model overrides fail before any side effects", async () => {
  for (const api of apis) {
    const invalidConfigs = [null, undefined, "", "false", 0, 1, {}, []].map(parallelToolCalls => config({ api, parallelToolCalls }));
    invalidConfigs.push(config({ api, modelOverrides: { a: { parallelToolCalls: false } } }));
    for (const named of invalidConfigs) {
      const { id, ...legacy } = named;
      for (const value of [{ servers: [named] }, legacy]) {
        let requests = 0; const pi = fakePi();
        await assert.rejects(registerLlamaSwapServers(pi.api, value, async () => { requests++; }));
        assert.equal(requests, 0); assert.equal(pi.providers.length, 0);
      }
      assert.throws(() => createLlamaSwapProvider(named));
    }
  }
});
