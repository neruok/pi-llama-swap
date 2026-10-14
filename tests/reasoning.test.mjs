import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createLlamaSwapProvider } from "../llama-swap.ts";
import { config, chat, decision, refresh, context } from "./helpers.mjs";
import { apiModel, dynamicFixture, transcript } from "./dynamic-fixture.mjs";
import { responsesFixture } from "./responses-fixture.mjs";

function reasoningFixture(api = "openai-completions", ids = ["a", "b"]) {
  const state = api === "openai-responses" ? responsesFixture(ids) : dynamicFixture(ids);
  const baseFetch = state.fetch;
  state.caps = {};
  state.fetch = async (input, init) => {
    const response = await baseFetch(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.pathname.endsWith("/props") || !response.ok || state.pendingProps) return response;
    const id = decodeURIComponent(url.pathname.split("/").at(-2));
    const props = await response.json();
    await state.onProps?.(id);
    return Response.json({ ...props, chat_template_caps: state.caps[id],
      chat_template: "{% if enable_thinking %}<think>{{ reasoning_effort }}</think>{% endif %}" });
  };
  return state;
}

const freezeOverrides = cfg => {
  for (const override of Object.values(cfg.modelOverrides)) Object.freeze(override);
  Object.freeze(cfg.modelOverrides);
  return Object.freeze(cfg);
};

test("AC-REASONING-1 changed: both chat APIs and entrypoints detect effort support before dispatch", async () => {
  for (const api of ["openai-completions", "openai-responses"]) {
    for (const method of ["stream", "streamSimple"]) {
      const id = "org/a?b";
      const fixture = reasoningFixture(api, [id]);
      fixture.caps[id] = { supports_reasoning_effort: true, supports_preserve_reasoning: false };
      fixture.aliases[id] = "actual-upstream-name";
      const cfg = freezeOverrides(config({ api }));
      const before = structuredClone(cfg);
      const provider = createLlamaSwapProvider(cfg, fixture.fetch);
      await refresh(provider);
      const model = { ...provider.getModels()[0] };
      assert.equal(model.reasoning, false);
      const options = { apiKey: "synthetic-key", maxRetries: 0,
        ...(method === "stream" ? { reasoningEffort: "high" } : { reasoning: "high" }) };
      assert.equal((await provider[method](model, transcript, options).result()).stopReason, "stop");
      assert.equal(model.reasoning, true);
      assert.equal(provider.getModels()[0].reasoning, true);
      const request = fixture.calls.at(-1);
      const body = JSON.parse(request.body);
      assert.equal(api === "openai-responses" ? body.reasoning?.effort : body.reasoning_effort, "high");
      assert.equal(body.model, id);
      assert.deepEqual(fixture.calls.map(c => c.path), ["/prefix/v1/models",
        "/prefix/upstream/org%2Fa%3Fb/v1/models", "/prefix/upstream/org%2Fa%3Fb/props",
        api === "openai-responses" ? "/prefix/v1/responses" : "/prefix/v1/chat/completions"]);
      assert.deepEqual(cfg, before, "detected support is not written into configured overrides");
    }
  }
});

test("AC-REASONING-2 changed: fresh preparation and refresh replace reasoning on detached and latest models", async () => {
  const fixture = reasoningFixture();
  const cfg = freezeOverrides(config());
  const provider = createLlamaSwapProvider(cfg, fixture.fetch);
  await refresh(provider);
  const model = { ...provider.getModels()[0] };
  const prepared = [];
  provider.onModelPrepared = async resolved => prepared.push(resolved.reasoning);
  for (const value of [true, false, true, undefined]) {
    fixture.caps.a = value === undefined ? undefined : { supports_reasoning_effort: value };
    await provider.prepareModel(model, { apiKey: "synthetic-key", force: true });
    assert.equal(model.reasoning, value === true);
    assert.equal(provider.getModels()[0].reasoning, value === true);
    assert.equal(provider.getModels()[1].reasoning, false);
  }
  fixture.caps.a = { supports_reasoning_effort: true };
  await refresh(provider);
  assert.equal(provider.getModels()[0].reasoning, false);
  const beforeConcurrentRefresh = provider.getModels()[0];
  fixture.onProps = async () => {
    fixture.onProps = undefined;
    await refresh(provider);
  };
  await provider.prepareModel(model, { apiKey: "synthetic-key", force: true });
  assert.notEqual(provider.getModels()[0], beforeConcurrentRefresh);
  assert.equal(provider.getModels()[0].reasoning, true);
  assert.equal(model.reasoning, true);
  assert.deepEqual(prepared, [true, false, true, false, true]);
  assert.deepEqual(cfg.modelOverrides, {});
  assert.equal(fixture.calls.some(c => c.path.includes("/upstream/b/")), false);
});

