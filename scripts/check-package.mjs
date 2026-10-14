import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

// AC-RELEASE: load the actual npm artifact without checkout dependencies or inference.
const root = resolve(import.meta.dirname, "..");
const dir = await mkdtemp(join(tmpdir(), "pi-llama-swap-package-"));
let runtime;
try {
  // npm publish --dry-run propagates its environment into prepublishOnly.
  // The nested pack must still write an archive, without recursively running hooks.
  const packOutput = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--dry-run=false", "--json", "--pack-destination", dir], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  }));
  // npm 10/11 return an array; npm 12 returns a map keyed by package name.
  const packs = Array.isArray(packOutput) ? packOutput : Object.values(packOutput);
  assert.equal(packs.length, 1);
  const [packed] = packs;
  const expected = ["README.md", "docs/pi-llama-swap.md", "llama-swap.example.json", "llama-swap.ts", "package.json"];
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (manifest.license) expected.push("LICENSE");
  assert.deepEqual(packed.files.map(file => file.path).sort(), expected.sort());
  assert.equal(packed.bundled.length, 0);
  const archive = join(dir, packed.filename);
  const members = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(members, expected.map(path => `package/${path}`).sort());
  execFileSync("tar", ["-xzf", archive, "-C", dir]);
  for (const path of expected) {
    assert.deepEqual(await readFile(join(dir, "package", path)), await readFile(join(root, path)), path);
  }
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  delete process.env.LLAMA_SWAP_CONFIG;
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir, settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [join(dir, "package")], noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  runtime = loaded.runtime;
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.equal(runtime.pendingNativeProviderRegistrations.length, 0, "missing default config leaves the extension inactive");
  runtime.invalidate();
  runtime = undefined;
  // Use the actual package with a synthetic isolated config, never the user's config.
  process.env.LLAMA_SWAP_CONFIG = join(dir, "config.json");
  await writeFile(process.env.LLAMA_SWAP_CONFIG, JSON.stringify({ servers: [{ id: "llama-swap-package", baseUrl: "https://package.invalid" }] }));
  await loader.reload();
  const configured = loader.getExtensions();
  runtime = configured.runtime;
  assert.deepEqual(configured.errors, []);
  assert.equal(configured.extensions.length, 1);
  assert.ok(configured.extensions[0].commands.has("llama-swap"));
  assert.deepEqual(runtime.pendingNativeProviderRegistrations.map(entry => entry.provider.id), ["llama-swap-package"]);
  console.log(`AC-RELEASE PASS: ${packed.name}@${packed.version} archive bytes, host-only loading and isolated configuration`);
} finally {
  runtime?.invalidate();
  await rm(dir, { recursive: true, force: true });
}
