# Swift Standards

These rules apply when writing Swift code. They supplement the universal rules in code-standards.md.

## 1. Trust the Concurrency Checker

Never use `@unchecked Sendable`, `nonisolated(unsafe)`, or `@preconcurrency` to silence warnings. Fix the underlying issue.

```swift
// BAD
class Cache: @unchecked Sendable { var items: [String: Data] = [:] }

// GOOD
actor Cache {
    private var items: [String: Data] = [:]
    func get(_ key: String) -> Data? { items[key] }
    func set(_ key: String, value: Data) { items[key] = value }
}
```

## 2. Actors Over Locks

Use actors for shared mutable state instead of manual locks or dispatch queues.

```swift
// BAD
class Counter { private var lock = NSLock(); func increment() { lock.lock(); count += 1; lock.unlock() } }

// GOOD
actor Counter { private var count = 0; func increment() { count += 1 } }
```

## 3. `guard let` for Early Returns

Unwrap optionals at function entry using `guard let`. Keeps the happy path unindented.

```swift
// BAD
func process(data: Data?) {
    if let data = data {
        if let decoded = try? JSONDecoder().decode(User.self, from: data) { save(decoded) }
    }
}

// GOOD
func process(data: Data?) throws {
    guard let data else { return }
    save(try JSONDecoder().decode(User.self, from: data))
}
```

## 4. Value Types by Default

Use `struct` unless reference semantics are required. Document why when choosing `class`.

```swift
// BAD
class UserProfile { var name: String; var email: String }

// GOOD
struct UserProfile { var name: String; var email: String }
```

## 5. No Force Unwrapping (`!`)

Never use `!` to force-unwrap. Use `if let`, `guard let`, `??`, or `Optional.map`.

```swift
// BAD
let port = Int(portString)!

// GOOD
guard let port = Int(portString) else { throw ConfigError.invalidPort(portString) }
let user = users.first ?? User.anonymous
```
