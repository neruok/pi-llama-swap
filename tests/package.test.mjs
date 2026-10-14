import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { config } from "./helpers.mjs";

test("AC-ENTRY package verification: Pi loads the manifest without settings changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-llama-swap-loader-"));
  const previous = Object.fromEntries(["LLAMA_SWAP_CONFIG", "PI_OFFLINE", "PI_CODING_AGENT_DIR"].map(key => [key, process.env[key]]));
  try {
    const agentDir = join(dir, "agent");
    await mkdir(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_OFFLINE = "1";
    process.env.LLAMA_SWAP_CONFIG = join(dir, "config.json");
    await writeFile(process.env.LLAMA_SWAP_CONFIG, JSON.stringify({ servers: [config()] }));
    const packageRoot = resolve(import.meta.dirname, "..");
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    assert.deepEqual(manifest.pi.extensions, ["./llama-swap.ts"]);
    assert.equal(manifest.dependencies, undefined);
    assert.equal(manifest.peerDependencies["@earendil-works/pi-ai"], "^1.2.0");
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir, settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [packageRoot],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    assert.equal(loaded.extensions[0].commands.has("llama-swap"), true);
    assert.deepEqual(loaded.runtime.pendingNativeProviderRegistrations.map(x => x.provider.id), ["llama-swap-test"]);
    await assert.rejects(readFile(join(agentDir, "settings.json")), { code: "ENOENT" });
    loaded.runtime.invalidate();

    delete process.env.LLAMA_SWAP_CONFIG;
    const inactive = new DefaultResourceLoader({
      cwd: dir, agentDir, settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [packageRoot],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await inactive.reload();
    const empty = inactive.getExtensions();
    assert.deepEqual(empty.errors, []);
    assert.equal(empty.runtime.pendingNativeProviderRegistrations.length, 0);
    empty.runtime.invalidate();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
