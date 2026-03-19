# Python Standards

These rules apply when writing Python code. They supplement the universal rules in code-standards.md.

## 1. `mypy --strict` from Day One

Every function gets full type annotations -- parameters and return types. Configure `mypy --strict` or `pyright` at project start. `Any` is forbidden unless interfacing with an untyped third-party library (requires inline comment).

```python
# BAD
def get_user(user_id):
    return db.find(user_id)

# GOOD
def get_user(user_id: str) -> User | None:
    return db.find(user_id)
```

## 2. Explicit `None` Handling

Use `T | None` for nullable types. Never rely on implicit `None` returns. Always check for `None` before using a nullable value.

```python
# BAD: implicit None return, caller has no idea
def find_user(name: str):
    for u in users:
        if u.name == name: return u

# GOOD: explicit return type, explicit None check
def find_user(name: str) -> User | None:
    for u in users:
        if u.name == name: return u
    return None
```

## 3. Custom Exception Hierarchy

All project exceptions inherit from a project-level base exception. No bare `except Exception` without re-raising.

```python
# BAD
raise Exception("user not found")

# GOOD
class AppError(Exception): ...
class UserNotFoundError(AppError): ...
raise UserNotFoundError(f"User {user_id} not found")
```

## 4. Async Discipline

One async framework per project (`asyncio` default). Every `async def` must contain at least one `await` -- otherwise make it a regular function. Wrap blocking calls with `asyncio.to_thread()`.

```python
# BAD
async def get_name() -> str: return "alice"  # no await, should not be async

# GOOD
def get_name() -> str: return "alice"
async def read_file(path: str) -> str: return await asyncio.to_thread(Path(path).read_text)
```

## 5. Pydantic for Runtime Validation at Boundaries

Use Pydantic models to validate all external input (API requests, config files, environment variables, external API responses). Internal function-to-function calls use plain types.

```python
# BAD: trusting raw dict
def handle_request(data: dict) -> None:
    name = data["name"]  # KeyError if missing, no type check

# GOOD: Pydantic at boundary
class CreateUserRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    email: EmailStr

def handle_request(data: dict) -> None:
    req = CreateUserRequest.model_validate(data)  # raises ValidationError
```
