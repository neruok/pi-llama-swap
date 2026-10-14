import test from "node:test";
import assert from "node:assert/strict";
import { openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { createLlamaSwapProvider, mapCatalog } from "../llama-swap.ts";
import { config, chat, listing, refresh } from "./helpers.mjs";
import { transcript } from "./dynamic-fixture.mjs";
import { responsesFixture, responseEvents, frame } from "./responses-fixture.mjs";

function heldResponse(api, tool) {
  const state = { calls: 0, aborted: 0 };
  state.fetch = async (_input, init) => {
    state.calls++;
    const chunk = { id: "cancel-fixture", model: "chat", choices: [{ index: 0,
      delta: tool ? { tool_calls: [{ index: 0, id: "call_fixture", type: "function",
        function: { name: "lookup", arguments: '{"query":"hello"}' } }] } : { content: "hello" }, finish_reason: null }],
      usage: { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 } };
    const body = api === "openai-responses" ? responseEvents({ tool }).slice(0, 3).map(frame).join("")
      : `data: ${JSON.stringify(chunk)}\n\n`;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        init.signal.addEventListener("abort", () => { state.aborted++; controller.error(new Error("synthetic cancellation")); }, { once: true });
      },
    }), { headers: { "content-type": "text/event-stream" } });
  };
  return state;
}

for (const api of ["openai-completions", "openai-responses"]) {
  for (const method of ["stream", "streamSimple"]) {
    for (const tool of [false, true]) {
      test(`AC-API-6 regression: ${api} ${method} retains aborted ${tool ? "tool" : "text"} content and usage`, async () => {
        const cfg = config({ api });
        const [model] = mapCatalog(listing(chat()), cfg);
        const results = [];
        for (const wrapped of [false, true]) {
          const fixture = heldResponse(api, tool);
          const provider = wrapped ? createLlamaSwapProvider(cfg, fixture.fetch)
            : api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi();
          const abort = new AbortController();
          const stream = provider[method]({ ...model }, transcript, { apiKey: "synthetic-key", fetch: fixture.fetch,
            signal: abort.signal, maxRetries: 0 });
          let deltas = 0, terminals = 0;
          for await (const event of stream) {
            if (event.type === (tool ? "toolcall_delta" : "text_delta")) { deltas++; abort.abort(); }
            if (event.type === "error" || event.type === "done") terminals++;
          }
          const final = await stream.result();
          assert.equal(deltas, 1); assert.equal(terminals, 1);
          assert.equal(final.stopReason, "aborted");
          assert.equal(fixture.calls, 1); assert.equal(fixture.aborted, 1);
          results.push(final);
        }
        assert.ok(results[0].content.length > 0, "direct SDK must retain the fixture's partial");
        assert.deepEqual(results[1].content, results[0].content);
        assert.deepEqual(results[1].usage, results[0].usage);
        if (api === "openai-completions") assert.equal(results[1].usage.totalTokens, 20);
        else assert.equal(results[1].usage.totalTokens, 0, "Responses has not reported usage before its completed event");
        for (const part of results[1].content) {
          assert.equal("partialJson" in part, false); assert.equal("index" in part, false);
        }
      });
    }
    test(`AC-API-6 preserved: ${api} ${method} retains non-abort native failures without retry or fallback`, async () => {
      const cfg = config({ api });
      const [model] = mapCatalog(listing(chat()), cfg);
      const results = [];
      for (const wrapped of [false, true]) {
        let calls = 0;
        const fetch = async () => { calls++; return Response.json({ error: { message: "synthetic unavailable endpoint" } }, { status: 404 }); };
        const provider = wrapped ? createLlamaSwapProvider(cfg, fetch)
          : api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi();
        const stream = provider[method]({ ...model }, transcript, { apiKey: "synthetic-key", fetch, maxRetries: 0 });
        let terminals = 0;
        for await (const event of stream) if (event.type === "error" || event.type === "done") terminals++;
        const result = await stream.result();
        assert.equal(result.stopReason, "error"); assert.equal(calls, 1); assert.equal(terminals, 1);
        results.push(result);
      }
      assert.deepEqual(results[1].content, results[0].content);
      assert.deepEqual(results[1].usage, results[0].usage);
      assert.equal(results[1].errorMessage, results[0].errorMessage);
    });
    test(`AC-API-6 preserved: ${api} ${method} pre-abort prevents dispatch and does not poison the lease`, async () => {
      const fixture = responsesFixture(["a"]);
      fixture.entries = [chat("a")];
      const provider = createLlamaSwapProvider(config({ api }), fixture.fetch);
      await refresh(provider);
      const before = fixture.calls.length;
      const abort = new AbortController(); abort.abort();
      const result = await provider[method](provider.getModels()[0], transcript, { apiKey: "synthetic-key", signal: abort.signal }).result();
      assert.equal(result.stopReason, "aborted"); assert.deepEqual(result.content, []);
      assert.equal(result.usage.totalTokens, 0); assert.equal(fixture.calls.length, before);
      const completed = new AbortController();
      const nextStream = provider[method](provider.getModels()[0], transcript, { apiKey: "synthetic-key", maxRetries: 0, signal: completed.signal });
      const next = await nextStream.result();
      assert.equal(next.stopReason, "stop");
      completed.abort(); assert.equal((await nextStream.result()).stopReason, "stop");
    });
  }
}

