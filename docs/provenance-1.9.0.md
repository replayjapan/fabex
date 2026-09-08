# Restriction provenance — 1.9.0

The owner clarified that routine development is an authorized workflow, not a
series of command-by-command approvals. Agent-written repair briefs and bundled
release approvals are not independent evidence that the owner requested each
restriction. This audit uses the available owner messages and source history;
it does not claim access to a complete original transcript.

| Restriction | Source | Introduction / evidence | Disposition |
| --- | --- | --- | --- |
| Main/subagent normal Bash allowlist | Agent-proposed | 1.5.0 `3b1616e` changes general deferral to allowlisting | Removed as the default work gate; targeted backstops and effect review replace it |
| Normal MCP read-only allowlist | Agent-proposed | 1.5.0 `3b1616e` | Relaxed; source-authoring paths, command payloads and named destructive/delivery effects still checked |
| Exact argv exceptions needed for routine work | Agent-proposed | 1.5.1 `6dc3bd5` | Not required for ordinary work; legacy matching retained for compatibility, never treated as proof of read-only effects |
| Bash output limited to external configured roots | Agent-proposed generalization | 1.5.0 `3b1616e`, refined 1.5.1 `6dc3bd5` | No general work-mode gate; source redirection still belongs to Codex. Discussion scratch roots retain canonical validation |
| Separate approval for every migration, install, seed or fixture | Agent-proposed repair policy | 1.8.2 `f9dcb30`, 1.8.3 `34227f1` briefs and script inspection | Removed for reviewed, scoped development effects within the owner's task |
| Known-framework-only dev-script admission | Agent-proposed | 1.8.3 `34227f1` | Removed from ordinary work; optional discovery reports review notes, keeps destructive checks and ambiguity handling |
| Optional persistent server ownership helper | Agent-proposed implementation of requested workflow | 1.8.2 `f9dcb30`; no-config discovery 1.8.3 `34227f1` | Kept; no mandatory configuration or per-project activation |
| Mode grants / independent-first / full answer relay | Owner-requested | 1.6.0 `3d70694`; exact relay 1.7.0 `e5e4863` | Kept; current owner explicitly reaffirms them |
| Codex source authorship | Owner-requested, earliest wording partly unresolved | Owner requested Codex do the coding; roles later codified in 1.2.0 | Kept. Runtime artifacts, lockfile generation and development DB effects are not necessarily source authorship |
| Mandatory operational-only Git delivery | Agent-proposed mechanism; later included in bundled approvals, not independently owner-originated | 1.2.0 `4a2fe92`, plugin identity correction `0db3b48`; expanded in 1.5.0 `3b1616e` | 1.9.1 makes delegation optional: main-session reviewed authorized delivery may defer to host in work mode. Other agents and read-only routes remain denied. Historical changelog codification does not prove original owner intent |
| Fable does not visually review images; use Codex/lower-model helper | Owner-requested | Owner's direct image-review request; implementation 1.7.1 `0f85cac` | Kept, including direct image Read/WebFetch denials; host-injected images remain a platform limitation |
| Reject every Bash/MCP argument mentioning an image extension | Agent-proposed mechanism | 1.7.1 `0f85cac` | Removed: metadata, path handling and capture need not perform visual review |
| Only two delegation types in discussion | Agent-proposed | 1.7.1 `0f85cac` | Relaxed; every delegated tool call remains subject to the current route. No delegated mutations |
| Read-only discussion/ask | Owner-requested mode semantics; restrictive command list agent-proposed | Predates 1.5.0, later read-path expansions | Kept, expanded useful read commands. Unknown scripts and mutating configured exceptions are not declared read-only |
| No destructive resets, production changes, unrelated privilege or unrelated-process termination | Owner-requested in restoration task | Current owner message; prior safe-stop requirement | Kept. Named deny rules are backstops, not a complete semantic security boundary |
| Codex network default false | Agent-proposed; disposition unresolved | 1.5.0 `3b1616e` | Unchanged, provenance exposed in diagnose. Do not label it host-required |
| Native sandbox / host permission classifier | Host-required boundary | Reported EPERM and host refusals | Never bypassed; Fabex deferral is not a native permission grant |

## Enforcement tradeoff and unresolved scope

A short deny list cannot prove arbitrary script or MCP effects, follow every
indirect shell program, identify a production database from a secret connection
string, or guarantee source authorship through all interpreters. The broader
work policy therefore depends on the executor reviewing actual targets and
effects before running a command. It is not equivalent to the former allowlist's
mechanical containment, and must not be advertised as such.

In particular, a read-only command exception is not inferred merely from an
owner-authored `allowedCommandPatterns` entry: that entry may permit a migration.
Custom database diagnostic scripts in discussion remain unresolved unless their
execution has an independently read-only boundary. Do not turn this into a new
per-command owner activation ritual or silently run them in a write-capable mode.

Generic kill remains blocked; use a verified host task or the existing owned
server helper. Full original role wording, live installed-runtime verification,
and host-executed acceptance remain separate evidence gaps. No app data, plugin
state schema, network default or installed plugin is changed by these source edits.
