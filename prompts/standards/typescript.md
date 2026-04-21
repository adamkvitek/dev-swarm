# TypeScript Standards

These rules apply when writing TypeScript code. They supplement the universal rules in code-standards.md.

## 1. Strict Compiler Settings Are Non-Negotiable

`tsconfig.json` must have `strict: true` and `noUncheckedIndexedAccess: true`. Never weaken these settings.

## 2. Discriminated Unions with Exhaustive Switches

Model variant types as discriminated unions. Every switch must be exhaustive using a `never` check in the default case.

```typescript
// BAD: string union with no exhaustiveness check
function handle(status: string) {
  if (status === "ok") { /* ... */ }
}

// GOOD: discriminated union with exhaustive switch
type Result = { kind: "ok"; value: string } | { kind: "error"; message: string };

function handle(result: Result): string {
  switch (result.kind) {
    case "ok": return result.value;
    case "error": return result.message;
    default: {
      const _exhaustive: never = result;
      throw new Error(`Unhandled case: ${_exhaustive}`);
    }
  }
}
```

## 3. Ban `any` -- Use `unknown` and Narrow

Never use `any`. Use `unknown` and narrow with type guards. Every `as` assertion requires an inline comment explaining why the type system cannot infer this.

```typescript
// BAD
function parse(input: any) { return input.name; }

// GOOD
function parse(input: unknown): string {
  if (typeof input === "object" && input !== null && "name" in input) {
    return (input as { name: string }).name; // narrowed via 'in' check above
  }
  throw new Error("Invalid input");
}
```

## 4. Separate Data Fetching from Rendering

Components never make network calls directly. The layering is: components call hooks, hooks call services, services call the network. Nothing skips a layer.

```typescript
// BAD: fetch inside component
function UserCard({ id }: { id: string }) {
  const [user, setUser] = useState(null);
  useEffect(() => { fetch(`/api/users/${id}`).then(/* ... */) }, [id]);
}

// GOOD: layered separation
// services/userService.ts — API calls only
// hooks/useUser.ts — wraps service + React Query
// components/UserCard.tsx — calls useUser(), renders state
```

## 5. Handle All Promise Rejections -- No Floating Promises

Every Promise must be awaited, returned, or handled with `.catch()`. Enable `@typescript-eslint/no-floating-promises`.

```typescript
// BAD
save(); // floating promise, rejection silently lost

// GOOD
await save();
save().catch((err) => logger.error("Save failed", err));
```