for (const api of ["openai-completions", "openai-responses"]) {
  test(`AC-API-6 ${api} retains active leases until aborting I/O settles and other providers remain independent`, async () => {
    const cfg = config({ api });
    const [model] = mapCatalog(listing(chat("a")), cfg);
    const normal = responsesFixture(["a"]);
    const reached = Promise.withResolvers(), release = Promise.withResolvers();
    let holding = true, settled = false, heldCalls = 0;
    const provider = createLlamaSwapProvider(cfg, async (...args) => {
      if (holding) {
        heldCalls++; reached.resolve();
        // An intentionally non-cooperative fetch cannot complete before this gate.
        await release.promise;
      }
      return normal.fetch(...args);
    });
    const independent = createLlamaSwapProvider(config({ api, id: "llama-swap-other" }), normal.fetch);
    const abort = new AbortController();
    const first = provider.stream({ ...model }, transcript, { apiKey: "synthetic-key", signal: abort.signal, maxRetries: 0 });
    void first.result().then(() => { settled = true; });
    await reached.promise; abort.abort();
    const next = provider.streamSimple({ ...model }, transcript, { apiKey: "synthetic-key", maxRetries: 0 });
    const other = await independent.streamSimple({ ...model, provider: "llama-swap-other" }, transcript, { apiKey: "synthetic-other", maxRetries: 0 }).result();
    try {
      assert.equal(other.stopReason, "stop");
      assert.equal(settled, false, "active result must wait for the native adapter, not synthetic abort output");
      assert.equal(heldCalls, 1, "the next same-provider request cannot dispatch yet");
      assert.equal(normal.calls.length, 1);
      assert.equal(normal.calls[0].key, "Bearer synthetic-other");
    } finally {
      holding = false; release.resolve();
    }
    assert.equal((await first.result()).stopReason, "aborted");
    assert.equal((await next.result()).stopReason, "stop");
    assert.equal(heldCalls, 1);
  });
}

test("AC-API-6 preserved: Responses cancellation, failed props and metadata deadlines release their leases", async () => {
  for (const mode of ["abort", "failure", "deadline"]) {
    const fixture = responsesFixture(["a"]);
    fixture.holdResponse = mode === "abort";
    fixture.failProps = mode === "failure"; fixture.pendingProps = mode === "deadline";
    const provider = createLlamaSwapProvider(config({ api: "openai-responses", loadTimeoutMs: 20 }), fixture.fetch);
    await refresh(provider);
    const abort = new AbortController();
    const first = provider.stream(provider.getModels()[0], transcript, { apiKey: "synthetic-key", signal: abort.signal, maxRetries: 0 });
    for await (const event of first) if (event.type === "text_delta") abort.abort();
    assert.equal((await first.result()).stopReason, mode === "abort" ? "aborted" : "error");
    if (mode === "abort") assert.equal(fixture.cancelResponse, true);
    else assert.equal(fixture.calls.some(call => call.path.endsWith("/responses")), false);
    fixture.holdResponse = false; fixture.failProps = false; fixture.pendingProps = false; fixture.windows.a = 8192;
    const second = await provider.streamSimple(provider.getModels()[0], transcript, { apiKey: "synthetic-key", maxRetries: 0 }).result();
    assert.equal(second.stopReason, "stop");
    assert.equal(provider.getModels()[0].contextWindow, 8192);
    assert.equal(provider.getModels()[0].contextPending, false);
  }
});
