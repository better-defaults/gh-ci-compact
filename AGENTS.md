<!-- /AGENTS.md -->

# Repository working rules

## Project context

- Mission: Convert multiple short GitHub Actions jobs into one parallel job while preserving logical task boundaries and emitting structured diagnostics.
- Product contract: `README.md` defines the intended goal and user-facing usage. The current `analyze` and `compile` commands are scaffolds; do not describe workflow analysis or transformation as implemented. Document accepted behavior in `README.md` and verify it in tests as the CLI develops.
- Supported environments: Node.js 22+ and npm; TypeScript source compiled to Node.js ESM; `.mjs` build scripts and tests. The `gh-ci-compact` extension launcher requires Bash and Node.js. GitHub CLI is required for extension installation and invocation; no minimum GitHub CLI version or platform support matrix is defined.
- Setup: Run `npm ci` from the repository root using the committed `package-lock.json`. To exercise the checkout as an extension, run `gh extension install .` after building.
- Quality gates: `npm run check` runs `npm run typecheck` (`tsc --noEmit`) and `npm test`. `npm test` rebuilds the CLI and runs `node --test test/*.test.mjs`. `npm run build` is the build command. No formatter or linter command is configured; follow the surrounding style.
- Generation: `scripts/build.mjs` bundles `src/cli.ts` with esbuild into the committed `dist/cli.js` and `dist/cli.js.map`, targeting Node.js 22 and making the CLI executable. Regenerate with `npm run build`; never hand-edit `dist/`. `npm run clean` removes `dist/`.
- Language rules: Use English for identifiers, comments, documentation, and CLI text. Follow the user's requested language for collaboration.
- Workflow: The default branch is `main`. Use focused branches and pull requests targeting `main`. No repository-specific merge strategy, release procedure, publication automation, or GitHub Actions workflow is currently defined; do not claim otherwise or publish as part of an unrelated change.

## Authority

- Read applicable nested `AGENTS.md` files before editing their directories.
- `AGENTS.md` defines working rules; `README.md` defines intended product behavior.
- Give each definition one authoritative source. Code and executable configuration define implementation details; tests verify contracts; decision records, when introduced, explain rationale. Keep npm commands in `package.json` and compiler options in `tsconfig.json`.
- Plans, exploratory notes, examples, and hypotheses are not accepted requirements. Re-evaluate old ideas and promote accepted decisions into authoritative documentation.
- Resolve conflicts explicitly. Intentional behavior changes require contract and verification updates. A passing scaffold test does not establish that workflow compaction works.
- Update generated artifacts through their source or generator, then regenerate. Identify generated files clearly in documentation or generator-owned comments. Keep human-readable documentation useful without duplicating maintenance.

## Design

- Make the smallest coherent change satisfying the current requirement.
- Prefer explicit code, simple control flow, focused functions, deletion, and consolidation.
- Introduce abstractions only for a real repeated concept or system boundary. Avoid speculative frameworks, extension points, adapters, registries, and compatibility layers.
- Separate deterministic logic from filesystem, process, and GitHub effects where useful; do not force an architectural pattern.
- Give mutable state and side effects one clear owner. Derive values instead of synchronizing duplicate state.
- Use coherent domain types and closed-state representations to make invalid states difficult to express. Keep the strict checks in `tsconfig.json` enabled.
- Long-lived asynchronous operations and child processes need ownership, cancellation, and stale-result rules.
- Judge complexity by state, ownership, concurrency, and control flow, not line count. The existing file layout is not a contract.

## Implementation

- Use TypeScript and Node.js normally. Prefer standard facilities and existing dependencies; use the installed `yaml` dependency when YAML parsing is needed.
- Keep source imports compatible with NodeNext ESM and use explicit `node:` imports for Node.js built-ins.
- Validate untrusted CLI arguments, workflow files, and external responses at narrow boundaries and convert them into precise domain values.
- Handle failures explicitly, preserve useful context, and expose unsafe or incomplete outcomes. Do not silently swallow errors or hide unclear partial success behind fallback behavior.
- Keep machine-readable output parseable; do not mix progress messages into JSON output. Treat documented schemas and exit behavior as contracts when changing them.
- Use the shortest precise name: nouns for concepts, verbs for actions, and state or question names for booleans. Make mutation and I/O visible.
- Avoid vague names and catch-all modules. Keep imports explicit; add re-exports only for an intentional public API.

