# Ruby Standards

These rules apply when writing Ruby code. They supplement the universal rules in code-standards.md.

## 1. Sorbet or RBS for Type Checking

Types are not optional in production Ruby. Use Sorbet (`sig` annotations) or RBS type signatures. Every public method has a type signature.

```ruby
# BAD: no type information

def find_user(id)
  User.find(id)
end

# GOOD: Sorbet

sig { params(id: String).returns(T.nilable(User)) }
def find_user(id)
  User.find_by(id: id)
end
```

## 2. Avoid `method_missing`

`method_missing` makes code untraceable and breaks tooling. Use `define_method` or delegation instead.

```ruby
# BAD

def method_missing(name, *args)
  name.to_s.start_with?("find_by_") ? where(name.to_s.sub("find_by_", "") => args.first).first : super
end

# GOOD

%w[name email role].each do |field|
  define_method("find_by_#{field}") { |value| where(field => value).first }
end
```

## 3. `public_send` Over `send`

Use `public_send` instead of `send` to respect access control. `send` bypasses private/protected visibility and introduces security and encapsulation risks.

```ruby
# BAD: bypasses access control

user.send(:reset_password_token)

# GOOD: respects visibility

user.public_send(:email)
```

## 4. Service Objects Over Callbacks

Extract business logic from ActiveRecord callbacks into service objects. Callbacks make flow invisible, create coupling, and are hard to test in isolation.

```ruby
# BAD: business logic buried in callbacks

class User < ApplicationRecord
  after_create :send_welcome_email
  after_create :provision_account
end

# GOOD: explicit service object, testable in isolation

class CreateUser
  def call(params)
    user = User.create!(params)
    UserMailer.welcome(user).deliver_later
    AccountProvisioner.new.setup(user)
    user
  end
end
```

## 5. Freeze String Literals

Add `# frozen_string_literal: true` to every Ruby file. Prevents accidental mutation and improves performance.

```ruby
# frozen_string_literal: true

name = "alice"
full_name = "#{name} smith"  # new string, original unchanged
```
