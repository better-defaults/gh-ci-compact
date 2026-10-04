<!-- /README.md -->

# gh-ci-compact

Compact simple GitHub Actions jobs into a job with native parallel steps.
The first compiler PoC implements a conservative v0.1 subset. It analyzes
workflow files offline and prints proposed YAML; it never edits the inputs.
Runtime diagnostics, GitHub API integration and publishing are outside this PoC.

## Install

Requires Node.js 22+, Bash and GitHub CLI.

    gh extension install better-defaults/gh-ci-compact

## Usage

    gh ci-compact analyze [path] [--json]
    gh ci-compact compile [path]
    gh ci-compact --help
    gh ci-compact --version

`path` defaults to `.github/workflows`. It may be a directory or a single
`.yml`/`.yaml` file. Directory discovery reads direct regular files with these
lowercase extensions in sorted filename order; it does not recurse or follow
directory entries that are symlinks. Jobs retain their source mapping order.
Missing paths, unreadable inputs and directories without workflows are errors.

`analyze` inventories workflow paths, workflow names, complete `on` definitions,
job IDs and job names. It reports compatible groups, their generated IDs and
names, the number of shared setup steps, and every job that will not be compiled
with reason codes and explanations. Human-readable output goes to stdout.
`analyze --json` writes only a JSON object to stdout, with no progress messages:

```json
{
  "schema": "gh-ci-compact/analyze/v1",
  "path": ".github/workflows",
  "workflows": [],
  "groups": [],
  "rejected": [],
  "errors": []
}
```

Each workflow entry has `path`, `name`, `on` and `jobs`; each job has `id`,
`name` and `status` (`compatible` or `rejected`). Absent names are `null`.
Each group has `workflow`, `jobs` (source job IDs), `prefixLength`, `id` and
`name`. Each rejection has `workflow`, `job` and `reasons`, whose entries have
`code` and `message`. Input errors have `workflow`, `code` and `message` in
`errors`; valid workflows remain inventoried when a different file is invalid.
For an unmatched otherwise-supported job, reasons describe differences from
supported peers, or `NO_COMPATIBLE_PEER` if none exists. Codes are stable;
explanation text is for humans.

`compile` prints one YAML document per input workflow to stdout, separated by
`---` and identified by a source-path comment. **A multi-document stream must
be split into separate files before use with GitHub Actions.** For each group
of at least two jobs it replaces the source jobs with one compact job at the
first member's position. It emits the shared prefix once, followed by a native
`parallel` list with one branch per original job. Generated job IDs include the
workflow filename and source job IDs; collisions receive numeric suffixes.
Generated job names identify the workflow file and job IDs. Branch names include
the workflow path, job ID, and original job/step names when present. Branches
retain their original `run` strings and supported step fields.

Unsupported and unmatched jobs keep their IDs and parsed definitions in the
output. Every such job is reported as `Not compiled` on stderr, with codes and
explanations. Workflow metadata is retained. YAML formatting and comments are
not preserved. Identical inputs and paths produce identical output.

Commands exit `0` for a completed analysis/compilation, including rejected jobs;
`1` for I/O, YAML or workflow-shape errors; and `2` for invalid arguments.
`analyze --json` includes input errors as JSON with exit `1` and empty stderr.
Compilation aborts on any input error before writing YAML to stdout and reports
the error on stderr. Invalid arguments write usage guidance to stderr and leave
stdout empty. Only `analyze` accepts `--json`; unknown flags, duplicate flags and
multiple paths are rejected.

## Verified native syntax and target

