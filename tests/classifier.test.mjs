import test from "node:test";
import assert from "node:assert/strict";
import { classifier, config, context } from "./helpers.mjs";
test("AC-CLASSIFY preserved: native bool/choice/score, usage, routing and instrumentation", async () => {
  let payload, observed = false;
  const { result, calls } = await classifier({ requestOptions: {
    maxRetries: 4,
    onPayload: value => { payload = value; },
    onResponse: () => { observed = true; },
  } });
  assert.equal(result.stopReason, "stop");
  assert.equal(result.answers.approved.probability, 0.75);
  assert.equal(result.answers.category.choice, "a");
  assert.equal(result.answers.score.score, 0.4);
  assert.equal(result.usage.totalTokens, 20);
  assert.equal(payload.questions.approved.type, "noul");
  assert.equal(observed, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url, "https://swap.invalid/prefix/upstream/judge/v1/systemone");
  for (const call of calls) assert.equal(call.init.redirect, "error");
});
test("AC-CLASSIFY preserved: mismatched upstream blocks POST, mismatched result fails", async () => {
  const wrongUpstream = await classifier({ upstream: "wrong" });
  assert.equal(wrongUpstream.result.stopReason, "error");
  assert.equal(wrongUpstream.calls.length, 2);
  const wrongResult = await classifier({ resultModel: "wrong" });
  assert.equal(wrongResult.result.stopReason, "error");
  assert.equal(wrongResult.calls.length, 3);
});
test("AC-CLASSIFY changed: explicit upstream alias keeps Pi catalog identity", async () => {
  const { result, calls } = await classifier({
    cfg: config({ modelOverrides: { judge: { upstreamModelId: "real-gguf" } } }), upstream: "real-gguf",
  });
  assert.equal(result.stopReason, "stop");
  assert.equal(result.model, "judge");
  assert.equal(JSON.parse(calls[2].init.body).model, "real-gguf");
});
test("AC-CLASSIFY changed: error bodies are bounded, redacted and not retried", async () => {
  const { result, calls } = await classifier({
    post: () => new Response("private-server-message".repeat(110000), { status: 500 }),
  });
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage.includes("private-server-message"), false);
  assert.equal(result.errorMessage.length < 512, true);
  assert.equal(calls.length, 3);
});
test("AC-CLASSIFY changed: invalid caller deadline returns a safe error result", async () => {
  const { result } = await classifier({ requestOptions: { timeoutMs: -1 } });
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "llama-swap classification failed");
});
test("AC-CLASSIFY changed: cancellation interrupts JSON body read", async () => {
  const controller = new AbortController();
  let cancelled = false;
  let bodyController;
  const promise = classifier({
    requestOptions: { signal: controller.signal },
    post: () => new Response(new ReadableStream({
      start(c) { bodyController = c; c.enqueue(new TextEncoder().encode('{"model":"judge",')); queueMicrotask(() => controller.abort()); },
      cancel() { cancelled = true; },
    })),
  });
  const observed = await Promise.race([promise.then(x => x.result), new Promise(resolve => setTimeout(() => resolve(undefined), 100))]);
  if (!observed) { bodyController.close(); await promise; }
  assert.equal(observed?.stopReason, "aborted");
  assert.equal(cancelled, true);
});
