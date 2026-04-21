# Rust Standards

These rules apply when writing Rust code. They supplement the universal rules in code-standards.md.

## 1. No `unwrap()` in Production Code

Use `?` for propagation, `unwrap_or`/`unwrap_or_else` for defaults, or explicit `match` for error handling. `unwrap()` and `expect()` are only acceptable in tests and examples.

```rust
// BAD
let user = get_user(id).unwrap();
let port: u16 = env::var("PORT").unwrap().parse().unwrap();

// GOOD
let user = get_user(id)?;
let port: u16 = env::var("PORT")
    .unwrap_or_else(|_| "8080".to_string())
    .parse()
    .map_err(|e| AppError::Config(format!("invalid PORT: {e}")))?;
```

## 2. Minimize `clone()`

Every `clone()` should be justified. Prefer borrowing. If you need owned data, document why.

```rust
// BAD
fn greet(name: String) -> String { format!("Hello, {}", name) }
greet(name.clone()); // clone just to keep using name

// GOOD
fn greet(name: &str) -> String { format!("Hello, {}", name) }
greet(&name);
```

## 3. Zero `unsafe` Without Safety Comments

Every `unsafe` block requires a `// SAFETY:` comment explaining what invariants the caller guarantees and why they hold. No exceptions.

```rust
// BAD
unsafe { std::ptr::read(ptr) }

// GOOD
// SAFETY: ptr is guaranteed non-null and aligned by the allocator in new(),
// and the lifetime is bounded by the enclosing struct's Drop impl.
unsafe { std::ptr::read(ptr) }
```

## 4. Prefer `&str` Over `String` in Function Parameters

Functions that only read string data should accept `&str`, not `String`. Use `impl AsRef<str>` when you want to accept both.

```rust
// BAD: forces caller to allocate
fn find_user(name: String) -> Option<&User> { ... }

// GOOD: borrows, no allocation required
fn find_user(name: &str) -> Option<&User> { ... }
```

## 5. Exhaustive Pattern Matching -- No Wildcard on Enums

When matching on enums you control, list every variant explicitly. Never use `_` as a catch-all -- this hides new variants added later and causes silent bugs.

```rust
// BAD: new variants silently fall into catch-all
match status {
    Status::Active => handle_active(),
    _ => handle_other(),
}

// GOOD: compiler errors when a new variant is added
match status {
    Status::Active => handle_active(),
    Status::Inactive => handle_inactive(),
    Status::Pending => handle_pending(),
}
```
