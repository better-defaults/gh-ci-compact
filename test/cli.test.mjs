// /test/cli.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse, parseAllDocuments, stringify } from "yaml";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const compatiblePath = join(fixtures, "compatible.yml");
const source = readFileSync(compatiblePath, "utf8");

function run(args, cwd) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd });
  assert.ifError(result.error);
  return result;
}
function report(path) {
  const result = run(["analyze", path, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}
function documents(result) {
  assert.equal(result.status, 0, result.stderr);
  return parseAllDocuments(result.stdout).map((document) => {
    assert.deepEqual(document.errors, []);
    return document.toJS();
  });
}
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), "gh-ci-compact-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fixture(t, change) {
  const definition = parse(source);
  delete definition.jobs.format;
  change(definition);
  const path = join(temporary(t), "checks.yml");
  writeFileSync(path, stringify(definition));
  return path;
}
function codes(analysis, job) {
  return analysis.rejected.find((item) => item.job === job).reasons.map((reason) => reason.code);
}

test("help and existing version command", () => {
  assert.equal(run(["--version"]).stdout.trim(), "0.0.1");
  for (const args of [[], ["--help"], ["-h"]]) {
    const result = run(args);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /analyze \[path\] \[--json\]/);
    assert.match(result.stdout, /compile \[path\]/);
  }
});

test("analyze inventories the three compatible jobs as strict JSON", () => {
  const analysis = report(compatiblePath);
  assert.equal(analysis.schema, "gh-ci-compact/analyze/v1");
  assert.equal(analysis.path, compatiblePath);
  assert.deepEqual(analysis.errors, []);
  assert.deepEqual(analysis.rejected, []);
  assert.equal(analysis.workflows[0].name, "Checks");
  assert.deepEqual(analysis.workflows[0].on, parse(source).on);
  assert.deepEqual(analysis.workflows[0].jobs.map(({ id, status }) => [id, status]), [
    ["lint", "compatible"], ["typecheck", "compatible"], ["format", "compatible"],
  ]);
  assert.deepEqual(analysis.groups[0].jobs, ["lint", "typecheck", "format"]);
  assert.equal(analysis.groups[0].prefixLength, 3);
  assert.equal(report(compatiblePath).groups[0].id, analysis.groups[0].id);
  const text = run(["analyze", compatiblePath]);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /Compatible: .*\[lint, typecheck, format\]/);
});

test("compile emits setup once and three native branches, preserving source and metadata", () => {
  const result = run(["compile", compatiblePath]);
  assert.equal(result.stderr, "");
  const [output] = documents(result);
  const original = parse(source);
  const { jobs, ...metadata } = output;
  const { jobs: originalJobs, ...originalMetadata } = original;
  assert.deepEqual(metadata, originalMetadata);
  assert.equal(Object.keys(jobs).length, 1);
  const [[id, job]] = Object.entries(jobs);
  assert.match(id, /^compact_compatible_yml_lint_typecheck_format$/);
  assert.match(job.name, /compatible.yml: lint \+ typecheck \+ format/);
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.deepEqual(job.steps.slice(0, 3), originalJobs.lint.steps.slice(0, 3));
  assert.equal(job.steps.length, 4);
  assert.deepEqual(Object.keys(job.steps[3]), ["parallel"]);
  assert.equal(job.steps[3].parallel.length, 3);
  assert.deepEqual(job.steps[3].parallel.map((branch) => branch.run), ["npm run lint", "npm run typecheck", "npm run format:check"]);
  for (const [index, id] of ["lint", "typecheck", "format"].entries()) {
    assert.match(job.steps[3].parallel[index].name, new RegExp(`compatible.yml:${id}`));
    assert.equal(job.steps[3].parallel[index].steps, undefined);
  }
  assert.match(job.steps[3].parallel[0].name, /\(Lint\) \/ Check lint$/);
  assert.equal((result.stdout.match(/run: npm ci/g) ?? []).length, 1);
  assert.equal(readFileSync(compatiblePath, "utf8"), source);
  assert.equal(run(["compile", compatiblePath]).stdout, result.stdout);
});

