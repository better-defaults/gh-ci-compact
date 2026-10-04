import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

const cli = new URL("../dist/cli.js", import.meta.url);

function run(...args) {
  return execFileSync(
    process.execPath,
    [cli.pathname, ...args],
    {
      encoding: "utf8",
    },
  );
}

test("--version", () => {
  assert.equal(run("--version").trim(), "0.0.1");
});

test("analyze --json", () => {
  const result = JSON.parse(run("analyze", "--json"));

  assert.deepEqual(result, {
    schema: "gh-ci-compact/analyze/v1",
    path: ".github/workflows",
    jobs: [],
  });
});

test("analyze accepts workflow path", () => {
  const result = JSON.parse(
    run(
      "analyze",
      ".github/custom-workflows",
      "--json",
    ),
  );

  assert.equal(
    result.path,
    ".github/custom-workflows",
  );
});

test("unknown command exits with code 2", () => {
  const result = spawnSync(
    process.execPath,
    [cli.pathname, "wat"],
    {
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 2);
});
