import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLlamaSwapProvider, parseConfig } from "../llama-swap.ts";
import { config, listing, chat, decision, refresh, context, answers, json } from "./helpers.mjs";

async function fixture(t, handler) {
  const dir = await mkdtemp(join(tmpdir(), "pi-llama-swap-tls-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"),
    "-out", join(dir, "cert.pem"), "-subj", "/CN=localhost", "-days", "1"], { stdio: "ignore" });
  const server = https.createServer({ key: await readFile(join(dir, "key.pem")), cert: await readFile(join(dir, "cert.pem")) }, handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { server, baseUrl: `https://127.0.0.1:${server.address().port}` };
}
const send = (res, body) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };

test("AC-TLS-1 changed: boolean toggle in both formats and secure default", () => {
  assert.equal(parseConfig({ servers: [{ id: "llama-swap-test", baseUrl: "https://localhost" }] })[0].tlsVerify, true);
  for (const tlsVerify of [true, false]) {
    assert.equal(parseConfig({ servers: [{ id: "llama-swap-test", baseUrl: "https://localhost", tlsVerify }] })[0].tlsVerify, tlsVerify);
    const { id, ...legacy } = config({ tlsVerify });
    assert.equal(parseConfig(legacy)[0].tlsVerify, tlsVerify);
  }
  for (const tlsVerify of [null, 0, 1, "false", {}, []]) {
    assert.throws(() => parseConfig({ servers: [{ id: "llama-swap-test", baseUrl: "https://localhost", tlsVerify }] }));
  }
});

test("AC-TLS-3 preserved: untrusted TLS fails by default without global changes", async t => {
  const before = { fetch: globalThis.fetch, agent: https.globalAgent, env: process.env.NODE_TLS_REJECT_UNAUTHORIZED };
  const { baseUrl } = await fixture(t, (_, res) => send(res, listing(chat())));
  await assert.rejects(refresh(createLlamaSwapProvider(config({ baseUrl }))));
  assert.equal(globalThis.fetch, before.fetch);
  assert.equal(https.globalAgent, before.agent);
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, before.env);
});

test("AC-TLS-2 changed: discovery, incremental chat APIs and classifier share server TLS policy", { timeout: 10000 }, async t => {
  const before = { fetch: globalThis.fetch, agent: https.globalAgent, env: process.env.NODE_TLS_REJECT_UNAUTHORIZED };
  const requests = [];
  let release;
  const { baseUrl } = await fixture(t, async (req, res) => {
    requests.push({ path: req.url, key: req.headers.authorization, encoding: req.headers["accept-encoding"] });
    if (req.url === "/v1/models") return send(res, listing(chat(), decision()));
    if (req.url === "/upstream/judge/v1/models") return send(res, listing({ id: "judge" }));
    if (req.url === "/upstream/judge/v1/systemone") return send(res, { model: "judge", answers });
    if (req.url === "/v1/chat/completions") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.equal(JSON.parse(Buffer.concat(chunks).toString()).model, "chat");
      res.setHeader("content-type", "text/event-stream");
      const chunk = { id: "tls-chat", object: "chat.completion.chunk", created: 1, model: "chat",
        choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] };
      const ready = new Promise(resolve => { release = resolve; });
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      await ready;
      chunk.choices[0] = { index: 0, delta: {}, finish_reason: "stop" };
      res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      return;
    }
    res.statusCode = 404; res.end();
  });
  const p = createLlamaSwapProvider(config({ baseUrl, tlsVerify: false, apiKey: "synthetic-tls-key" }));
  await refresh(p);
  assert.equal(p.getAllModels().length, 2);
  const transcript = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
  for (const method of ["stream", "streamSimple"]) {
    let incremental = false;
    const stream = p[method](p.getModels()[0], transcript, { apiKey: "synthetic-tls-key", maxRetries: 0 });
    for await (const event of stream) {
      if (event.type === "text_delta") { incremental = true; release(); }
    }
    assert.equal(incremental, true);
    assert.equal((await stream.result()).stopReason, "stop");
  }
  const result = await p.classify(p.getAllModels()[1], context, { apiKey: "synthetic-tls-key" });
  assert.equal(result.stopReason, "stop");
  assert.equal(requests.length, 5);
  assert.ok(requests.every(r => r.key === "Bearer synthetic-tls-key" && r.encoding === "identity"));
  assert.equal(globalThis.fetch, before.fetch);
  assert.equal(https.globalAgent, before.agent);
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, before.env);
});

