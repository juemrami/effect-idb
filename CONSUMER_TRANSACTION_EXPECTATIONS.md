# Consumer Transaction Expectations

From a consumer point of view, transaction behavior should be explicit and predictable.

## Recommended default behavior

- Top-level operations (`get`, `put`, `add`, `getAll`, `delete`) should run in isolated transactions by default.
- Consumers should not need to know internal layer/runtime caching details to avoid transaction lifecycle errors.

## When transaction sharing should happen

- Share transactions only when the consumer opts in through an explicit scope (for example, a `transaction(...)` or `batch(...)` style API).
- If a shared transaction is used implicitly, the library should document the exact scope boundaries and concurrency implications.

## Why this matters

- **Predictability:** `await` order should be enough to reason about behavior.
- **Safety under concurrency:** fire-and-forget plus awaited calls should not accidentally reuse stale transaction handles.
- **Debuggability:** implicit sharing can produce non-local failures like `TransactionInactiveError`.
- **Ergonomics:** aligns with common expectations from DB APIs where transaction scope is explicit.

## Practical contract

- **Default:** fresh transaction per top-level operation.
- **Opt-in:** explicit shared transaction scope for atomic multi-operation workflows.
- **Documentation:** clearly state which APIs isolate vs share transaction context.
