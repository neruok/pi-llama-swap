import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerLlamaSwapServers } from "../llama-swap.ts";
import { config, decision, context } from "./helpers.mjs";
const { Type } = await import(createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("typebox"));
import { apiModel, dynamicFixture } from "./dynamic-fixture.mjs";

async function sessionFixture(t, { reason = "startup", failProps = false, classifierTurn = false, failAfterClassifier = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-swap-dynamic-session-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cfg = config({ apiKey: "synthetic-session-key" });
  const fixture = dynamicFixture(); fixture.failProps = failProps;
  if (classifierTurn) {
    fixture.entries.push({ ...decision("judge"), status: { value: "unloaded" } });
    fixture.types.judge = "classifier"; fixture.windows.judge = 2048; fixture.toolCallOnce = true;
  }
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: classifierTurn ? 1 : 8192 }, retry: { enabled: false } });
  const manager = SessionManager.inMemory(dir);
  manager.appendMessage({ role: "user", content: "previous input", timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "previous answer" }],
    api: "openai-completions", provider: cfg.id, model: "a", timestamp: 2, stopReason: "stop",
    usage: { input: 40000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 40001,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
    authPath: join(dir, "auth.json"), modelsStorePath: join(dir, "catalog.json"),
    credentials: { read: async () => undefined, list: async () => [], modify: async () => assert.fail("credential write"), delete: async () => assert.fail("credential deletion") } });
  let selections = 0;
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [async pi => {
      await registerLlamaSwapServers(pi, { servers: [cfg] }, fixture.fetch);
      pi.on("model_select", () => { selections++; });
      if (classifierTurn) pi.registerTool({ name: "dynamic_judge", label: "Synthetic classifier", description: "Call the synthetic native classifier",
        parameters: Type.Object({}),
        execute: async (_id, _params, signal, _update, ctx) => {
          const model = ctx.modelRegistry.findOfType("classifier", cfg.id, "judge");
          assert.equal((await ctx.modelRegistry.classify(model, context, { signal })).stopReason, "stop");
          fixture.windows.a = 49152;
          fixture.failProps = failAfterClassifier;
          return { content: [{ type: "text", text: "classified" }], details: {} };
        },
      });
    }] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model: apiModel(cfg.id), thinkingLevel: "off",
    modelRuntime: runtime, resourceLoader: loader, tools: classifierTurn ? ["dynamic_judge"] : [], settingsManager, sessionManager: manager,
    sessionStartEvent: { type: "session_start", reason } });
  t.after(() => session.dispose());
  const errors = [];
  await session.bindExtensions({ onError: error => errors.push(error) });
  if (classifierTurn) session.setActiveToolsByName(["dynamic_judge"]);
  return { session, fixture, runtime, errors, selections: () => selections };
}

test("AC-DYNAMIC-3 changed: SDK startup/resume/reload resolves current metadata before compaction and inference", { timeout: 15000 }, async t => {
  for (const reason of ["startup", "resume", "reload"]) {
    await t.test(reason, async t => {
      const { session, fixture, selections } = await sessionFixture(t, { reason });
      assert.equal(session.model.contextWindow, 65536);
      assert.equal(session.model.contextPending, false);
      assert.equal(session.model.id, "a");
      assert.equal(selections(), 0);
      assert.equal(fixture.calls.some(c => c.path.includes("/upstream/b/")), false);
      let compactions = 0;
      session.subscribe(e => { if (e.type === "compaction_start") compactions++; });
      await session.prompt("hello", { source: "rpc" });
      assert.equal(session.getLastAssistantText(), "hello");
      assert.equal(compactions, 0);
      assert.equal(session.model.contextWindow, 65536);
      assert.equal(fixture.calls.filter(c => c.path.endsWith("/chat/completions")).length, 1);
    });
  }
});