test("unsupported constructs have stable codes and retained definitions", () => {
  const path = join(fixtures, "rejected.yaml");
  const analysis = report(path);
  const expected = {
    matrix: "UNSUPPORTED_STRATEGY", dependent: "UNSUPPORTED_NEEDS", upstream: "DEPENDENCY_TARGET",
    services: "UNSUPPORTED_SERVICES", container: "UNSUPPORTED_CONTAINER", deployment: "UNSUPPORTED_ENVIRONMENT",
    output: "UNSUPPORTED_OUTPUTS", late_action: "NON_PREFIX_USES",
  };
  assert.equal(analysis.groups.length, 0);
  for (const [job, code] of Object.entries(expected)) assert.ok(codes(analysis, job).includes(code), job);
  for (const rejection of analysis.rejected) for (const reason of rejection.reasons) assert.ok(reason.message.length > 0);
  const result = run(["compile", path]);
  const [output] = documents(result);
  assert.deepEqual(output, parse(readFileSync(path, "utf8")));
  for (const [job, code] of Object.entries(expected)) assert.ok(result.stderr.includes(`${job} [${code}]`));
});

test("different complete triggers never combine; both YAML extensions are inventoried", () => {
  const path = join(fixtures, "triggers");
  const analysis = report(path);
  assert.deepEqual(analysis.workflows.map(({ path }) => path.split("/").at(-1)), ["pull-request.yaml", "push.yml"]);
  assert.equal(analysis.groups.length, 0);
  assert.ok(codes(analysis, "lint").includes("TRIGGER_MISMATCH"));
  assert.ok(codes(analysis, "typecheck").includes("WORKFLOW_BOUNDARY"));
  const output = documents(run(["compile", path]));
  assert.equal(output.length, 2);
  assert.deepEqual(output.map(({ on }) => on), analysis.workflows.map(({ on }) => on));
});

const rejections = [
  ["different runners", "RUNNER_MISMATCH", (w) => { w.jobs.typecheck["runs-on"] = "macos-latest"; }],
  ["differing setup action inputs", "SETUP_PREFIX_MISMATCH", (w) => { w.jobs.typecheck.steps[1].with["node-version"] = 20; }],
  ["differing setup run commands", "MULTI_STEP_BRANCH", (w) => { w.jobs.typecheck.steps[2].run = "npm install"; }],
  ["multiple run steps after setup", "MULTI_STEP_BRANCH", (w) => { w.jobs.lint.steps.push({ run: "npm test" }); }],
  ["non-prefix action before final run", "NON_PREFIX_USES", (w) => { w.jobs.lint.steps.splice(4, 0, { uses: "actions/upload-artifact@v6" }); w.jobs.lint.steps.push({ run: "npm test" }); }],
  ["no common setup", "SETUP_PREFIX_MISMATCH", (w) => { for (const job of Object.values(w.jobs)) job.steps = job.steps.slice(-1); }],
  ["step IDs", "UNSUPPORTED_STEP_KEY", (w) => { w.jobs.lint.steps[3].id = "lint"; }],
  ["step conditions", "UNSUPPORTED_STEP_KEY", (w) => { w.jobs.lint.steps[3].if = "always()"; }],
  ["existing background steps", "UNSUPPORTED_STEP_KEY", (w) => { w.jobs.lint.steps[3].background = true; }],
  ["runner expressions", "UNSUPPORTED_EXPRESSION", (w) => { w.jobs.lint["runs-on"] = "${{ vars.RUNNER }}"; }],
  ["implicit job conditions", "UNSUPPORTED_CONDITION", (w) => { w.jobs.lint.if = "success()"; }],
  ["job identity", "SHARED_JOB_STATE", (w) => { w.jobs.lint.steps[3].run = "echo $GITHUB_JOB"; }],
  ["environment file writes", "SHARED_JOB_STATE", (w) => { w.jobs.lint.steps[3].run = "echo X=1 >> $GITHUB_ENV"; }],
  ["legacy runner state commands", "SHARED_JOB_STATE", (w) => { w.jobs.lint.steps[3].run = "echo ::set-output name=x::value"; }],
  ["workflow concurrency", "UNSUPPORTED_WORKFLOW_KEY", (w) => { w.concurrency = "checks"; }],
  ["workflow expressions", "UNSUPPORTED_EXPRESSION", (w) => { w.env.X = "${{ github.job }}"; }],
  ["reusable jobs", "UNSUPPORTED_JOB_KEY", (w) => { w.jobs.lint.uses = "owner/repo/.github/workflows/check.yml@main"; delete w.jobs.lint.steps; }],
  ["unknown runner mappings", "INVALID_RUNNER", (w) => { w.jobs.lint["runs-on"] = { unsupported: "ubuntu-latest" }; }],
  ["invalid literal job settings", "INVALID_JOB_SETTINGS", (w) => { w.jobs.lint.env = { X: { nested: "value" } }; }],
  ["invalid workflow settings", "INVALID_WORKFLOW_SETTINGS", (w) => { w.defaults.run.shell = 42; }],
  ["empty run scripts", "INVALID_STEP", (w) => { w.jobs.lint.steps[3].run = ""; }],
  ["invalid step timeout", "INVALID_STEP", (w) => { w.jobs.lint.steps[3]["timeout-minutes"] = 361; }],
  ["run action inputs", "INVALID_STEP", (w) => { w.jobs.lint.steps[3].with = { input: "value" }; }],
];
for (const [name, code, change] of rejections) {
  test(`rejects ${name}`, (t) => {
    const path = fixture(t, change);
    const analysis = report(path);
    assert.equal(analysis.groups.length, 0);
    assert.ok(analysis.rejected.some(({ reasons }) => reasons.some((reason) => reason.code === code)), JSON.stringify(analysis));
    const [output] = documents(run(["compile", path]));
    assert.deepEqual(output, parse(readFileSync(path, "utf8")));
  });
}

