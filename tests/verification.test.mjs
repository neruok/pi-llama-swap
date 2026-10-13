import test from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai";
import { createLlamaSwapProvider } from "../llama-swap.ts";
import { classifier, config, context, listing, chat, decision, answers, json, refresh } from "./helpers.mjs";

test("AC-CLASSIFY verification: encoded alias, repeat call and immutable catalog identity", async () => {
  const catalogId = "org/a?b#c";
  const { provider, model, calls, result } = await classifier({
    catalogId, upstream: "real-model",
    cfg: config({ modelOverrides: { [catalogId]: { upstreamModelId: "real-model" } } }),
  });
  assert.equal(result.model, catalogId);
  const again = await provider.classify(model, context, { apiKey: "synthetic-key" });
  assert.equal(again.stopReason, "stop");
  assert.equal(again.model, catalogId);
  assert.equal(provider.getAllModels()[0].id, catalogId);
  assert.equal(calls.filter(x => x.url.endsWith("/systemone")).length, 2);
  for (const call of calls.filter(x => x.url.endsWith("/systemone"))) {
    assert.equal(call.url.includes("/upstream/org%2Fa%3Fb%23c/"), true);
    assert.equal(JSON.parse(call.init.body).model, "real-model");
  }
});

test("AC-CLASSIFY verification: pre-abort prevents alias GET and POST", async () => {
  const controller = new AbortController(); controller.abort();
  const { result, calls } = await classifier({ requestOptions: { signal: controller.signal } });
  assert.equal(result.stopReason, "aborted");
  assert.equal(calls.length, 1); // Only discovery.
});

test("AC-CLASSIFY verification: caller deadline interrupts response body", async () => {
  let cancelled = false, bodyController;
  const pending = classifier({
    requestOptions: { timeoutMs: 10 },
    post: () => new Response(new ReadableStream({
      start(c) { bodyController = c; },
      cancel() { cancelled = true; },
    })),
  });
  let watchdog;
  const result = await Promise.race([pending.then(x => x.result), new Promise(resolve => {
    watchdog = setTimeout(() => resolve(undefined), 250);
  })]);
  clearTimeout(watchdog);
  if (!result) { bodyController.close(); await pending; }
  assert.equal(result?.stopReason, "aborted");
  assert.equal(cancelled, true);
});

test("AC-CLASSIFY verification: successful bodies obey inclusive byte boundary", async () => {
  const body = JSON.stringify({ model: "judge", answers });
  const accepted = await classifier({ post: () => new Response(body.padEnd(2097152, " ")) });
  assert.equal(accepted.result.stopReason, "stop");
  const rejected = await classifier({ post: () => new Response(body.padEnd(2097153, " ")) });
  assert.equal(rejected.result.stopReason, "error");
});

test("AC-REFRESH verification: deadline interrupts metadata read without publication", async () => {
  let cancelled = false, streamController, published = false;
  const provider = createLlamaSwapProvider(config({ timeoutMs: 10 }), async () => new Response(new ReadableStream({
    start(c) { streamController = c; }, cancel() { cancelled = true; },
  })));
  let watchdog;
  const pending = refresh(provider, { publish: async () => { published = true; return true; } }).then(() => "success", () => "failed");
  const result = await Promise.race([pending, new Promise(resolve => { watchdog = setTimeout(() => resolve(undefined), 250); })]);
  clearTimeout(watchdog);
  if (!result) { streamController.close(); await pending; }
  assert.equal(result, "failed"); assert.equal(cancelled, true); assert.equal(published, false);
  assert.equal(provider.getAllModels().length, 0);
});

test("AC-REFRESH verification: same IDs on different servers preserve auth across chat and classify", async () => {
  const observed = [];
  const keys = { "llama-swap-a": "synthetic-a", "llama-swap-b": "synthetic-b" };
  const models = createModels({ credentials: {
    read: async id => ({ type: "api_key", key: keys[id] }),
    list: async () => [], modify: async () => undefined, delete: async () => {},
  } });
  for (const id of ["a", "b"]) {
    const baseUrl = `https://${id}.invalid`;
    const p = createLlamaSwapProvider(config({ id: "llama-swap-" + id, baseUrl }), async (url, init) => {
      observed.push({ server: id, op: String(url).endsWith("/systemone") ? "classify" : "discovery", key: new Headers(init.headers).get("authorization") });
      if (String(url).endsWith("/upstream/judge/v1/models")) return json(listing({ id: "judge" }));
      if (String(url).endsWith("/systemone")) return json({ model: "judge", answers });
      return json(listing(chat(), decision()));
    });
    models.setProvider(p);
  }
  const refreshed = await models.refresh({ allowNetwork: true });
  assert.equal(refreshed.errors.size, 0);
  assert.equal((await models.getAvailableOfType("classifier")).length, 2);
  for (const id of ["a", "b"]) {
    const providerId = "llama-swap-" + id;
    const classified = await models.classify(models.getModelOfType("classifier", providerId, "judge"), context);
    assert.equal(classified.stopReason, "stop");
    const streamed = await models.completeSimple(models.getModel(providerId, "chat"), {
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    }, { fetch: async (url, init) => {
      assert.equal(String(url), `https://${id}.invalid/v1/chat/completions`);
      observed.push({ server: id, op: "chat", key: new Headers(init.headers).get("authorization") });
      const chunk = {
        id: "synthetic-chat", object: "chat.completion.chunk", created: 1, model: "chat",
        choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    } });
    assert.equal(streamed.stopReason, "stop");
    assert.equal(streamed.content[0].text, "hello");
  }
  assert.equal(observed.length, 8);
  for (const request of observed) assert.equal(request.key, "Bearer synthetic-" + request.server);
});
