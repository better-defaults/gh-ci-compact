// /src/compiler.ts
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isAlias, parseDocument, stringify, visit } from "yaml";

type Mapping = Record<string, unknown>;
interface Reason { code: string; message: string }
interface Workflow { path: string; definition: Mapping; jobs: Job[] }
interface Job { id: string; definition: Mapping; steps: Mapping[]; reasons: Reason[] }
type ParsedWorkflow = { workflow: Workflow } | { error: Reason & { workflow: string } };
interface Group { workflow: Workflow; jobs: Job[]; prefixLength: number; id: string; name: string }
interface Report {
  workflows: { path: string; name: unknown; on: unknown; jobs: { id: string; name: unknown; status: "compatible" | "rejected" }[] }[];
  groups: { workflow: string; jobs: string[]; prefixLength: number; id: string; name: string }[];
  rejected: { workflow: string; job: string; reasons: Reason[] }[];
  errors: (Reason & { workflow: string })[];
}
interface Analysis { workflows: Workflow[]; groups: Group[]; report: Report }

const SETTINGS = ["permissions", "env", "defaults", "if", "timeout-minutes", "continue-on-error", "concurrency"];
const FORBIDDEN = ["needs", "strategy", "services", "container", "environment", "outputs"];
const WORKFLOW_KEYS = ["name", "run-name", "on", "permissions", "env", "defaults", "jobs"];
const JOB_KEYS = ["name", "runs-on", "steps", ...SETTINGS, ...FORBIDDEN];
const STEP_KEYS = ["name", "run", "uses", "with", "env", "shell", "working-directory", "timeout-minutes"];
const STATE_CHANNELS = /\bGITHUB_(?:JOB|WORKFLOW|ENV|OUTPUT|PATH|STATE|STEP_SUMMARY)\b|::(?:set-env|set-output|add-path|save-state)\b/;