const settings = {
  permissions: { contents: "read" }, env: { CI: "true" }, defaults: { run: { shell: "bash" } },
  if: true, "timeout-minutes": 10, "continue-on-error": false,
};
for (const [key, value] of Object.entries(settings)) {
  test(`equivalent ${key} is preserved; absent versus explicit differs`, (t) => {
    const accepted = fixture(t, (w) => { for (const job of Object.values(w.jobs)) job[key] = structuredClone(value); });
    assert.equal(report(accepted).groups.length, 1);
    const [output] = documents(run(["compile", accepted]));
    assert.deepEqual(Object.values(output.jobs)[0][key], value);
    const rejected = fixture(t, (w) => { w.jobs.lint[key] = value; });
    assert.ok(codes(report(rejected), "lint").includes("JOB_SETTINGS_MISMATCH"));
  });
}

test("equivalent job concurrency is still rejected because scheduling changes", (t) => {
  const path = fixture(t, (w) => { for (const job of Object.values(w.jobs)) job.concurrency = "checks"; });
  const analysis = report(path);
  assert.equal(analysis.groups.length, 0);
  assert.ok(codes(analysis, "lint").includes("UNSUPPORTED_CONCURRENCY"));
});

test("native branch preserves multiline command, shell, env, directory and timeout", (t) => {
  const branch = { name: "Lint", run: "npm run lint\nnpm run lint:extra\n", shell: "bash", env: { MODE: "strict" }, "working-directory": "src", "timeout-minutes": 5 };
  const path = fixture(t, (w) => { w.jobs.lint.steps[3] = branch; });
  const [output] = documents(run(["compile", path]));
  const generated = Object.values(output.jobs)[0].steps[3].parallel[0];
  const { name, ...rest } = generated;
  const { name: originalName, ...expected } = branch;
  assert.deepEqual(rest, expected);
  assert.match(name, /lint.*Lint/);
});

test("literal runner strings, arrays and group mappings preserve their declarations", (t) => {
  for (const runner of ["ubuntu-latest", ["self-hosted", "linux"], { group: "checks", labels: ["linux", "x64"] }, { labels: "ubuntu-latest" }]) {
    const path = fixture(t, (w) => { for (const job of Object.values(w.jobs)) job["runs-on"] = structuredClone(runner); });
    assert.equal(report(path).groups.length, 1);
    const [output] = documents(run(["compile", path]));
    assert.deepEqual(Object.values(output.jobs)[0]["runs-on"], runner);
  }
});

test("literal false condition, read-all permissions and scalar env values are preserved", (t) => {
  const path = fixture(t, (w) => {
    w["run-name"] = "Static checks";
    for (const job of Object.values(w.jobs)) {
      job.if = "false";
      job.permissions = "read-all";
      job.env = { STRING: "value", NUMBER: 22, BOOL: true };
      job.defaults = { run: { shell: "bash", "working-directory": "src" } };
      job["continue-on-error"] = true;
    }
  });
  const [output] = documents(run(["compile", path]));
  const job = Object.values(output.jobs)[0];
  assert.equal(output["run-name"], "Static checks");
  assert.equal(job.if, "false");
  assert.equal(job.permissions, "read-all");
  assert.deepEqual(job.env, { STRING: "value", NUMBER: 22, BOOL: true });
  assert.deepEqual(job.defaults, { run: { shell: "bash", "working-directory": "src" } });
  assert.equal(job["continue-on-error"], true);
});