test("AC-DYNAMIC-3 changed: SDK selection updates metadata without recursion and revalidates a later fitted load", { timeout: 10000 }, async t => {
  const { session, fixture, runtime, selections } = await sessionFixture(t);
  fixture.windows.b = 2048;
  await session.setModel(runtime.getModel("llama-swap-test", "b"));
  assert.equal(session.model.id, "b");
  assert.equal(session.model.contextWindow, 2048);
  assert.equal(session.model.maxTokens, 2048);
  assert.equal(selections(), 1);
  fixture.windows.a = 131072;
  await session.setModel(runtime.getModel("llama-swap-test", "a"));
  assert.equal(session.model.contextWindow, 131072);
  assert.equal(selections(), 2);
  await session.prompt("hello");
  assert.equal(session.getLastAssistantText(), "hello");
  assert.equal(selections(), 2);
});

test("AC-DYNAMIC-3 changed: SDK failed preparation blocks user input and custom-turn compaction/inference", { timeout: 10000 }, async t => {
  const { session, fixture, errors } = await sessionFixture(t, { failProps: true });
  let preflight;
  await session.prompt("hello", { source: "rpc", preflightResult: result => { preflight = result; } });
  assert.equal(preflight, "handled");
  assert.equal(fixture.calls.some(c => c.path.endsWith("/chat/completions")), false);
  const before = session.sessionManager.getEntries().filter(e => e.type === "compaction").length;
  await session.sendCustomMessage({ customType: "synthetic-trigger", content: "continue", display: false }, { triggerTurn: true });
  assert.equal(fixture.calls.some(c => c.path.endsWith("/chat/completions")), false);
  assert.equal(session.sessionManager.getEntries().filter(e => e.type === "compaction").length, before);
  assert.equal(errors.some(e => e.error?.includes("synthetic-private-body")), false);
});

test("AC-DYNAMIC-3 changed: SDK classifier tool swaps back and resolves fitted chat context before next-turn compaction", { timeout: 10000 }, async t => {
  const { session, fixture } = await sessionFixture(t, { classifierTurn: true });
  assert.equal(session.autoCompactionEnabled, true);
  const budgets = [], summaries = [];
  // Observe the installed SDK's budget entry without replacing its behavior.
  const beforeResponse = session._compactBeforeNextAssistantResponse.bind(session);
  session._compactBeforeNextAssistantResponse = async context => {
    budgets.push({ id: fixture.loaded, window: session.model.contextWindow, pending: session.model.contextPending });
    return beforeResponse(context);
  };
  session.subscribe(e => {
    if (e.type === "compaction_start") summaries.push({ window: session.model.contextWindow, pending: session.model.contextPending });
  });
  await session.prompt("classify this");
  assert.equal(session.getLastAssistantText(), "hello");
  assert.equal(fixture.calls.filter(c => c.path.endsWith("/systemone")).length, 1, JSON.stringify(session.agent.state.messages.filter(m => m.role === "toolResult")));
  assert.deepEqual(budgets, [{ id: "a", window: 49152, pending: false }]);
  assert.deepEqual(summaries, [{ window: 49152, pending: false }]);
  assert.equal(session.model.contextWindow, 49152);
  assert.equal(session.sessionManager.getEntries().filter(e => e.type === "compaction").length, 1);
});

test("AC-DYNAMIC-3 changed: SDK failed chat reload after a classifier tool cancels continuation and summary", { timeout: 10000 }, async t => {
  const { session, fixture } = await sessionFixture(t, { classifierTurn: true, failAfterClassifier: true });
  await session.prompt("classify this");
  assert.equal(fixture.calls.filter(c => c.path.endsWith("/systemone")).length, 1, JSON.stringify(session.agent.state.messages.filter(m => m.role === "toolResult")));
  assert.equal(fixture.calls.filter(c => c.path.endsWith("/chat/completions")).length, 1);
  assert.equal(session.model.contextPending, true);
  assert.equal(session.sessionManager.getEntries().filter(e => e.type === "compaction").length, 0);
});
