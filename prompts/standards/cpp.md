# C++ Standards

These rules apply when writing C++ code. Use modern C++ (17+) features to prevent the memory safety issues that plague C-style code.

## 1. Smart Pointers Over Raw Pointers

Never use `new`/`delete` directly. Use `std::unique_ptr` for single ownership, `std::shared_ptr` for shared ownership. Raw pointers are for non-owning references only.

```cpp
// BAD — manual memory management
Widget* w = new Widget();
// ... who deletes this?

// GOOD — automatic cleanup, no leaks
auto w = std::make_unique<Widget>();
```

If you must use raw pointers (interfacing with C APIs), wrap them in a smart pointer or RAII wrapper immediately.

## 2. RAII For All Resources

Every resource (memory, files, locks, sockets, handles) must be managed by an RAII object. Constructors acquire, destructors release. No manual cleanup in `finally`-style blocks.

```cpp
// BAD — leak if exception thrown between open and close
FILE* f = fopen("data.txt", "r");
process(f);
fclose(f);

// GOOD — automatic cleanup on scope exit
std::ifstream f("data.txt");
process(f);
// f closed automatically
```

## 3. Avoid Undefined Behavior

UB is not "probably works" — it is a compiler license to break your code in unpredictable ways.

- No signed integer overflow (use unsigned or check before arithmetic)
- No out-of-bounds access (use `.at()` instead of `[]` in debug, bounds-check in release)
- No null pointer dereference (check before use)
- No data races (use mutexes, atomics, or message passing)

Use `-fsanitize=address,undefined` during development to catch UB at runtime.

## 4. Prefer `std::string`, `std::vector`, `std::span` Over Raw Arrays

Raw C arrays and pointer arithmetic are the #1 source of buffer overflows. Standard containers handle memory and bounds.

```cpp
// BAD — raw array, no bounds checking, manual size tracking
void process(const char* data, size_t len);

// GOOD — bounds-safe, size tracked automatically
void process(std::span<const char> data);
void process(const std::string& data);
```

Use `std::array` for fixed-size arrays. Use `std::string_view` for read-only string parameters.

## 5. Mark Single-Argument Constructors `explicit`

Implicit conversions via constructors cause subtle, hard-to-debug type coercion bugs.

```cpp
// BAD — allows implicit conversion: Widget w = 42;
class Widget {
    Widget(int size);
};

// GOOD — requires explicit construction: Widget w(42);
class Widget {
    explicit Widget(int size);
};
```
