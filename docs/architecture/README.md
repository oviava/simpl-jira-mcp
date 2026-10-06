# Jira MCP architecture sketches

These files describe the design contracts for [mcp-architecture.md](../mcp-architecture.md). They remain reference sketches and are not imported by `src/`; the runtime uses schema-inferred contracts from `src/schemas.ts`. Functions with bodies throw `not implemented` because they are illustrative only.

The schemas own validation and inferred input types. The contracts own domain results and the concrete Jira client's operation signatures. The usage sketch records representative MCP calls. The server sketch shows the intended SDK registration, cancellation, and stdio factory wiring. The [rationale](rationale.md) records the compared candidates and synthesis.

The target compiler is TypeScript 7 with NodeNext modules, strict checking, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and explicit Node types. The target runtime is Node.js 24 LTS. Zod 4 and the official MCP SDK v2 supply schema and protocol support.

Syntax checking with `node --check` does not establish type correctness. The runtime's strict TypeScript build and official-client stdio tests provide that verification. The static check also compares staged sketch names with runtime input/output schema names and tool registrations, and reports the documented rollout gaps. It does not compare schema fields or prove that a tool's behavior matches its contract.

Run `node docs/architecture/check.ts` from the repository root to repeat sketch syntax, staged/runtime catalog, local-link, and retained-evidence checks. Its output separates the staged contracts, runtime schemas, registered tools, unadvertised attachment reader, and six write tools that still need implementation. This check uses Node's TypeScript support and imports no server dependencies. It also checks that the retired investigation scripts and their runnable references remain absent.