async function sessionFixture(t, reason) {
  const dir = await mkdtemp(join(tmpdir(), "pi-swap-reasoning-session-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fixture = reasoningFixture();
  fixture.caps.a = { supports_reasoning_effort: true };
  fixture.caps.b = { supports_reasoning_effort: false, supports_preserve_reasoning: true };
  const cfg = config({ apiKey: "synthetic-session-key" });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
    authPath: join(dir, "auth.json"), modelsStorePath: join(dir, "catalog.json"),
    credentials: { read: async () => undefined, list: async () => [],
      modify: async () => assert.fail("credential write"), delete: async () => assert.fail("credential deletion") } });
  let selections = 0;
  const { registerLlamaSwapServers } = await import("../llama-swap.ts");
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
  await session.bindExtensions({ onError: error => errors.push(error) });
  return { session, fixture, runtime, errors, selections: () => selections };
}

test("AC-REASONING-2 changed: SDK startup/resume/reload and selection enable thinking controls without recursion", { timeout: 15000 }, async t => {
  for (const reason of ["startup", "resume", "reload"]) {
    await t.test(reason, async t => {
      const { session, fixture, runtime, errors, selections } = await sessionFixture(t, reason);
      assert.equal(session.model.reasoning, true);
      assert.equal(session.supportsThinking(), true);
      assert.equal(session.cycleThinkingLevel(), "minimal");
      assert.equal(selections(), 0);
      assert.equal(fixture.calls.some(c => c.path.includes("/upstream/b/")), false);
      await session.setModel(runtime.getModel("llama-swap-test", "b"));
      assert.equal(session.model.reasoning, false);
      assert.equal(session.supportsThinking(), false);
      assert.equal(session.cycleThinkingLevel(), undefined);
      assert.equal(selections(), 1);
      await session.setModel(runtime.getModel("llama-swap-test", "a"));
      assert.equal(session.supportsThinking(), true);
      assert.notEqual(session.cycleThinkingLevel(), undefined);
      assert.equal(selections(), 2);
      fixture.caps.a = undefined;
      await session.prompt("hello", { source: "rpc" });
      assert.equal(session.supportsThinking(), false);
      assert.equal(session.cycleThinkingLevel(), undefined);
      assert.equal(session.getLastAssistantText(), "hello");
      assert.equal(selections(), 2);
      assert.deepEqual(errors, []);
    });
  }
});

test("AC-REASONING-3 preserved: explicit true and false overrides win without mutating configuration", async () => {
  for (const api of ["openai-completions", "openai-responses"]) {
    for (const reasoning of [true, false]) {
      for (const caps of [{ supports_reasoning_effort: !reasoning }, undefined]) {
        const fixture = reasoningFixture(api, ["a"]);
        fixture.caps.a = caps;
        const cfg = freezeOverrides(config({ api, modelOverrides: { a: { reasoning } } }));
        const before = structuredClone(cfg);
        const provider = createLlamaSwapProvider(cfg, fixture.fetch);
        await refresh(provider);
        const model = { ...provider.getModels()[0] };
        await provider.prepareModel(model, { apiKey: "synthetic-key", force: true });
        assert.equal(model.reasoning, reasoning);
        assert.equal(provider.getModels()[0].reasoning, reasoning);
        const result = await provider.streamSimple(model, transcript, { apiKey: "synthetic-key", reasoning: "high", maxRetries: 0 }).result();
        assert.equal(result.stopReason, "stop");
        const body = JSON.parse(fixture.calls.at(-1).body);
        assert.equal(api === "openai-responses" ? body.reasoning?.effort : body.reasoning_effort,
          reasoning ? "high" : undefined);
        assert.deepEqual(cfg, before);
      }
    }
  }
});

