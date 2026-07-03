import { describe, it, expect } from 'vitest';
import { analyzeDiff } from '../src/diff-analyzer/index.js';
import type { PRContext } from '../src/types.js';

function makePR(overrides: Partial<PRContext> = {}): PRContext {
  return {
    owner: 'test',
    repo: 'test-repo',
    pr_number: 1,
    title: 'Fix bug in parser',
    body: 'This fixes a parsing issue.',
    author: 'human-dev',
    commits: [],
    files_changed: [
      {
        filename: 'src/parser.ts',
        status: 'modified',
        additions: 10,
        deletions: 3,
        patch: '+  if (!input) return null;\n-  return input.split(",");\n+  return input ? input.split(",") : [];',
      },
    ],
    base_branch: 'main',
    head_branch: 'fix/parser',
    ...overrides,
  };
}

describe('analyzeDiff', () => {
  it('returns a valid ModuleResult', () => {
    const result = analyzeDiff(makePR());
    expect(result).toHaveProperty('module', 'diff-analysis');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('findings');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('flags missing tests for bug fix PRs', () => {
    const pr = makePR({
      title: 'fix: critical parser bug',
      body: 'This fixes a critical bug in the parser module.',
      files_changed: [
        { filename: 'src/parser.ts', status: 'modified', additions: 10, deletions: 3, patch: '+fix\n-old' },
      ],
    });
    const result = analyzeDiff(pr);
    const testFinding = result.findings.find((f) => f.id === 'missing-tests');
    expect(testFinding).toBeDefined();
    expect(testFinding!.score).toBe(70);
  });

  it('detects high comment-to-code ratio', () => {
    const pr = makePR({
      files_changed: [
        {
          filename: 'src/foo.ts',
          status: 'modified',
          additions: 20,
          deletions: 0,
          patch: '+// This is a comment\n+// Another comment\n+// Yet another\n+// More comments\n+// Even more\n+const x = 1;',
        },
      ],
    });
    const result = analyzeDiff(pr);
    const commentFinding = result.findings.find((f) => f.id === 'comment-ratio');
    expect(commentFinding).toBeDefined();
    expect(commentFinding!.score).toBeGreaterThanOrEqual(50);
  });

  it('detects massive diffs', () => {
    const bigPatch = Array(600).fill('+const x = 1;').join('\n');
    const pr = makePR({
      files_changed: [
        { filename: 'src/huge.ts', status: 'modified', additions: 600, deletions: 0, patch: bigPatch },
      ],
    });
    const result = analyzeDiff(pr);
    const sizeFinding = result.findings.find((f) => f.id === 'diff-size');
    expect(sizeFinding).toBeDefined();
    expect(sizeFinding!.score).toBeGreaterThanOrEqual(60);
  });

  it('gives low score for normal human PRs', () => {
    const pr = makePR({
      title: 'fix parser crash',
      body: 'Parser was crashing on empty input.',
      files_changed: [
        { filename: 'src/parser.ts', status: 'modified', additions: 5, deletions: 2, patch: '+if (!input) return [];\n-return null;' },
        { filename: 'tests/parser.test.ts', status: 'modified', additions: 3, deletions: 0, patch: '+test("empty input", () => { expect(parse("")).toEqual([]); })' },
      ],
    });
    const result = analyzeDiff(pr);
    expect(result.score).toBeLessThan(40);
  });
});
