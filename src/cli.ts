// /src/cli.ts
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { analyze, compile, parseWorkflow } from "./compiler.js";

const VERSION = "0.0.1";
const HELP = `gh ci-compact

Compact simple GitHub Actions jobs using native parallel steps.

Usage:
  gh ci-compact analyze [path] [--json]
  gh ci-compact compile [path]
  gh ci-compact --version
  gh ci-compact --help

Path defaults to .github/workflows; accepts a directory or one YAML file.
Compile writes a YAML document stream to stdout and leaves source files intact.
`;

async function readWorkflows(path: string) {
  const info = await stat(path);
  const files = info.isDirectory()
    ? (await readdir(path, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
        .map((entry) => join(path, entry.name))
        .sort()
    : info.isFile() && /\.ya?ml$/.test(path) ? [path] : [];
  if (files.length === 0) {
    throw new Error(`No .yml or .yaml workflow files found at ${path}`);
  }
  const workflows = [];
  for (const file of files) workflows.push(parseWorkflow(file, await readFile(file, "utf8")));
  return workflows;
}

async function main(argv: string[]): Promise<void> {
  if (argv.length === 0 || (argv.length === 1 && ["--help", "-h"].includes(argv[0]!))) {
    process.stdout.write(HELP);
    return;
  }
  if (argv.length === 1 && ["--version", "-v"].includes(argv[0]!)) {
    console.log(VERSION);
    return;
  }
  const [command, ...args] = argv;
  const paths = args.filter((arg) => !arg.startsWith("-"));
  if (
    !["analyze", "compile"].includes(command!) || paths.length > 1 ||
    args.some((arg) => arg.startsWith("-") && !(command === "analyze" && arg === "--json")) ||
    args.filter((arg) => arg === "--json").length > 1
  ) {
    console.error("Invalid arguments. Use gh ci-compact --help.");
    process.exitCode = 2;
    return;
  }
  const path = paths[0] ?? ".github/workflows";
  const json = args.includes("--json");
  let analysis;
  try {
    analysis = analyze(await readWorkflows(path));
  } catch (error: unknown) {
    analysis = analyze([]);
    analysis.report.errors.push({ workflow: path, code: "INPUT_ERROR", message: error instanceof Error ? error.message : String(error) });
  }
  if (command === "analyze") {
    if (json) {
      console.log(JSON.stringify({ schema: "gh-ci-compact/analyze/v1", path, ...analysis.report }, null, 2));
    } else {
      for (const workflow of analysis.report.workflows) {
        console.log(`${workflow.path}: ${workflow.jobs.length} job(s)`);
        for (const job of workflow.jobs) console.log(`  ${job.id}: ${job.status}`);
      }
      for (const group of analysis.report.groups) {
        console.log(`Compatible: ${group.workflow} [${group.jobs.join(", ")}] (${group.prefixLength} setup step(s))`);
      }
      for (const rejection of analysis.report.rejected) {
        for (const reason of rejection.reasons) {
          console.log(`Not compiled: ${rejection.workflow}:${rejection.job} [${reason.code}] ${reason.message}`);
        }
      }
      for (const error of analysis.report.errors) console.log(`${error.workflow} [${error.code}] ${error.message}`);
    }
  } else {
    // Build the complete result before writing, so invalid input cannot emit partial YAML.
    const yaml = compile(analysis);
    for (const rejection of analysis.report.rejected) {
      for (const reason of rejection.reasons) {
        console.error(`Not compiled: ${rejection.workflow}:${rejection.job} [${reason.code}] ${reason.message}`);
      }
    }
    process.stdout.write(yaml);
  }
  if (analysis.report.errors.length > 0) process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`gh-ci-compact: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