test("array needs protects upstream IDs while the remaining pair compiles", (t) => {
  const path = fixture(t, (w) => {
    w.jobs.format = structuredClone(w.jobs.typecheck);
    w.jobs.dependent = { "runs-on": "ubuntu-latest", needs: ["lint"], steps: [{ run: "echo deploy" }] };
  });
  const analysis = report(path);
  assert.deepEqual(analysis.groups[0].jobs, ["typecheck", "format"]);
  assert.ok(codes(analysis, "lint").includes("DEPENDENCY_TARGET"));
  const [output] = documents(run(["compile", path]));
  assert.ok(output.jobs.lint);
  assert.deepEqual(output.jobs.dependent.needs, ["lint"]);
});

test("mapping key order is immaterial, identical final tasks retain two branches", (t) => {
  const path = fixture(t, (w) => {
    w.jobs.typecheck = structuredClone(w.jobs.lint);
    w.jobs.typecheck.steps[1] = { with: { "node-version": 22 }, uses: "actions/setup-node@v7" };
  });
  const [output] = documents(run(["compile", path]));
  assert.equal(Object.values(output.jobs)[0].steps[3].parallel.length, 2);
});

test("retained unsupported jobs keep their IDs and definitions beside compiled groups", (t) => {
  const path = fixture(t, (w) => { w.jobs.deploy = { "runs-on": "ubuntu-latest", environment: "production", steps: [{ run: "echo deploy" }] }; });
  const original = parse(readFileSync(path, "utf8"));
  const result = run(["compile", path]);
  const [output] = documents(result);
  assert.equal(Object.keys(output.jobs).length, 2);
  assert.deepEqual(output.jobs.deploy, original.jobs.deploy);
  assert.match(result.stderr, /deploy \[UNSUPPORTED_ENVIRONMENT\]/);
});

test("groups stay within ten branches and generated IDs avoid retained IDs", (t) => {
  const path = fixture(t, (w) => {
    const lint = w.jobs.lint;
    w.jobs = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`task${i}`, structuredClone(lint)]));
  });
  const analysis = report(path);
  assert.deepEqual(analysis.groups.map(({ jobs }) => jobs.length), [9, 2]);
  assert.deepEqual(analysis.rejected, []);
  const [output] = documents(run(["compile", path]));
  assert.deepEqual(Object.values(output.jobs).map(({ steps }) => steps[3].parallel.length), [9, 2]);
  const collision = fixture(t, (w) => { w.jobs.compact_checks_yml_lint_typecheck = { "runs-on": "ubuntu-latest", environment: "production", steps: [{ run: "echo deploy" }] }; });
  assert.equal(report(collision).groups[0].id, "compact_checks_yml_lint_typecheck_2");
  const [collisionOutput] = documents(run(["compile", collision]));
  assert.ok(collisionOutput.jobs.compact_checks_yml_lint_typecheck);
  assert.ok(collisionOutput.jobs.compact_checks_yml_lint_typecheck_2);
});

test("default directory discovery sorts direct YAML files and ignores other entries", (t) => {
  const dir = temporary(t);
  const workflows = join(dir, ".github/workflows");
  mkdirSync(join(workflows, "nested"), { recursive: true });
  writeFileSync(join(workflows, "b.yaml"), source);
  writeFileSync(join(workflows, "a.yml"), source);
  writeFileSync(join(workflows, "ignored.txt"), "invalid yaml");
  writeFileSync(join(workflows, "nested/ignored.yml"), source);
  symlinkSync(compatiblePath, join(workflows, "ignored-link.yml"));
  const result = run(["analyze", "--json"], dir);
  assert.equal(result.status, 0, result.stderr);
  const analysis = JSON.parse(result.stdout);
  assert.equal(analysis.path, ".github/workflows");
  assert.deepEqual(analysis.workflows.map(({ path }) => path), [".github/workflows/a.yml", ".github/workflows/b.yaml"]);
  const output = documents(run(["compile"], dir));
  assert.equal(output.length, 2);
  assert.equal(run(["compile"], dir).stdout.includes("ignored"), false);
});

test("equivalent triggers across separate files retain workflow boundaries", (t) => {
  const dir = temporary(t);
  const w = parse(source);
  w.jobs = { lint: w.jobs.lint };
  writeFileSync(join(dir, "a.yml"), stringify(w));
  writeFileSync(join(dir, "b.yaml"), stringify(w));
  const analysis = report(dir);
  assert.equal(analysis.groups.length, 0);
  assert.deepEqual(codes(analysis, "lint"), ["WORKFLOW_BOUNDARY"]);
});

