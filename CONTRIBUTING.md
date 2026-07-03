# Contributing to pr-slop-filter

Thanks for your interest in contributing! This document covers everything you need to get started.

---

## 🚀 Quick Setup

```bash
# Clone the repo
git clone https://github.com/noxlie/pr-slop-filter.git
cd pr-slop-filter

# Install dependencies
npm install

# Run the test suite
npm test

# Start development mode (watch mode)
npm run dev

# Run linter
npm run lint

# Run type checker
npm run typecheck
```

### Prerequisites

- **Node.js** ≥ 18.0.0
- **npm** ≥ 9.0.0
- **Git** ≥ 2.30

---

## 🧩 Adding New Detectors

Detectors are the core of pr-slop-filter. Each detector analyzes a specific aspect of a PR and returns a score.

### Step 1: Create the detector file

```typescript
// src/detectors/heuristics/my-detector.ts
import { Detector, DetectorResult } from '../../types.js';

export const myDetector: Detector = {
  name: 'my-detector',
  layer: 'heuristics',
  weight: 0.10,
  description: 'Detects specific pattern in PR content',

  async analyze(context): Promise<DetectorResult> {
    const { pr, diff, commits } = context;

    // Your detection logic here
    const score = calculateScore(pr, diff, commits);
    const flags = [];

    if (score > 50) {
      flags.push({
        type: 'my_pattern',
        severity: score > 80 ? 'error' : 'warning',
        detail: 'Description of what was detected',
      });
    }

    return { score, flags };
  },
};
```

### Step 2: Register the detector

Add your detector to the appropriate engine file:

```typescript
// src/engines/heuristics.ts
import { myDetector } from '../detectors/heuristics/my-detector.js';

const detectors = [
  perplexityDetector,
  aiPhraseDetector,
  emojiDensityDetector,
  commitPatternDetector,
  formattingAnomalyDetector,
  myDetector,  // ← Add here
];
```

### Step 3: Add tests

```typescript
// tests/detectors/heuristics/my-detector.test.ts
import { describe, it, expect } from 'vitest';
import { myDetector } from '../../../src/detectors/heuristics/my-detector.js';

describe('myDetector', () => {
  it('should flag high scores for matching patterns', async () => {
    const context = createMockContext({ /* test data */ });
    const result = await myDetector.analyze(context);
    expect(result.score).toBeGreaterThan(50);
    expect(result.flags).toHaveLength(1);
  });

  it('should return low scores for clean PRs', async () => {
    const context = createMockContext({ /* clean data */ });
    const result = await myDetector.analyze(context);
    expect(result.score).toBeLessThan(20);
    expect(result.flags).toHaveLength(0);
  });
});
```

### Step 4: Update documentation

Add your detector to the **Detection Breakdown** table in [README.md](README.md).

---

## 📝 Commit Conventions

We use [Conventional Commits](https://www.conventionalcommits.org/). All commits must follow this format:

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Formatting, missing semicolons, etc. |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `test` | Adding missing tests |
| `chore` | Build process or auxiliary tool changes |
| `ci` | CI configuration changes |

### Examples

```
feat(detectors): add emoji density heuristic
fix(diff-analysis): handle empty diff edge case
docs(readme): update detection breakdown table
test(heuristics): add perplexity analysis edge cases
chore(deps): bump vitest to 1.2.0
```

---

## 🔀 Pull Request Guidelines

### Before Submitting

1. **Run all checks locally:**
   ```bash
   npm run lint
   npm run typecheck
   npm test
   ```

2. **Update documentation** if you changed behavior or added features.

3. **Add tests** for new functionality. Aim for >80% coverage.

4. **Keep PRs focused.** One feature or fix per PR. If you're doing multiple things, split them.

### PR Description

Use this template:

```markdown
## What

Brief description of what this PR does.

## Why

Why this change is needed.

## How

Implementation details, if non-obvious.

## Testing

How you tested this change.

## Checklist

- [ ] Tests pass (`npm test`)
- [ ] Lint passes (`npm run lint`)
- [ ] TypeScript compiles (`npm run typecheck`)
- [ ] Documentation updated
- [ ] Conventional commit messages
```

### Review Process

1. **Automated checks** must pass (CI, lint, typecheck, tests).
2. **At least one approval** from a maintainer.
3. **No merge conflicts** with main.
4. **Squash merge** is preferred for clean history.

---

## 🐛 Reporting Issues

### Bug Reports

Include:
- **Version** of pr-slop-filter
- **Node.js** version
- **Operating system**
- **Steps to reproduce**
- **Expected behavior**
- **Actual behavior**
- **Error output** (if any)

### Feature Requests

Include:
- **Use case** — what problem does this solve?
- **Proposed solution** — how should it work?
- **Alternatives considered** — what else did you think about?

---

## 🏗️ Development Architecture

```
src/
├── cli/                  # CLI entry points
│   ├── check.ts          # `pr-slop-filter check`
│   ├── scan.ts           # `pr-slop-filter scan`
│   └── preflight.ts      # `pr-slop-filter preflight`
├── engines/              # Detection engines
│   ├── heuristics.ts     # Layer 1: Fast pattern matching
│   ├── diff-analysis.ts  # Layer 2: Diff analysis
│   └── llm-verify.ts     # Layer 3: LLM verification
├── detectors/            # Individual detectors
│   ├── heuristics/       # Heuristic detectors
│   ├── diff-analysis/    # Diff analysis detectors
│   └── llm-verify/       # LLM verification detectors
├── github/               # GitHub Action integration
│   └── action.ts         # Action entry point
├── output/               # Output formatters
│   ├── text.ts           # Pretty terminal output
│   ├── json.ts           # JSON output
│   └── annotation.ts     # GitHub annotation output
├── types.ts              # TypeScript type definitions
└── utils/                # Shared utilities
```

---

## 📜 License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

---

**Thank you for helping stop AI slop PRs!** 🚫🤖