Before implementing generation, the compiler's target was checked against
[GitHub Enterprise Cloud `@latest` workflow syntax](https://docs.github.com/en/enterprise-cloud@latest/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsparallel)
on October 5, 2026. This is the Cloud documentation version, not a pinned
runner release. It documents `steps: - parallel: [...]` as concurrent individual
steps followed by an implicit wait. Background-step failures propagate at the
wait; outputs/environment changes become available after waiting. At most ten
background steps run concurrently. Composite actions cannot contain `parallel`.
The [Enterprise Server 3.20 reference](https://docs.github.com/en/enterprise-server@3.20/actions/reference/workflows-and-actions/workflow-syntax)
does not document this keyword. v0.1 targets the documented Cloud syntax and
does not claim Enterprise Server or self-hosted runner version support.

The documented parallel entries are individual steps. Sequential lists inside
branches are not documented. Therefore v0.1 accepts **exactly one `run` step
after the shared prefix per job**, including a multiline run script. It rejects
longer tails instead of inventing nested `steps` or joining shell scripts. Order
is preserved in the setup prefix, in each original script, and in branch listing.

For example, jobs `lint`, `typecheck` and `format`, each with the same checkout,
Node setup and `npm ci`, followed by its own check, produce:

```yaml
jobs:
  compact_checks_yml_lint_typecheck_format:
    name: "checks.yml: lint + typecheck + format"
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - run: npm ci
      - parallel:
          - name: "checks.yml:lint"
            run: npm run lint
          - name: "checks.yml:typecheck"
            run: npm run typecheck
          - name: "checks.yml:format"
            run: npm run format:check
```

## v0.1 supported subset

- Groups remain inside one source workflow. Cross-workflow merging is rejected
  even for equivalent triggers, to preserve workflow identity and dispatch
  boundaries. Complete `on` values are compared when explaining cross-workflow
  rejection; event names alone are insufficient.
- `runs-on` must be present and equivalent. Literal strings, label arrays and
  runner mappings using only `group` and/or `labels` are supported. Labels must
  be nonempty strings or nonempty arrays of nonempty strings; groups must be
  nonempty strings. Mapping key order is immaterial; array order,
  scalar types and values matter. Equivalent shorthand forms are not inferred.
- Job `permissions`, `env`, `defaults`, `if`, `timeout-minutes` and
  `continue-on-error` must both be absent or have equivalent literal values.
  Absent and explicit values differ. Only literal boolean or string `true`/`false`
  job conditions are accepted. Equal settings are copied to the compact job.
  Job concurrency is always rejected because combining jobs changes scheduling.
- Workflow `name`, `run-name`, `on`, `permissions`, `env` and `defaults` are
  retained. Other workflow keys, including workflow concurrency, prevent all
  jobs in that workflow from being compacted.
- A nonempty, identical leading setup sequence is required. Full parsed step
  values must match, including names and action inputs. Setup may contain
  `uses` and `run`; only this identical prefix can be hoisted. A final run step
  is reserved per job even when the entire step lists are identical.
- Steps support `name`, `run` or `uses`, `with` (actions only), `env`, `shell`,
  `working-directory` and `timeout-minutes`. Each step must have exactly one
  nonempty string `run` or `uses`. Commands are copied verbatim, including multiline
  scripts; no shell or command rewriting occurs.
- Names must be strings. `env` and action `with` must map to strings, finite
  numbers or booleans. Permissions support `read-all`, `write-all` or a mapping
  with `read`/`write`/`none` values. Defaults contain only `run`, with string
  `shell`/`working-directory`. Shells/directories must be nonempty strings,
  timeouts positive integers (step timeouts at most 360), and job
  `continue-on-error` a boolean. Invalid settings prevent compaction.
- Groups have two to ten members. Larger compatible sets are split in source
  order; an eleven-member remainder splits into nine and two to avoid leaving
  a singleton. A job without a compatible peer remains unchanged.

## Rejections and limits

| Reason code | Why the job cannot be compiled |
| --- | --- |
| `UNSUPPORTED_NEEDS` | Job declares dependencies. |
| `DEPENDENCY_TARGET` | A retained job needs this ID; removing it would break dependencies. |
| `UNSUPPORTED_STRATEGY` | Matrices and all other strategy declarations are excluded. |
| `UNSUPPORTED_SERVICES` | Service lifecycle/isolation would change. |
| `UNSUPPORTED_CONTAINER` | Container isolation would change. |
| `UNSUPPORTED_ENVIRONMENT` | Deployment environments are excluded. |
| `UNSUPPORTED_OUTPUTS` | Job outputs are excluded. |
| `UNSUPPORTED_CONCURRENCY` | Job scheduling semantics would change, even for identical concurrency. |
| `UNSUPPORTED_WORKFLOW_KEY` / `UNSUPPORTED_JOB_KEY` | Unknown/unsupported keys, including reusable jobs, are not transformed. |
| `UNSUPPORTED_STEP_KEY` | IDs, conditions, continue-on-error, existing parallel/background/wait/cancel and other unsupported step keys are excluded. |
| `UNSUPPORTED_CONDITION` | Nonliteral job condition. |
| `UNSUPPORTED_EXPRESSION` | `${{ ... }}` expressions may depend on job/step context; none are rewritten. |
| `SHARED_JOB_STATE` | Visible references to job/workflow identity, runner state files or legacy state-changing workflow commands. |
| `TRIGGER_MISMATCH` | Complete `on` values differ, including event filters/configuration. |
| `RUNNER_MISMATCH` | Runner declarations differ. |
| `JOB_SETTINGS_MISMATCH` | Job-level settings differ, including absent versus present. |
| `WORKFLOW_BOUNDARY` | Jobs belong to different workflows. |
| `SETUP_PREFIX_MISMATCH` | No identical nonempty setup leaves supported branches. |
| `NON_PREFIX_USES` | An action lies outside the common prefix, including a final action. |
| `MULTI_STEP_BRANCH` | More than one sequential run step would remain in a branch. |
| `NO_COMPATIBLE_PEER` | No other supported job can share the setup. |
| `INVALID_RUNNER` / `INVALID_STEPS` / `INVALID_STEP` | Job or step has an unsupported shape. |
| `INVALID_JOB_SETTINGS` / `INVALID_WORKFLOW_SETTINGS` | Accepted literal settings have invalid types or fields. |

`INPUT_ERROR` reports filesystem/discovery failure. `INVALID_WORKFLOW` reports
YAML errors, duplicate keys, multiple input documents, anchors/aliases/explicit
tags, or a missing/invalid `on`, nonempty `jobs` mapping or job ID/mapping.
Workflow paths containing `${{` are rejected to keep generated names literal.
Parsing uses YAML 1.2, so `on` remains a string key. This is a structural compiler,
not a full GitHub workflow validator.

Compaction intentionally replaces separate workflow job checks with one job and
runs branches on a shared runner/workspace. External required checks must be
reviewed before adopting output. Static analysis cannot prove that arbitrary
shell commands, invoked scripts or setup actions have no shared-file side
effects; use independent checks. Visible `GITHUB_JOB`, `GITHUB_WORKFLOW`,
`GITHUB_ENV`, `GITHUB_OUTPUT`, `GITHUB_PATH`, `GITHUB_STATE`,
`GITHUB_STEP_SUMMARY` and legacy state-changing commands are rejected.
There is no remote execution, runtime isolation, branch-specific output model,
GitHub schema validation or live GitHub execution test in this PoC.

## Development

    npm ci
    npm run check

`npm run check` typechecks, rebuilds and runs deterministic offline fixture tests.
`npm run build` generates tracked `dist/cli.js` and `dist/cli.js.map` through
esbuild; never edit them by hand. The entry point remains executable with a Node
shebang. CI uses Node.js 22, `npm ci` and the same `npm run check` gate. No new
dependency or lockfile update is needed for the compiler.

Install the current checkout as a GitHub CLI extension after building:

    gh extension install .

The tests invoke Node.js directly; they do not establish GitHub CLI installation
or cross-platform behavior.
