import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createLlamaSwapProvider, mapCatalog, parseConfig, registerLlamaSwapServers } from "../llama-swap.ts";
import { config, chat, decision, refresh, fakePi, context } from "./helpers.mjs";
import { apiModel, transcript } from "./dynamic-fixture.mjs";
import { responsesFixture } from "./responses-fixture.mjs";

const apis = ["openai-completions", "openai-responses"];
const approvedMap = Object.freeze({ minimal: null, high: "xhigh" });
const mappedConfig = (api, extra = {}) => config({ api, modelOverrides: {
  a: { reasoning: true, thinkingLevelMap: approvedMap },
  b: { reasoning: true, thinkingLevelMap: { minimal: "minimal", high: "high" } },
}, ...extra });
const effort = (api, body) => api === "openai-responses" ? body.reasoning?.effort : body.reasoning_effort;
const lastBody = fixture => JSON.parse(fixture.calls.at(-1).body);

test("AC-THINKING-MAP-1 changed: both formats and APIs accept exact native map keys and values", () => {
  const allLevels = { off: "none", minimal: null, low: "custom-low", medium: "medium", high: "xhigh", xhigh: "max", max: null };
  for (const api of apis) for (const map of [approvedMap, allLevels, {}]) {
    const named = config({ api, modelOverrides: { a: { thinkingLevelMap: map } } });
    const { id, ...legacy } = named;
    for (const input of [{ servers: [named] }, legacy]) {
      assert.deepEqual(parseConfig(input)[0].modelOverrides.a.thinkingLevelMap, map);
    }
  }
});

test("AC-THINKING-MAP-1 changed: catalog, refresh and preparation retain isolated copied maps", async () => {
  for (const api of apis) for (const dynamic of [false, true]) {
    const fixture = responsesFixture();
    if (!dynamic) fixture.entries = [chat("a"), chat("b"), decision("judge")];
    const cfg = mappedConfig(api, { modelOverrides: {
      a: Object.freeze({ reasoning: true, thinkingLevelMap: approvedMap }),
      b: Object.freeze({ reasoning: true, thinkingLevelMap: Object.freeze({ high: "medium" }) }),
      judge: Object.freeze({ thinkingLevelMap: approvedMap }),
    } });
    Object.freeze(cfg.modelOverrides); Object.freeze(cfg);
    const before = structuredClone(cfg);
    const provider = createLlamaSwapProvider(cfg, fixture.fetch);
    await refresh(provider);
    const a = { ...provider.getModels()[0] };
    assert.deepEqual(a.thinkingLevelMap, approvedMap);
    assert.notEqual(a.thinkingLevelMap, approvedMap);
    assert.deepEqual(provider.getModels()[1].thinkingLevelMap, { high: "medium" });
    if (dynamic) {
      await provider.prepareModel(a, { apiKey: "synthetic-key", force: true });
      assert.deepEqual(a.thinkingLevelMap, approvedMap);
      await refresh(provider);
      await provider.prepareModel(a, { apiKey: "synthetic-key", force: true });
      assert.deepEqual(a.thinkingLevelMap, approvedMap);
      assert.deepEqual(provider.getModels()[0].thinkingLevelMap, approvedMap);
    } else {
      assert.equal(Object.hasOwn(provider.getAllModels().find(m => m.id === "judge"), "thinkingLevelMap"), false);
      assert.deepEqual(fixture.calls.map(c => c.path), ["/prefix/v1/models"]);
    }
    assert.deepEqual(cfg, before);
    assert.equal(fixture.calls.some(c => c.path.includes("/upstream/b/")), false);
  }
});

test("AC-THINKING-MAP-2 changed: both APIs and entrypoints translate high, while simple minimal clamps to low", async () => {
  for (const api of apis) for (const dynamic of [false, true]) {
    const fixture = responsesFixture(["a"]);
    if (!dynamic) fixture.entries = [chat("a")];
    const provider = createLlamaSwapProvider(mappedConfig(api), fixture.fetch);
    await refresh(provider);
    const model = { ...provider.getModels()[0] };
    assert.deepEqual(getSupportedThinkingLevels(model), ["off", "low", "medium", "high"]);
    for (const method of ["stream", "streamSimple"]) {
      for (const level of ["low", "medium", "high", ...(method === "streamSimple" ? ["minimal"] : [])]) {
        const result = await provider[method](model, transcript, { apiKey: "synthetic-key", maxRetries: 0,
          ...(method === "streamSimple" ? { reasoning: level } : { reasoningEffort: level }) }).result();
        assert.equal(result.stopReason, "stop");
        assert.equal(effort(api, lastBody(fixture)), level === "high" ? "xhigh" : level === "minimal" ? "low" : level);
        assert.deepEqual(model.thinkingLevelMap, approvedMap);
      }
    }
    if (!dynamic) assert.equal(fixture.calls.some(c => c.path.includes("/upstream/")), false);
  }
});

async function mappedSession(t, reason) {
  const dir = await mkdtemp(join(tmpdir(), "pi-swap-thinking-map-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cfg = mappedConfig("openai-responses", { apiKey: "synthetic-key" });
  const fixture = responsesFixture();
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
    authPath: join(dir, "auth.json"), modelsStorePath: join(dir, "catalog.json"),
    credentials: { read: async () => undefined, list: async () => [],
      modify: async () => assert.fail("credential write"), delete: async () => assert.fail("credential deletion") } });
  let selections = 0;
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [async pi => {
      await registerLlamaSwapServers(pi, { servers: [cfg] }, fixture.fetch);
      pi.on("model_select", () => { selections++; });
    }] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model: apiModel(cfg.id), thinkingLevel: "off",
    modelRuntime: runtime, resourceLoader: loader, tools: [], settingsManager,
    sessionManager: SessionManager.inMemory(dir), sessionStartEvent: { type: "session_start", reason } });
  t.after(() => session.dispose());
  const errors = [];
  await session.bindExtensions({ onError: e => errors.push(e) });
  return { session, fixture, runtime, errors, selections: () => selections };
}

