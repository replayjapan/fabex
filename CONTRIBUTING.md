# Contributing

Small, focused pull requests are welcome. Open an issue for substantial behavior changes before implementation. Keep ambiguous SDK outcomes and unhealthy state fail-closed, preserve exact canonical-thread verification and owner-cycle FIFO serialization, use isolated fixture state for tests, and update public documentation when user-visible behavior changes. Discussion and ask turns must resume the canonical thread with the SDK's mechanical `read-only` sandbox; implementation turns use `workspace-write`.

Both-participant changes must preserve the strict two-phase boundary: Phase 1 contains only the owner message and the previous owner-visible Claude reply, while Phase 2 is a separately linked turn containing the stored independent result and current Fable response. Mode changes require a session-bound, short-lived grant from `UserPromptExpansion`; no AI executor may synthesize or bypass one. Use only documented stable hook events—preview function hooks are not a guard dependency.

The controller runner, hooks, and route guard execute from the live plugin tree. Develop any schema or state-shape change in a separate checkout or copy and swap it in only after the active runner exits; pause status polling during the swap. The migration gate returns `migration-deferred` and leaves the old document untouched while `controller.activeOperationId` is set and its runner PID is alive. Preserve that check in every future schema migration.

By contributing, you agree that your contribution is licensed under the MIT License.
