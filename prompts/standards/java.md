# Java Standards

These rules apply when writing Java code. They supplement the universal rules in code-standards.md.

## 1. Never Swallow Exceptions

Every catch block must log, wrap and rethrow, or rethrow as-is. Empty catch blocks are forbidden. Use try-with-resources for every `AutoCloseable`.

```java
// BAD: swallowed exception
try { processFile(path); } catch (IOException e) { /* silently ignored */ }

// GOOD: try-with-resources, exception wrapped and rethrown
try (var is = new FileInputStream(path)) {
    process(is);
} catch (IOException e) {
    throw new ProcessingException("Failed to process " + path, e);
}
```

## 2. Null Safety with `Optional<T>` and Annotations

Methods that may return no result return `Optional<T>`, never `null`. Use `@Nullable`/`@NonNull` on parameters. Never call `.get()` without `.isPresent()` -- use `.orElseThrow()`, `.map()`, or `.ifPresent()`.

```java
// BAD
public User findUser(String id) { return userMap.get(id); }

// GOOD
public Optional<User> findUser(String id) {
    return Optional.ofNullable(userMap.get(id));
}
User user = findUser(id).orElseThrow(() -> new UserNotFoundException(id));
```

## 3. Immutable by Default

Classes are `final` unless designed for inheritance. Fields are `final`. Collections are unmodifiable. Use `List.of()`, `Map.of()`, `Set.of()` or `Collections.unmodifiable*`.

```java
// BAD
public class Config { public String host; public List<String> origins; }

// GOOD: final class, final fields, defensive copy
public final class Config {
    private final String host;
    private final List<String> origins;
    public Config(String host, List<String> origins) {
        this.host = host;
        this.origins = List.copyOf(origins);
    }
}
```

## 4. No Raw Types

Always parameterize generic types. `List`, `Map`, `Set` without type parameters are forbidden.

```java
// BAD
List users = getUsers();
Map config = loadConfig();

// GOOD
List<User> users = getUsers();
Map<String, String> config = loadConfig();
```

## 5. Validate at Boundaries

All external input is validated before entering business logic. Use Bean Validation annotations.

```java
// BAD
public void createUser(String name, String email) { userRepo.save(new User(name, email)); }

// GOOD
public record CreateUserRequest(@NotBlank @Size(max = 100) String name, @NotBlank @Email String email) {}
public void createUser(@Valid CreateUserRequest req) { userRepo.save(new User(req.name(), req.email())); }
```
