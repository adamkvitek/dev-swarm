# C Standards

These rules apply when writing C code. Memory safety is YOUR responsibility — there is no runtime to catch mistakes.

## 1. Bounds-Check Every Array Access

Buffer overflows are the #1 security vulnerability in C code. Never access an array without checking the index.

```c
// BAD — buffer overflow if len > sizeof(buf)
void copy(char *buf, const char *src, size_t len) {
    memcpy(buf, src, len);
}

// GOOD — bounds-checked
void copy(char *buf, size_t buf_size, const char *src, size_t len) {
    if (len > buf_size) len = buf_size;
    memcpy(buf, src, len);
}
```

Use `snprintf` instead of `sprintf`. Use `strncpy` instead of `strcpy`. Use `strncat` instead of `strcat`. Always pass buffer sizes.

## 2. Every `malloc` Has a Paired `free` — No Exceptions

For every allocation, document where and how it is freed. Use a consistent ownership pattern: the function that allocates is responsible for freeing, OR ownership is explicitly transferred (documented in the function contract).

```c
// BAD — who frees this?
char *get_name() { return malloc(256); }

// GOOD — caller owns the returned memory (documented)
// Returns: heap-allocated string. Caller must free().
char *get_name(void) {
    char *name = malloc(256);
    if (!name) return NULL;
    snprintf(name, 256, "default");
    return name;
}
```

Check every `malloc`/`calloc`/`realloc` return for NULL.

## 3. Initialize All Variables

Uninitialized variables are undefined behavior. Initialize every variable at declaration.

```c
// BAD — uninitialized, value is garbage
int count;
char *ptr;

// GOOD
int count = 0;
char *ptr = NULL;
```

Use `memset` or `= {0}` for structs and arrays.

## 4. No Use-After-Free or Double-Free

Set pointers to NULL after freeing. Check for NULL before use. Never free the same pointer twice.

```c
// BAD — use after free
free(data);
process(data);

// GOOD
free(data);
data = NULL;
```

## 5. Use `const` Everywhere Possible

Mark parameters and variables `const` when they should not be modified. This prevents accidental mutation and communicates intent.

```c
// BAD — could accidentally modify input
int count_chars(char *str, char c);

// GOOD — input is read-only
int count_chars(const char *str, char c);
```
