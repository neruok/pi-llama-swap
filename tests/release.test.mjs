import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("AC-RELEASE preserved: archive gate writes an artifact under inherited publish dry-run", () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/check-package.mjs", import.meta.url))], {
    encoding: "utf8", env: { ...process.env, npm_config_dry_run: "true" },
  });
  assert.match(output, /AC-RELEASE PASS:/u);
});

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));

test("AC-RELEASE changed: public metadata includes the approved MIT license", async () => {
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.name, "@neruok/pi-llama-swap");
  assert.equal(manifest.publishConfig.access, "public");
  const license = await readFile(new URL("LICENSE", root), "utf8");
  assert.match(license, /^MIT License\n/u);
  assert.match(license, /Copyright \(c\) 2026 Cody Wentz/u);
  assert.match(license, /Permission is hereby granted, free of charge/u);
});

test("AC-RELEASE changed: pinned development tools are separate from host-only runtime peers", () => {
  assert.equal(manifest.dependencies, undefined);
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@types/node", "typescript"]) {
    assert.match(manifest.devDependencies?.[name] ?? "", /^\d+\.\d+\.\d+$/u, name);
  }
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]) {
    assert.equal(manifest.peerDependencies[name], "^1.2.0");
    assert.equal(manifest.peerDependenciesMeta[name].optional, true);
  }
});

test("AC-RELEASE changed: lockfile and CI use the package's complete verification gate", async () => {
  assert.equal(manifest.scripts.prepublishOnly, "npm run verify");
  assert.equal(manifest.scripts.verify, "npm run typecheck && npm test && npm run check:package");
  assert.equal(manifest.scripts["check:package"], "node scripts/check-package.mjs");
  const lock = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
  assert.equal(lock.name, manifest.name); assert.equal(lock.version, manifest.version);
  assert.deepEqual(lock.packages[""].devDependencies, manifest.devDependencies);
  const workflow = await readFile(new URL(".github/workflows/verify.yml", root), "utf8");
  assert.match(workflow, /npm ci --ignore-scripts/u);
  assert.match(workflow, /npm run verify/u);
  assert.match(workflow, /npm publish --dry-run/u);
});
