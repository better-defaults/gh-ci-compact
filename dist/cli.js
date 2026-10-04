#!/usr/bin/env node

// src/cli.ts
var VERSION = "0.0.1";
function usage() {
  console.log(`gh ci-compact

Compact GitHub Actions jobs into parallel, machine-readable CI.

Usage:
  gh ci-compact analyze [path] [--json]
  gh ci-compact compile [path]
  gh ci-compact --version
  gh ci-compact --help
`);
}
function positionalArgument(args) {
  return args.find((arg) => !arg.startsWith("-"));
}
function main(argv) {
  const args = [...argv];
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  const command = args.shift();
  switch (command) {
    case "analyze": {
      const json = args.includes("--json");
      const workflowPath = positionalArgument(args) ?? ".github/workflows";
      if (json) {
        console.log(
          JSON.stringify(
            {
              schema: "gh-ci-compact/analyze/v1",
              path: workflowPath,
              jobs: []
            },
            null,
            2
          )
        );
        return;
      }
      console.log(`Analyzing ${workflowPath}`);
      return;
    }
    case "compile": {
      const workflowPath = positionalArgument(args) ?? ".github/workflows";
      console.log(`Compiling ${workflowPath}`);
      return;
    }
    default:
      console.error(`Unknown command: ${command ?? ""}`);
      usage();
      process.exitCode = 2;
  }
}
main(process.argv.slice(2));
//# sourceMappingURL=cli.js.map
