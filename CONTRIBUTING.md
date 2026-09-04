# Contributing

Small, focused pull requests are welcome. Open an issue for substantial behavior changes before implementation. Keep ambiguous SDK outcomes and unhealthy state fail-closed, preserve exact canonical-thread verification and queue serialization, use isolated fixture state for tests, and update public documentation when user-visible behavior changes. Discussion and ask turns must resume the canonical thread with the SDK's mechanical `read-only` sandbox; implementation turns use `workspace-write`.

The controller runner, hooks, and route guard execute from the live plugin tree. Develop any schema or state-shape change in a separate checkout or copy and swap it in only after the active runner exits; pause status polling during the swap. A future release should add a schema-compatibility gate that refuses to migrate live state while `controller.activeOperationId` is set and its runner PID is alive.

By contributing, you agree that your contribution is licensed under the MIT License.
