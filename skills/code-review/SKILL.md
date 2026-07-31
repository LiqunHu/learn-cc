---
name: code-review
description: Perform thorough code reviews with security, performance, and maintainability analysis. Use when user asks to review code, check for bugs, or audit a codebase.
---

# Code Review Skill

You now have expertise in conducting comprehensive code reviews. Follow this structured approach:

## Review Checklist

### 1. Security (Critical)

Check for:
- [ ] **Injection vulnerabilities**: SQL, command, XSS, template injection
- [ ] **Authentication issues**: Hardcoded credentials, weak auth
- [ ] **Authorization flaws**: Missing access controls, IDOR
- [ ] **Data exposure**: Sensitive data in logs, error messages
- [ ] **Cryptography**: Weak algorithms, improper key management
- [ ] **Dependencies**: Known vulnerabilities (check with `npm audit`)

```bash
# Quick security scans
npm audit
grep -rn "password\|secret\|api_key\|token" . --include="*.js" --include="*.mjs" --include="*.ts" --include="*.tsx"
```

### 2. Correctness

Check for:
- [ ] **Logic errors**: Off-by-one, null handling, edge cases
- [ ] **Race conditions**: Concurrent access without synchronization
- [ ] **Resource leaks**: Unclosed files, connections, streams
- [ ] **Error handling**: Swallowed exceptions, missing error paths
- [ ] **Type safety**: Implicit conversions, excessive `any`

### 3. Performance

Check for:
- [ ] **N+1 queries**: Database calls in loops
- [ ] **Memory issues**: Large allocations, retained references
- [ ] **Blocking operations**: Sync I/O in async hot paths
- [ ] **Inefficient algorithms**: O(n^2) when O(n) possible
- [ ] **Missing caching**: Repeated expensive computations

### 4. Maintainability

Check for:
- [ ] **Naming**: Clear, consistent, descriptive
- [ ] **Complexity**: Functions > 50 lines, deep nesting > 3 levels
- [ ] **Duplication**: Copy-pasted code blocks
- [ ] **Dead code**: Unused imports, unreachable branches
- [ ] **Comments**: Outdated, redundant, or missing where needed

### 5. Testing

Check for:
- [ ] **Coverage**: Critical paths tested
- [ ] **Edge cases**: Null, empty, boundary values
- [ ] **Mocking**: External dependencies isolated
- [ ] **Assertions**: Meaningful, specific checks

## Review Output Format

```markdown
## Code Review: [file/component name]

### Summary
[1-2 sentence overview]

### Critical Issues
1. **[Issue]** (line X): [Description]
   - Impact: [What could go wrong]
   - Fix: [Suggested solution]

### Improvements
1. **[Suggestion]** (line X): [Description]

### Positive Notes
- [What was done well]

### Verdict
[ ] Ready to merge
[ ] Needs minor changes
[ ] Needs major revision
```

## Common Patterns to Flag

### JavaScript / TypeScript / Node.js
```javascript
// Bad: Prototype pollution
Object.assign(target, userInput)
// Good:
Object.assign(target, sanitize(userInput))

// Bad: eval / Function with user input
eval(userCode)
new Function(userCode)()
// Good: Never evaluate untrusted input

// Bad: Command injection
exec(`ls ${userInput}`)
// Good:
execFile('ls', [userInput])

// Bad: Path traversal
fs.readFileSync(req.query.path)
// Good: resolve + ensure path stays under workspace root

// Bad: Callback hell
getData(x => process(x, y => save(y, z => done(z))))
// Good:
const data = await getData()
const processed = await process(data)
await save(processed)

// Bad: Floating promise / missing await
doAsyncWork()
// Good:
await doAsyncWork()
```

## Review Commands

```bash
# Show recent changes
git diff HEAD~5 --stat
git log --oneline -10

# Find potential issues
grep -rn "TODO\|FIXME\|HACK\|XXX" .
grep -rn "password\|secret\|token" . --include="*.js" --include="*.mjs" --include="*.ts"

# Check complexity
npx eslint . --rule 'complexity: [warn, 10]'

# Check dependencies
npm outdated
npm audit
```

## Review Workflow

1. **Understand context**: Read PR description, linked issues
2. **Run the code**: Build, test, run locally if possible
3. **Read top-down**: Start with main entry points
4. **Check tests**: Are changes tested? Do tests pass?
5. **Security scan**: Run automated tools
6. **Manual review**: Use checklist above
7. **Write feedback**: Be specific, suggest fixes, be kind
