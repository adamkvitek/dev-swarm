# Go Standards

These rules apply when writing Go code. They supplement the universal rules in code-standards.md.

## 1. Check Every Error

Never assign an error to `_`. Always wrap with context using `fmt.Errorf("context: %w", err)`.

```go
// BAD
result, _ := doSomething()

// GOOD
result, err := doSomething()
if err != nil { return fmt.Errorf("doing something for user %s: %w", userID, err) }
```

## 2. Accept Interfaces, Return Structs

Function parameters accept interfaces. Return types are concrete structs. Define interfaces in the consumer package.

```go
// BAD
func NewService(repo *PostgresRepo) UserFinder { ... }

// GOOD
func NewService(repo UserReader) *Service { ... }
```

## 3. Goroutine Lifecycle Management

Every goroutine must have a termination plan. Use `context.Context` for cancellation. Never launch a goroutine without a way to stop it. Leaked goroutines are memory leaks.

```go
// BAD: no way to stop this goroutine
go func() { for { process(); time.Sleep(time.Second) } }()

// GOOD: respects context cancellation
go func(ctx context.Context) {
    ticker := time.NewTicker(time.Second)
    defer ticker.Stop()
    for {
        select {
        case <-ctx.Done(): return
        case <-ticker.C: process(ctx)
        }
    }
}(ctx)
```

## 4. Context Propagation

`context.Context` is the first parameter through the entire call stack. Never store it in a struct.

```go
// BAD
func (s *Service) GetUser(id string) (*User, error) { return s.repo.Find(context.Background(), id) }

// GOOD
func (s *Service) GetUser(ctx context.Context, id string) (*User, error) { return s.repo.Find(ctx, id) }
```

## 5. No `panic` in Library Code

Library and application code must return errors. Only `main()` or top-level initialization may panic.

```go
// BAD
func MustParseConfig(path string) Config {
    if err != nil { panic(err) }
}

// GOOD
func ParseConfig(path string) (Config, error) {
    if err != nil { return Config{}, fmt.Errorf("reading config %s: %w", path, err) }
}
```