test("AC-REASONING-3 preserved: malformed, absent and preserve-only metadata do not imply thinking", async () => {
  const capsValues = [undefined, null, [], "true", 1, {}, { supports_preserve_reasoning: true },
    ...[undefined, null, false, "true", 1, [], {}].map(value => ({ supports_reasoning_effort: value, supports_preserve_reasoning: true }))];
  for (const caps of capsValues) {
    const fixture = reasoningFixture("openai-completions", ["Qwen-thinking"]);
    fixture.caps["Qwen-thinking"] = caps;
    const provider = createLlamaSwapProvider(config(), fixture.fetch);
    await refresh(provider);
    assert.deepEqual(fixture.calls.map(c => c.path), ["/prefix/v1/models"]);
    assert.equal(fixture.loaded, undefined);
    const model = { ...provider.getModels()[0] };
    await provider.prepareModel(model, { apiKey: "synthetic-key" });
    assert.equal(model.reasoning, false);
    assert.equal(provider.getModels()[0].reasoning, false);
    assert.equal(model.contextPending, false, "valid context still permits preparation");
    assert.equal(fixture.calls.length, 3);
  }
});

test("AC-REASONING-3 preserved: static, non-llama.cpp and classifier routing remains unchanged", async () => {
  const staticFixture = reasoningFixture("openai-completions", ["a"]);
  staticFixture.entries = [chat("a")];
  staticFixture.caps.a = { supports_reasoning_effort: true };
  const staticProvider = createLlamaSwapProvider(config(), staticFixture.fetch);
  await refresh(staticProvider);
  assert.equal((await staticProvider.streamSimple(staticProvider.getModels()[0], transcript, { apiKey: "synthetic-key" }).result()).stopReason, "stop");
  assert.equal(staticProvider.getModels()[0].reasoning, false);
  assert.deepEqual(staticFixture.calls.map(c => c.path), ["/prefix/v1/models", "/prefix/v1/chat/completions"]);
  for (const reasoning of [undefined, true, false]) {
    const fixture = reasoningFixture("openai-completions", ["a"]);
    fixture.owners.a = "vllm";
    fixture.nativeContexts.a = 8192;
    fixture.caps.a = { supports_reasoning_effort: true };
    const provider = createLlamaSwapProvider(config({ modelOverrides: reasoning === undefined ? {} : { a: { reasoning } } }), fixture.fetch);
    await refresh(provider);
    const model = await provider.prepareModel(provider.getModels()[0], { apiKey: "synthetic-key" });
    assert.equal(model.reasoning, reasoning ?? false);
    assert.equal(fixture.calls.some(c => c.path.endsWith("/props")), false);
  }
  const fixture = reasoningFixture("openai-completions", ["judge"]);
  fixture.entries = [{ ...decision("judge"), status: { value: "unloaded" } }];
  fixture.types.judge = "classifier";
  fixture.caps.judge = { supports_reasoning_effort: true };
  const provider = createLlamaSwapProvider(config(), fixture.fetch);
  await refresh(provider);
  const model = provider.getAllModels()[0];
  assert.equal((await provider.classify(model, context, { apiKey: "synthetic-key" })).stopReason, "stop");
  assert.equal(Object.hasOwn(model, "reasoning"), false);
  assert.equal(JSON.parse(fixture.calls.at(-1).body).reasoning, undefined);
  assert.equal(fixture.calls.at(-1).path, "/prefix/upstream/judge/v1/systemone");
});

test("AC-REASONING-3 preserved: failure and cancellation do not publish detected support or send inference", async () => {
  for (const failure of ["http", "context", "cancel"]) {
    const fixture = reasoningFixture("openai-completions", ["a"]);
    fixture.caps.a = { supports_reasoning_effort: true };
    fixture.failProps = failure === "http";
    if (failure === "context") fixture.windows.a = 0;
    const abort = new AbortController();
    if (failure === "cancel") fixture.onProps = () => abort.abort();
    const provider = createLlamaSwapProvider(config(), fixture.fetch);
    await refresh(provider);
    const model = { ...provider.getModels()[0] };
    let publications = 0;
    provider.onModelPrepared = async () => { publications++; };
    const result = await provider.streamSimple(model, transcript, { apiKey: "synthetic-key", signal: abort.signal, reasoning: "high" }).result();
    assert.equal(result.stopReason, failure === "cancel" ? "aborted" : "error");
    assert.equal(model.reasoning, false);
    assert.equal(provider.getModels()[0].reasoning, false);
    assert.equal(provider.getModels()[0].contextPending, true);
    assert.equal(publications, 0);
    assert.equal(fixture.calls.some(c => c.path.endsWith("/chat/completions")), false);
  }
});