test("AC-TLS-2 changed: other origins remain verified and redirects never follow", async t => {
  let otherRequests = 0;
  const other = await fixture(t, (_, res) => { otherRequests++; send(res, listing(chat())); });
  const local = await fixture(t, (_, res) => { res.statusCode = 302; res.setHeader("location", other.baseUrl + "/v1/models"); res.end(); });
  const p = createLlamaSwapProvider(config({ baseUrl: local.baseUrl, tlsVerify: false }));
  await assert.rejects(refresh(p), /redirect/i);
  const model = { ...chat(), type: "chat", api: "openai-completions", provider: p.id, baseUrl: other.baseUrl + "/v1",
    input: ["text"], contextWindow: 32768, maxTokens: 4096, reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const stream = p.streamSimple(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { apiKey: "synthetic-key", maxRetries: 0 });
  assert.equal((await stream.result()).stopReason, "error");
  assert.equal(otherRequests, 0);
});

test("AC-TLS-2 changed: abort closes response and metadata bounds still apply", { timeout: 10000 }, async t => {
  let mode = "pending", requests = 0, closed;
  const connectionClosed = new Promise(resolve => { closed = resolve; });
  const { baseUrl } = await fixture(t, (_, res) => {
    requests++;
    if (mode === "pending") { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); res.on("close", closed); }
    else if (mode === "large") res.end(" ".repeat(2097153));
    else { res.setHeader("content-encoding", "gzip"); res.end("not-decoded"); }
  });
  const p = createLlamaSwapProvider(config({ baseUrl, tlsVerify: false, timeoutMs: 150 }));
  const aborted = new AbortController(); aborted.abort();
  await refresh(p, { signal: aborted.signal });
  assert.equal(requests, 0);
  await assert.rejects(refresh(p));
  await connectionClosed;
  mode = "large";
  await assert.rejects(refresh(p), /2 MiB/);
  mode = "encoded";
  await assert.rejects(refresh(p), /encoding/i);
  assert.equal(p.getAllModels().length, 0);
});

test("AC-TLS-2 changed: invalid final HTTP status rejects without an uncaught callback error", { timeout: 2000 }, async t => {
  let status = 600;
  const { baseUrl } = await fixture(t, (_, res) => { res.statusCode = status; res.end("synthetic body"); });
  const p = createLlamaSwapProvider(config({ baseUrl, tlsVerify: false }));
  await assert.rejects(refresh(p), /invalid HTTPS response/i);
  status = 500;
  await assert.rejects(refresh(p), /HTTP 500/);
  status = 204;
  await assert.rejects(refresh(p), /no body/);
});

test("AC-TLS-2 verification: abort during chat closes SSE on both entrypoints", { timeout: 10000 }, async t => {
  let closed;
  const { baseUrl } = await fixture(t, (req, res) => {
    if (req.url === "/v1/models") return send(res, listing(chat()));
    res.on("close", () => closed());
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"id":"x","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n');
  });
  const p = createLlamaSwapProvider(config({ baseUrl, tlsVerify: false }));
  await refresh(p);
  for (const method of ["stream", "streamSimple"]) {
    const connectionClosed = new Promise(resolve => { closed = resolve; });
    const controller = new AbortController();
    const stream = p[method](p.getModels()[0], { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      { apiKey: "synthetic-key", maxRetries: 0, signal: controller.signal });
    let received = false;
    for await (const event of stream) {
      if (event.type === "text_delta") { received = true; controller.abort(); }
    }
    assert.equal(received, true);
    assert.equal((await stream.result()).stopReason, "aborted");
    await connectionClosed;
  }
});

test("AC-TLS-2 changed: explicit caller transports retain ownership", async () => {
  const observed = [];
  const p = createLlamaSwapProvider(config({ tlsVerify: false }), async (url, init) => {
    observed.push(String(url)); return json(listing(chat()));
  });
  await refresh(p);
  const stream = p.streamSimple(p.getModels()[0], { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, {
    apiKey: "synthetic-key", fetch: async url => {
      observed.push(String(url));
      return new Response('data: {"id":"x","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    },
  });
  assert.equal((await stream.result()).stopReason, "stop");
  assert.deepEqual(observed, ["https://swap.invalid/prefix/v1/models", "https://swap.invalid/prefix/v1/chat/completions"]);
});
