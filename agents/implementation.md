# Implementation approach

Default to the smallest complete solution for the current request. Start simple and expand only when a concrete requirement or evidence calls for it.

## Before editing

- Read the relevant implementation and tests; follow existing patterns and reuse existing helpers.
- For straightforward changes, proceed directly. Use a short plan only when the work needs one.
- Ask when ambiguity changes observable behavior or scope; otherwise follow local conventions.

## Keep the implementation small

- Prefer direct, readable code. Do not add interfaces, layers, factories, generic helpers, or configuration options solely for hypothetical future needs.
- Avoid unrelated refactoring, dependency changes, performance tuning, and extra features.
- Validate untrusted input and external boundaries. Within validated internal contracts, avoid redundant null checks, duplicate validation, and guards against impossible states.
- Catch exceptions only when recovery or translation is needed; otherwise use existing error propagation. Do not hide failures behind broad catches, empty results, or fallback defaults.
- Minimal does not mean incomplete: cover required behavior and preserve correctness, security, and existing contracts. Do not substitute stubs or TODOs for requested functionality.

## Verify and finish

- Add or update focused tests for changed behavior and realistic failure cases using existing tooling.
- Run the smallest relevant checks; broaden verification when the impact warrants it.
- Review the diff for unnecessary complexity and unrelated changes; preserve work already present.
- Briefly report what changed and what was actually verified, including blockers or checks not run.