function mapping(value: unknown): value is Mapping {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function has(value: Mapping, key: string): boolean { return Object.hasOwn(value, key); }
function reason(code: string, message: string): Reason { return { code, message }; }
function contains(value: unknown, pattern: RegExp): boolean {
  if (typeof value === "string") return pattern.test(value);
  if (Array.isArray(value)) return value.some((item) => contains(item, pattern));
  return mapping(value) && Object.entries(value).some(([key, item]) => pattern.test(key) || contains(item, pattern));
}
function unknownKeys(value: Mapping, keys: string[]): string[] {
  return Object.keys(value).filter((key) => !keys.includes(key));
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function labels(value: unknown): boolean {
  return text(value) || Array.isArray(value) && value.length > 0 && value.every(text);
}
function runner(value: unknown): boolean {
  return labels(value) || mapping(value) && Object.keys(value).length > 0 &&
    unknownKeys(value, ["group", "labels"]).length === 0 &&
    (!has(value, "group") || text(value.group)) && (!has(value, "labels") || labels(value.labels));
}
function literalMap(value: unknown): boolean {
  return mapping(value) && Object.values(value).every((item) =>
    typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item));
}
function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function invalidSettings(value: Mapping): string[] {
  const invalid: string[] = [];
  if (has(value, "name") && typeof value.name !== "string") invalid.push("name");
  if (has(value, "env") && !literalMap(value.env)) invalid.push("env");
  if (has(value, "permissions") && !(value.permissions === "read-all" || value.permissions === "write-all" ||
    mapping(value.permissions) && Object.values(value.permissions).every((mode) => typeof mode === "string" && ["read", "write", "none"].includes(mode)))) invalid.push("permissions");
  if (has(value, "defaults")) {
    const defaults = value.defaults;
    if (!mapping(defaults) || unknownKeys(defaults, ["run"]).length || has(defaults, "run") &&
      (!mapping(defaults.run) || unknownKeys(defaults.run, ["shell", "working-directory"]).length || !Object.values(defaults.run).every(text))) invalid.push("defaults");
  }
  if (has(value, "timeout-minutes") && !positiveInteger(value["timeout-minutes"])) invalid.push("timeout-minutes");
  if (has(value, "continue-on-error") && typeof value["continue-on-error"] !== "boolean") invalid.push("continue-on-error");
  return invalid;
}

export function parseWorkflow(path: string, source: string): ParsedWorkflow {
  try {
    if (path.includes("${{")) throw new Error("Workflow paths containing expression delimiters cannot safely become generated names");
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length || document.warnings.length) {
      throw new Error([...document.errors, ...document.warnings].map((error) => error.message).join("; "));
    }
    // Refuse aliases, merges and custom tags instead of guessing their expanded semantics.
    visit(document, (_, node) => {
      if (isAlias(node) || (node && typeof node === "object" && ("anchor" in node && node.anchor || "tag" in node && node.tag))) {
        throw new Error("YAML anchors, aliases and explicit tags are not supported");
      }
    });
    const definition: unknown = document.toJS();
    if (!mapping(definition) || !has(definition, "on") || !mapping(definition.jobs) || !Object.keys(definition.jobs).length) {
      throw new Error("Expected a workflow mapping with on and a nonempty jobs mapping");
    }
    if (!(text(definition.on) || mapping(definition.on) && Object.keys(definition.on).length || Array.isArray(definition.on) && definition.on.length && definition.on.every(text))) {
      throw new Error("Expected on to be an event string, array of event strings or mapping");
    }
    const workflowReasons: Reason[] = [];
    const keys = unknownKeys(definition, WORKFLOW_KEYS);
    if (keys.length) workflowReasons.push(reason("UNSUPPORTED_WORKFLOW_KEY", `Unsupported workflow keys: ${keys.join(", ")}.`));
    const invalidWorkflowSettings = invalidSettings(definition);
    if (has(definition, "run-name") && typeof definition["run-name"] !== "string") invalidWorkflowSettings.push("run-name");
    if (invalidWorkflowSettings.length) workflowReasons.push(reason("INVALID_WORKFLOW_SETTINGS", `Invalid literal workflow settings: ${invalidWorkflowSettings.join(", ")}.`));
    const metadata = Object.fromEntries(Object.entries(definition).filter(([key]) => key !== "jobs"));
    if (contains(metadata, /\$\{\{/)) {
      workflowReasons.push(reason("UNSUPPORTED_EXPRESSION", "Workflow expressions are outside v0.1's static subset."));
    }
    if (contains(metadata, STATE_CHANNELS)) workflowReasons.push(reason("SHARED_JOB_STATE", "Workflow settings refer to job identity or runner state channels."));
    const jobs = Object.entries(definition.jobs).map(([id, value]): Job => {
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(id) || !mapping(value)) throw new Error(`Invalid job mapping or ID: ${id}`);
      const reasons = [...workflowReasons];
      for (const key of FORBIDDEN) {
        if (has(value, key)) reasons.push(reason(`UNSUPPORTED_${key.toUpperCase()}`, `Job has ${key}; v0.1 does not compact this construct.`));
      }
      const unknown = unknownKeys(value, JOB_KEYS);
      if (unknown.length) reasons.push(reason("UNSUPPORTED_JOB_KEY", `Unsupported job keys: ${unknown.join(", ")}.`));
      if (!runner(value["runs-on"])) {
        reasons.push(reason("INVALID_RUNNER", "Job must declare runs-on as a nonempty string, label array or mapping."));
      }
      const invalid = invalidSettings(value);
      if (invalid.length) reasons.push(reason("INVALID_JOB_SETTINGS", `Invalid literal job settings: ${invalid.join(", ")}.`));
      if (has(value, "concurrency")) reasons.push(reason("UNSUPPORTED_CONCURRENCY", "Combining concurrency-controlled jobs changes scheduling, even when their declarations match."));
      if (has(value, "if") && typeof value.if !== "boolean" && value.if !== "true" && value.if !== "false") {
        reasons.push(reason("UNSUPPORTED_CONDITION", "Only literal true/false job conditions are supported."));
      }
      if (contains(value, /\$\{\{/)) reasons.push(reason("UNSUPPORTED_EXPRESSION", "Expressions can depend on the original job or step context; v0.1 does not rewrite them."));
      if (contains(value, STATE_CHANNELS)) {
        reasons.push(reason("SHARED_JOB_STATE", "Job uses identity or runner state channels whose semantics change when jobs share a runner."));
      }
      const steps: Mapping[] = [];
      if (!Array.isArray(value.steps) || !value.steps.length) {
        reasons.push(reason("INVALID_STEPS", "Expected a nonempty steps array."));
      } else {
        for (const [index, step] of value.steps.entries()) {
          if (!mapping(step) || !(text(step.run) && !has(step, "uses") || text(step.uses) && !has(step, "run"))) {
            reasons.push(reason("INVALID_STEP", `Step ${index + 1} must contain exactly one string run or uses.`));
            continue;
          }
          steps.push(step);
          const keys = unknownKeys(step, STEP_KEYS);
          if (keys.length) reasons.push(reason("UNSUPPORTED_STEP_KEY", `Step ${index + 1} has unsupported keys: ${keys.join(", ")}.`));
          if (has(step, "with") && has(step, "run")) reasons.push(reason("INVALID_STEP", `Run step ${index + 1} cannot have with.`));
          if (has(step, "name") && typeof step.name !== "string" ||
            has(step, "env") && !literalMap(step.env) || has(step, "with") && !literalMap(step.with) ||
            has(step, "shell") && !text(step.shell) || has(step, "working-directory") && !text(step["working-directory"]) ||
            has(step, "timeout-minutes") && (!positiveInteger(step["timeout-minutes"]) || Number(step["timeout-minutes"]) > 360)) {
            reasons.push(reason("INVALID_STEP", `Step ${index + 1} has invalid literal settings.`));
          }
        }
        if (steps.length && !has(steps.at(-1)!, "run")) reasons.push(reason("NON_PREFIX_USES", "The final step is uses; only identical setup actions preceding the run branch may be hoisted."));
      }
      return { id, definition: value, steps, reasons };
    });
    // Retained jobs must keep working: never remove a job ID targeted by needs.
    for (const job of jobs) {
      const dependents = jobs.filter((other) => {
        const needs = other.definition.needs;
        return needs === job.id || Array.isArray(needs) && needs.includes(job.id) ||
          has(other.definition, "needs") && (contains(needs, /\$\{\{/) || !(typeof needs === "string" || Array.isArray(needs) && needs.every(text)));
      });
      if (dependents.length) job.reasons.push(reason("DEPENDENCY_TARGET", `Job is needed by ${dependents.map((other) => other.id).join(", ")}; its ID must remain intact.`));
    }
    return { workflow: { path, definition, jobs } };
  } catch (error: unknown) {
    return { error: { workflow: path, code: "INVALID_WORKFLOW", message: error instanceof Error ? error.message : String(error) } };
  }
}

function compare(left: Workflow, a: Job, right: Workflow, b: Job): Reason[] {
  const reasons: Reason[] = [];
  if (!isDeepStrictEqual(left.definition.on, right.definition.on)) reasons.push(reason("TRIGGER_MISMATCH", "Complete on definitions differ."));
  if (!isDeepStrictEqual(a.definition["runs-on"], b.definition["runs-on"])) reasons.push(reason("RUNNER_MISMATCH", "runs-on declarations differ."));
  const differing = SETTINGS.filter((key) => has(a.definition, key) !== has(b.definition, key) || !isDeepStrictEqual(a.definition[key], b.definition[key]));
  if (differing.length) reasons.push(reason("JOB_SETTINGS_MISMATCH", `Job settings differ: ${differing.join(", ")}.`));
  if (left !== right) reasons.push(reason("WORKFLOW_BOUNDARY", "v0.1 keeps workflow identities and trigger boundaries separate."));
  let prefixLength = 0;
  // Reserve a final run step even if the entire jobs happen to be identical.
  while (prefixLength < Math.min(a.steps.length, b.steps.length) - 1 && isDeepStrictEqual(a.steps[prefixLength], b.steps[prefixLength])) prefixLength++;
  const tails = [a.steps.slice(prefixLength), b.steps.slice(prefixLength)];
  if (!prefixLength || tails.some((tail) => tail.some((step) => has(step, "uses")))) {
    const divergentRun = has(a.steps[prefixLength] ?? {}, "run") && has(b.steps[prefixLength] ?? {}, "run");
    reasons.push(reason(divergentRun && tails.some((tail) => tail.some((step) => has(step, "uses"))) ? "NON_PREFIX_USES" : "SETUP_PREFIX_MISMATCH", "Jobs need identical nonempty leading setup; uses steps cannot move from divergent tails."));
  } else if (tails.some((tail) => tail.length !== 1)) {
    reasons.push(reason("MULTI_STEP_BRANCH", "Native parallel documents individual steps, not sequential branches; v0.1 requires exactly one run step after setup."));
  }
  return reasons;
}

function uniqueReasons(reasons: Reason[]): Reason[] {
  return reasons.filter((item, index) => reasons.findIndex((other) => other.code === item.code && other.message === item.message) === index);
}

export function analyze(parsed: ParsedWorkflow[]): Analysis {
  const workflows = parsed.flatMap((item) => "workflow" in item ? [item.workflow] : []);
  const errors = parsed.flatMap((item) => "error" in item ? [item.error] : []);
  const groups: Group[] = [];
  const rejected: Report["rejected"] = [];
  const grouped = new Set<Job>();
  for (const workflow of workflows) {
    const available = workflow.jobs.filter((job) => !job.reasons.length);
    const usedIds = new Set(workflow.jobs.map((job) => job.id));
    for (const job of available) {
      if (grouped.has(job)) continue;
      const compatible = available.filter((other) => !grouped.has(other) && (other === job || !compare(workflow, job, workflow, other).length));
      if (compatible.length < 2) continue;
      // GitHub permits at most ten running background steps. Avoid a singleton remainder.
      while (compatible.length >= 2) {
        const count = compatible.length === 11 ? 9 : Math.min(10, compatible.length);
        const members = compatible.splice(0, count);
        const label = `${basename(workflow.path)}: ${members.map((member) => member.id).join(" + ")}`;
        const base = `compact_${basename(workflow.path).replace(/[^A-Za-z0-9_]/g, "_")}_${members.map((member) => member.id).join("_")}`;
        let id = base;
        for (let suffix = 2; usedIds.has(id); suffix++) id = `${base}_${suffix}`;
        usedIds.add(id);
        groups.push({ workflow, jobs: members, prefixLength: members[0]!.steps.length - 1, id, name: label });
        for (const member of members) grouped.add(member);
      }
    }
  }
  for (const workflow of workflows) {
    for (const job of workflow.jobs) {
      if (grouped.has(job)) continue;
      let reasons = job.reasons;
      if (!reasons.length) {
        reasons = workflows.flatMap((otherWorkflow) => otherWorkflow.jobs.flatMap((other) => {
          if (other === job || other.reasons.length) return [];
          return compare(workflow, job, otherWorkflow, other);
        }));
        if (!reasons.length) reasons = [reason("NO_COMPATIBLE_PEER", "No other supported job can share this setup.")];
      }
      rejected.push({ workflow: workflow.path, job: job.id, reasons: uniqueReasons(reasons) });
    }
  }
  const report: Report = {
    workflows: workflows.map((workflow) => ({
      path: workflow.path, name: workflow.definition.name ?? null, on: workflow.definition.on,
      jobs: workflow.jobs.map((job) => ({ id: job.id, name: job.definition.name ?? null, status: grouped.has(job) ? "compatible" : "rejected" })),
    })),
    groups: groups.map((group) => ({ workflow: group.workflow.path, jobs: group.jobs.map((job) => job.id), prefixLength: group.prefixLength, id: group.id, name: group.name })),
    rejected, errors,
  };
  return { workflows, groups, report };
}

export function compile(analysis: Analysis): string {
  if (analysis.report.errors.length) throw new Error(analysis.report.errors.map((error) => `${error.workflow} [${error.code}] ${error.message}`).join("\n"));
  return analysis.workflows.map((workflow) => {
    const jobs: Mapping = Object.create(null);
    for (const job of workflow.jobs) {
      const group = analysis.groups.find((group) => group.workflow === workflow && group.jobs.includes(job));
      if (!group) {
        jobs[job.id] = job.definition;
      } else if (group.jobs[0] === job) {
        const settings = Object.fromEntries(["runs-on", ...SETTINGS].filter((key) => has(job.definition, key)).map((key) => [key, job.definition[key]]));
        jobs[group.id] = {
          name: group.name, ...settings,
          steps: [
            ...job.steps.slice(0, group.prefixLength),
            { parallel: group.jobs.map((member) => ({
              ...member.steps[group.prefixLength],
              name: `${workflow.path}:${member.id}${typeof member.definition.name === "string" ? ` (${member.definition.name})` : ""}${typeof member.steps[group.prefixLength]!.name === "string" ? ` / ${member.steps[group.prefixLength]!.name}` : ""}`,
            })) },
          ],
        };
      }
    }
    return `---\n# Source: ${JSON.stringify(workflow.path)}\n${stringify({ ...workflow.definition, jobs }, { lineWidth: 0 })}`;
  }).join("");
}
