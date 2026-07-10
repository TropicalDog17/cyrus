---
name: typescript-best-practices
description: Apply strict, production-oriented TypeScript and TSX practices when creating, reviewing, refactoring, debugging, or scaffolding TypeScript; converting JavaScript to TypeScript; fixing type errors; designing public types or APIs; or configuring tsconfig. Covers shared language patterns, Node/backend code, and React/frontend code.
---

# TypeScript best practices

Produce precise, readable TypeScript that catches invalid states at compile time without fighting the repository's architecture.

## Resolve constraints first

Follow, in order: the user's explicit requirements, repository instructions and established conventions, then this skill. Inspect the relevant `tsconfig`, package manifest, nearby code, and existing validation, lint, and test tooling before changing code.

For greenfield code, enable `strict`, `noUncheckedIndexedAccess`, and `noImplicitOverride`. In an existing project, do not change compiler flags, add dependencies, or broaden a migration unless the task calls for it; improve safety within scope and identify remaining risks.

## Apply these defaults

- Avoid `any`. Represent untrusted or genuinely unknown values as `unknown`, then narrow them. When framework interop or an inaccurate third-party declaration makes an escape hatch unavoidable, keep it local and explain it.
- Model mutually exclusive states with discriminated unions instead of correlated optional fields or boolean flags. Use exhaustive checks where they protect evolving domain logic.
- Handle `null` and `undefined` explicitly. Prefer checks, early returns, optional chaining, and nullish coalescing over non-null assertions. Use `!` only when an invariant cannot be expressed and is locally evident.
- Prefer inference inside implementations. Type function parameters and public or exported boundaries; give exported functions explicit return types when that stabilizes the API or catches accidental widening.
- Treat external data as untrusted. Validate HTTP input, decoded JSON, environment variables, files, storage, and third-party responses at runtime. Reuse the project's validator. Add or recommend a library such as Zod only when dependency changes are in scope. Derive static types from schemas when supported.
- Make illegal states unrepresentable, but avoid type machinery more complex than the risk it removes. Prefer clear domain types, discriminated unions, `satisfies`, `as const`, type guards, and `readonly` where they improve correctness.
- Prefer `type` or `interface` according to local conventions and the required semantics; do not churn code solely to switch between them. Avoid numeric enums by default; preserve established or interoperability-required enums.
- Name values by meaning: predicate-style booleans, verb-led functions, PascalCase types and components, and camelCase values. Avoid unexplained abbreviations and Hungarian prefixes.
- Preserve useful errors and causal context. Do not catch errors merely to swallow them or cast them to `Error` without narrowing.

## Work from boundaries inward

1. Identify inputs, outputs, state transitions, failure modes, and trust boundaries.
2. Define non-obvious domain shapes before implementation.
3. Implement with inference carrying local details.
4. Narrow or validate every untrusted boundary.
5. Run the repository's focused typecheck, tests, and lint checks when available.

## Review proportionately

Prioritize defects over style: unsafe boundary data, broad `any`, invalid state models, unchecked absence, unsound assertions, and misleading public types. Avoid unrelated rewrites. Explain the concrete failure a recommendation prevents.

Before finishing, scan changed code for `any`, `!`, assertions, correlated optional fields, unvalidated input, swallowed errors, and changed exported signatures. Confirm every exception is narrow and justified.