test("AC-THINKING-MAP-2 changed: SDK lifecycle and selection hide minimal and retain per-model mappings", { timeout: 15000 }, async t => {
  for (const reason of ["startup", "resume", "reload"]) await t.test(reason, async t => {
    const { session, fixture, runtime, errors, selections } = await mappedSession(t, reason);
    assert.deepEqual(session.getAvailableThinkingLevels(), ["off", "low", "medium", "high"]);
    assert.equal(session.cycleThinkingLevel(), "low");
    session.setThinkingLevel("minimal");
    assert.equal(session.thinkingLevel, "low");
    session.setThinkingLevel("high");
    await session.prompt("hello", { source: "rpc" });
    assert.equal(effort("openai-responses", lastBody(fixture)), "xhigh");
    assert.equal(selections(), 0);
    await session.setModel(runtime.getModel("llama-swap-test", "b"));
    assert.deepEqual(session.getAvailableThinkingLevels(), ["off", "minimal", "low", "medium", "high"]);
    assert.deepEqual(session.model.thinkingLevelMap, { minimal: "minimal", high: "high" });
    await session.setModel(runtime.getModel("llama-swap-test", "a"));
    assert.deepEqual(session.getAvailableThinkingLevels(), ["off", "low", "medium", "high"]);
    assert.deepEqual(session.model.thinkingLevelMap, approvedMap);
    assert.equal(selections(), 2);
    assert.deepEqual(errors, []);
  });
});

test("AC-THINKING-MAP-1 preserved: invalid maps fail before registration or HTTP without leaking values", async () => {
  const marker = "synthetic-private\nvalue";
  for (const map of [null, undefined, [], true, 1, "high", { invalid: "high" }, { high: undefined },
    { high: false }, { high: 1 }, { high: [] }, { high: {} }, { high: "" }, { high: "  " },
    { high: marker }, { high: "xhigh\u007f" }]) {
    for (const api of apis) {
      const cfg = config({ api, modelOverrides: { a: { thinkingLevelMap: map } } });
      const { id, ...legacy } = cfg;
      for (const input of [{ servers: [cfg] }, legacy]) {
        const pi = fakePi(); let calls = 0;
        await assert.rejects(registerLlamaSwapServers(pi.api, input, async () => { calls++; assert.fail("network"); }), error => {
          assert.equal(error.message.includes(marker), false); return true;
        });
        assert.equal(calls, 0); assert.equal(pi.providers.length, 0);
      }
    }
  }
});

test("AC-THINKING-MAP-3 preserved: omission retains default levels and a map alone cannot enable reasoning", async () => {
  for (const api of apis) {
    const fixture = responsesFixture(["a"]); fixture.entries = [chat("a")];
    const provider = createLlamaSwapProvider(config({ api, modelOverrides: { a: { reasoning: true } } }), fixture.fetch);
    await refresh(provider);
    const model = provider.getModels()[0];
    assert.deepEqual(getSupportedThinkingLevels(model), ["off", "minimal", "low", "medium", "high"]);
    assert.equal(model.thinkingLevelMap, undefined);
    assert.equal((await provider.streamSimple(model, transcript, { apiKey: "synthetic-key", reasoning: "minimal" }).result()).stopReason, "stop");
    assert.equal(effort(api, lastBody(fixture)), "minimal");
    const plain = mapCatalog({ data: [chat("a"), decision("judge")] }, config({ api }));
    plain[0].thinkingLevelMap = approvedMap;
    assert.deepEqual(getSupportedThinkingLevels(plain[0]), ["off"]);
    assert.equal(Object.hasOwn(plain[1], "thinkingLevelMap"), false);
    const native = createLlamaSwapProvider(config({ api }), fixture.fetch);
    assert.equal((await native.classify(plain[1], context, { apiKey: "synthetic-key" })).stopReason, "stop");
    assert.equal(lastBody(fixture).reasoning, undefined);
  }
});

test("AC-THINKING-MAP-3 preserved: direct static native maps and final payload hooks retain ownership", async () => {
  for (const api of apis) for (const method of ["stream", "streamSimple"]) {
    const fixture = responsesFixture(["a"]);
    const provider = createLlamaSwapProvider(config({ api }), fixture.fetch);
    const [model] = mapCatalog({ data: [chat("a")] }, config({ api, modelOverrides: { a: { reasoning: true } } }));
    model.thinkingLevelMap = approvedMap;
    const before = structuredClone(model);
    let hooks = 0;
    const options = { apiKey: "synthetic-key", ...(method === "streamSimple" ? { reasoning: "high" } : { reasoningEffort: "high" }),
      onPayload: body => {
        hooks++; assert.equal(effort(api, body), "xhigh");
        return api === "openai-responses" ? { ...body, reasoning: { ...body.reasoning, effort: "medium" } }
          : { ...body, reasoning_effort: "medium" };
      } };
    assert.equal((await provider[method](model, transcript, options).result()).stopReason, "stop");
    assert.equal(hooks, 1);
    assert.equal(effort(api, lastBody(fixture)), "medium");
    assert.deepEqual(model, before);
    assert.equal(fixture.calls.length, 1);
    assert.equal(provider.getAllModels().length, 0);
  }
});
