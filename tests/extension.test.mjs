import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, { registerLlamaSwapServers } from "../llama-swap.ts";
import { config, listing, chat, json, fakePi } from "./helpers.mjs";
test("AC-ENTRY preserved: validates all servers before side effects", async () => {
  const pi = fakePi(); let requests = 0;
  await assert.rejects(registerLlamaSwapServers(pi.api, { servers: [config(), { ...config(), id: "INVALID" }] }, async () => { requests++; }));
  assert.equal(requests, 0); assert.equal(pi.providers.length, 0);
});
test("AC-ENTRY preserved: startup failure isolation and targeted refresh reporting", async () => {
  const pi = fakePi(); const cfg = { servers: [config(), config({ id: "llama-swap-other", baseUrl: "https://other.invalid" })] };
  await registerLlamaSwapServers(pi.api, cfg, async url => { if (url.includes("other")) throw Error("private"); return json(listing(chat())); });
  assert.equal(pi.providers.length, 2);
  assert.equal(pi.providers[0].getModels().length, 1);
  let text = "", targets, waited = false;
  const ctx = { hasUI: true, signal: new AbortController().signal,
    ui: { notify: value => { text = value; } },
    waitForIdle: async () => { waited = true; },
    modelRegistry: { refresh: async options => { targets = options.providers; return { errors: new Map([["llama-swap-other", Error("private")]]), aborted: false }; } },
  };
  await pi.events.get("session_start")({}, ctx);
  assert.equal(text.includes("llama-swap-other"), true); assert.equal(text.includes("private"), false);
  await pi.commands.get("llama-swap").handler("refresh llama-swap-other", ctx);
  assert.equal(waited, true); assert.deepEqual(targets, ["llama-swap-other"]);
  assert.equal(text.includes("last good catalogs"), true);
});
test("AC-ENTRY changed: non-UI status uses a message, not terminal UI", async () => {
  const pi = fakePi();
  await registerLlamaSwapServers(pi.api, { servers: [config()] }, async () => json(listing(chat())));
  await pi.commands.get("llama-swap").handler("status", { hasUI: false, ui: { notify: () => assert.fail("terminal UI used") } });
  assert.equal(pi.messages.length, 1);
  assert.equal(pi.messages[0].options.triggerTurn, false);
});
test("AC-ENTRY changed: explicit config path and safe missing-file errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-llama-swap-test-"));
  const old = process.env.LLAMA_SWAP_CONFIG, offline = process.env.PI_OFFLINE;
  try {
    process.env.PI_OFFLINE = "1";
    process.env.LLAMA_SWAP_CONFIG = join(dir, "config.json");
    await writeFile(process.env.LLAMA_SWAP_CONFIG, JSON.stringify({ servers: [config()] }));
    const pi = fakePi(); await extension(pi.api);
    assert.equal(pi.providers.length, 1);
    process.env.LLAMA_SWAP_CONFIG = join(dir, "missing.json");
    await assert.rejects(extension(fakePi().api), error => error.message === "Cannot read llama-swap configuration");
  } finally {
    if (old === undefined) delete process.env.LLAMA_SWAP_CONFIG; else process.env.LLAMA_SWAP_CONFIG = old;
    if (offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = offline;
    await rm(dir, { recursive: true, force: true });
  }
});