test("array event triggers and a lone supported job are retained and reported", (t) => {
  const path = fixture(t, (w) => {
    w.on = ["push", "pull_request"];
    delete w.jobs.typecheck;
  });
  const analysis = report(path);
  assert.deepEqual(analysis.workflows[0].on, ["push", "pull_request"]);
  assert.deepEqual(analysis.groups, []);
  assert.deepEqual(codes(analysis, "lint"), ["NO_COMPATIBLE_PEER"]);
  const result = run(["compile", path]);
  const [output] = documents(result);
  assert.deepEqual(output, parse(readFileSync(path, "utf8")));
  assert.match(result.stderr, /lint \[NO_COMPATIBLE_PEER\]/);
});

test("event filters are part of the complete trigger comparison", (t) => {
  const dir = temporary(t);
  const w = parse(source);
  w.jobs = { lint: w.jobs.lint };
  writeFileSync(join(dir, "a.yml"), stringify(w));
  w.on.push.branches = ["release"];
  writeFileSync(join(dir, "b.yml"), stringify(w));
  assert.ok(codes(report(dir), "lint").includes("TRIGGER_MISMATCH"));
});

test("input path cannot introduce expressions into generated names", (t) => {
  const path = join(temporary(t), "${{ github.job }}.yml");
  writeFileSync(path, source);
  const result = run(["analyze", path, "--json"]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).errors[0].code, "INVALID_WORKFLOW");
  assert.equal(run(["compile", path]).stdout, "");
});

for (const invalid of [
  "on: [push\njobs: {}", "on: push\non: pull_request\njobs: {}", "jobs: {}", "on: false\njobs: {}",
  "on: push\njobs: {a: &job {runs-on: ubuntu-latest, steps: [{run: echo ok}]}, b: *job}",
  "on: push\njobs: {}\n---\non: push\njobs: {}", "on: push\njobs: {a: 42}",
  "on: !!str push\njobs: {a: {runs-on: ubuntu-latest, steps: [{run: echo ok}]}}",
]) {
  test(`invalid YAML/workflow produces JSON error and no partial compilation: ${invalid.slice(0, 30)}`, (t) => {
    const dir = temporary(t);
    writeFileSync(join(dir, "a.yml"), source);
    writeFileSync(join(dir, "z.yaml"), invalid);
    const result = run(["analyze", dir, "--json"]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const analysis = JSON.parse(result.stdout);
    assert.equal(analysis.errors[0].code, "INVALID_WORKFLOW");
    assert.equal(analysis.workflows.length, 1);
    const compiled = run(["compile", dir]);
    assert.equal(compiled.status, 1);
    assert.equal(compiled.stdout, "");
    assert.match(compiled.stderr, /INVALID_WORKFLOW/);
  });
}

test("I/O and empty-input errors keep analyze JSON parseable", (t) => {
  const empty = temporary(t);
  for (const path of [empty, join(empty, "missing"), join(empty, "wrong.txt")]) {
    const result = run(["analyze", path, "--json"]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).errors[0].code, "INPUT_ERROR");
    assert.equal(result.stderr, "");
    const compiled = run(["compile", path]);
    assert.equal(compiled.status, 1);
    assert.equal(compiled.stdout, "");
  }
});

test("invalid arguments exit 2 without contaminating stdout", () => {
  for (const args of [["wat"], ["compile", "--json"], ["analyze", "--wat"], ["analyze", "a", "b"], ["analyze", "--json", "--json"]]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Invalid arguments/);
  }
});

test("generated entry point and launcher retain executable permissions and shebangs", () => {
  assert.ok(statSync(cli).mode & 0o111);
  assert.ok(statSync(new URL("../gh-ci-compact", import.meta.url)).mode & 0o111);
  assert.ok(readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node\n"));
  assert.ok(readFileSync(new URL("../gh-ci-compact", import.meta.url), "utf8").startsWith("#!/usr/bin/env bash\n"));
});

test("CI invokes npm ci and the repository check gate", () => {
  const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  assert.deepEqual(workflow.jobs.check.steps.filter((step) => step.run).map((step) => step.run), ["npm ci", "npm run check"]);
  assert.equal(workflow.jobs.check.steps[1].with["node-version"], 22);
});