## Evidence and refactoring

- Distinguish observed facts, hypotheses, and unknowns. Never promote an inference, proposal, or placeholder into an established fact.
- When uncertain external behavior affects correctness, inspect relevant version-specific documentation or run a discriminating experiment. This includes GitHub Actions semantics and GitHub CLI behavior.
- Understand existing mechanisms before adding retries, delays, recovery paths, or state.
- Structural refactors preserve behavior, including timing, ordering, cancellation, and asynchronous boundaries, unless deliberately changed.
- Keep unrelated cleanup separate. Reassess remaining work when earlier changes make it unnecessary.

## Comments and headers

- Explain invariants, assumptions, ownership, external constraints, and non-obvious decisions. Comments must add information beyond names, types, and code.
- New or touched repository-authored files supporting comments use a repository-relative path header beginning with `/` in native comment syntax: `// /src/cli.ts`, `// /scripts/build.mjs`, `// /test/cli.test.mjs`, `# /gh-ci-compact`, or `<!-- /README.md -->`, as applicable. Do not retrofit unrelated files solely to add headers.
- Required first-line directives, including shell and Node.js shebangs, precede the header. Keep touched headers accurate.
- Exempt generated `dist/` files, the package-manager-owned lockfile, and the standard `LICENSE` text. JSON files such as `package.json` and `tsconfig.json` do not support comments; never invent comments for unsupported formats.

## Tests and quality

- Test observable behavior and stable contracts, including rejection paths and regressions, at the lowest useful level. The current CLI tests use Node.js's built-in test runner against `dist/cli.js`.
- Keep tests deterministic. Use focused fakes and real integration tests where external behavior cannot be represented faithfully. Avoid requiring network access or a signed-in GitHub account for ordinary tests.
- Update meaningful tests for changed behavior. Avoid placeholder tests and assertions preserving obsolete architecture. Replace scaffold assumptions as accepted behavior is implemented.
- Run affected canonical gates before completion; use `npm run check` for source, build, or test changes. If CI is added, it must invoke the same repository-local npm commands.
- Keep validation free of source fixes and lockfile regeneration. The existing `npm test` and `npm run check` deliberately rebuild `dist/`; inspect the generated diff afterward and report unexpected changes. Do not describe these commands as non-mutating.
- Separate intentional source fixes and generation from review of verification results. Do not change the build or test pipeline merely to make a documentation change pass.
- Fix underlying problems. Do not weaken checks, grow diagnostic baselines, add unchecked casts, or suppress diagnostics merely to pass.
- Report failures and unavailable checks accurately. Distinguish automated, manual, and platform-specific validation; direct Node.js tests do not prove GitHub CLI installation or cross-platform support.

## Dependencies and workflow

- Install from `package-lock.json` with `npm ci`. Update `package.json` and `package-lock.json` together through npm; never hand-edit the lockfile.
- Add dependencies only for a concrete need.
- Keep setup idempotent and separate from validation. Any lifecycle or CI automation added must call repository-local entry points and must not regenerate lockfiles during checks.
- Follow repository workflow. Do not bypass hooks or rules to evade failures.
- Keep secrets, credentials, caches, coverage, logs, `node_modules/`, and local runtime state out of source control. `dist/cli.js` and `dist/cli.js.map` are intentional tracked build outputs used by the extension launcher and package entry point; include their regeneration when source or build changes affect them.
- Preserve executable permissions and shebangs on `gh-ci-compact` and generated `dist/cli.js`.

## Completion

Confirm contract alignment, update authoritative sources, regenerate affected outputs, and run affected gates. Check for dead state, stale names, duplicate representations, obsolete tests, and unnecessary compatibility code. Review the final diff, including tracked `dist/` artifacts when a gate rebuilt them.

Report what changed, why, actual validation results, and unresolved limits.
