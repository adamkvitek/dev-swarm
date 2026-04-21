# C# Standards

These rules apply when writing C# code. They supplement the universal rules in code-standards.md.

## 1. Enable Nullable Reference Types

Set `<Nullable>enable</Nullable>` in the project file. Never use `!` (null-forgiving operator) without an inline comment explaining why. Treat every compiler nullable warning as an error.

```csharp
// BAD: suppressing without reason
var user = GetUser(id)!;

// GOOD: explicit null handling
var user = GetUser(id) ?? throw new UserNotFoundException(id);

// GOOD: when suppression is justified
var user = GetUser(id)!; // validated non-null by middleware before this point
```

## 2. Async All the Way

Never call `.Result` or `.Wait()` on a Task -- it causes deadlocks. Async methods return `Task` or `Task<T>`, never `void` (except event handlers). Never return `null` from an async method.

```csharp
// BAD: blocking on async
var user = GetUserAsync(id).Result;

// BAD: async void
async void HandleClick() { await SaveAsync(); }

// GOOD
async Task<User> GetUserAsync(string id, CancellationToken ct)
{
    var user = await _repo.FindAsync(id, ct);
    return user ?? throw new UserNotFoundException(id);
}
```

## 3. Disposable Discipline

Every `IDisposable` is wrapped in a `using` statement or `using` declaration. No exceptions. If a class owns disposable resources, it implements `IDisposable` itself.

```csharp
// BAD: resource leak
var client = new HttpClient();
var response = client.GetAsync(url).Result;

// GOOD
using var client = new HttpClient();
using var response = await client.GetAsync(url, ct);
```

## 4. Record Types for Data

DTOs and value objects use `record` (or `record struct` for small value types). Records provide value equality, immutability, and `with` expressions.

```csharp
// BAD
public class UserDto { public string Name { get; set; } public string Email { get; set; } }

// GOOD
public record UserDto(string Name, string Email);
var updated = original with { Email = "new@example.com" };
```

## 5. Sealed by Default

Classes are `sealed` unless explicitly designed for inheritance. Unsealed classes require a documented reason.

```csharp
// BAD
public class UserService { ... }

// GOOD
public sealed class UserService { ... }
public abstract class NotificationHandler { ... } // base for email, SMS, push -- documented
```
