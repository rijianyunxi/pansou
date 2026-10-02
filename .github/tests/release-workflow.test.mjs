import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const workflow = readFileSync(new URL("../workflows/release.yml", import.meta.url), "utf8");
// Execute the actual workflow block, not a second implementation of packaging.
function runBlock(name) {
  const start = workflow.indexOf("      - name: " + name + "\n");
  assert.ok(start >= 0, "missing workflow step: " + name);
  const step = workflow.slice(start);
  const block = step.indexOf("        run: |\n");
  assert.ok(block >= 0, "missing workflow run block: " + name);
  const run = step.slice(block + "        run: |\n".length);
  const lines = [];
  for (const line of run.split("\n")) {
    if (line && !line.startsWith("          ")) break;
    lines.push(line.slice(10));
  }
  assert.ok(lines.length > 0, "missing workflow run block: " + name);
  return lines.join("\n");
}
const packageScript = runBlock("Package");

function runBash(script, options = {}) {
  return spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", script], {
    encoding: "utf8", ...options,
  });
}

test("manual releases reject branches and non-v tags before building", () => {
  const script = runBlock("Validate release tag");
  for (const [type, name, expected] of [
    ["branch", "main", 1], ["branch", "v2.0.1", 1],
    ["tag", "test", 1], ["tag", "v2.0.1", 0],
  ]) {
    const result = runBash(script, { env: { ...process.env, GITHUB_REF_TYPE: type, GITHUB_REF_NAME: name } });
    assert.equal(result.status, expected, result.stderr + result.stdout);
  }
});

for (const [os, platform, fallback] of [
  ["ubuntu-latest", "linux-amd64", false],
  ["macos-latest", "macos-arm64", false],
  ["macos-latest", "macos-arm64", true],
]) {
  test(platform + " tar.gz is real gzip, contains defaults rather than private env, checksum fallback=" + fallback, () => {
    const fixture = mkdtempSync(join(tmpdir(), "pansou-release-test-"));
    try {
      const files = {
        "target/fixture-target/release/pansou-api": "fixture binary, not a compiled program",
        "frontend/dist/index.html": "<html>fixture</html>",
        ".env.example": "# Default configuration\nFIXTURE=default\n",
        ".env": "FIXTURE=PRIVATE_DO_NOT_PACKAGE\n",
        "README.md": "fixture README",
        "docker-compose.yml": "services: {}",
        "deploy/pansou.service": "fixture service",
        "docs/source-message-storage-cleanup.md": "fixture upgrade warning",
      };
      for (const [name, content] of Object.entries(files)) {
        const path = join(fixture, name);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, content);
      }
      const env = {
        ...process.env, GITHUB_REF_NAME: "v2.0.1",
        PACKAGE_OS: os, PACKAGE_TARGET: "fixture-target", PACKAGE_NAME: platform,
        GITHUB_ENV: join(fixture, "github-env"),
      };
      if (fallback) {
        const toolsDir = join(fixture, "tools");
        mkdirSync(toolsDir);
        // A private PATH without sha256sum tests the real shasum fallback.
        for (const name of ["bash", "mkdir", "cp", "tar", "gzip", "shasum"]) {
          const located = runBash("command -v " + name);
          assert.equal(located.status, 0, "missing test dependency: " + name);
          symlinkSync(located.stdout.trim(), join(toolsDir, name));
        }
        env.PATH = toolsDir;
      }
      const result = runBash(packageScript, { cwd: fixture, env });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const name = "pansou-v2.0.1-" + platform + ".tar.gz";
      const archive = join(fixture, name);
      const bytes = readFileSync(archive);
      assert.deepEqual([...bytes.subarray(0, 2)], [0x1f, 0x8b]);
      const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
      assert.equal(listing.status, 0, listing.stderr);
      const entries = listing.stdout.split("\n");
      for (const entry of [".env", "pansou-api", "frontend/dist/index.html"]) {
        assert.ok(entries.includes("./" + entry), "missing package entry: " + entry);
      }
      for (const entry of [".env.example", "README.md", "docker-compose.yml", "docs/source-message-storage-cleanup.md", "deploy/pansou.service"]) {
        assert.ok(!entries.includes("./" + entry), "unexpected package entry: " + entry);
      }
      const content = spawnSync("tar", ["-xzOf", archive, "./.env"], { encoding: "utf8" });
      assert.equal(content.status, 0, content.stderr);
      assert.equal(content.stdout, files[".env.example"]);
      const checksum = createHash("sha256").update(bytes).digest("hex");
      assert.ok(readFileSync(archive + ".sha256", "utf8").startsWith(checksum + "  " + name));
      assert.equal(readFileSync(env.GITHUB_ENV, "utf8").trim(), "OUT=" + name);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}

test("Windows ZIP includes dotfiles and validates the archive before upload", () => {
  assert.match(packageScript, /cd pkg && 7z a -tzip "\.\.\/\$OUT" \./);
  assert.match(packageScript, /7z t "\$OUT"/);
  assert.ok(!packageScript.includes('pkg/*'));
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /fail_on_unmatched_files: true/);
});
