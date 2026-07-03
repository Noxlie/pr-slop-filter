import { describe, it, expect } from 'vitest';
import { analyzeHeuristics } from '../src/heuristics/index.js';
import type { PRContext } from '../src/types.js';

function makePR(overrides: Partial<PRContext> = {}): PRContext {
  return {
    owner: 'test',
    repo: 'test-repo',
    pr_number: 1,
    title: 'Fix bug in parser',
    body: 'This fixes a parsing issue in the main module.',
    author: 'human-dev',
    commits: [
      {
        sha: 'abc123',
        message: 'fix: resolve parser crash on empty input',
        author: 'human-dev',
        date: '2026-01-01T00:00:00Z',
      },
    ],
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

describe('analyzeHeuristics', () => {
  it('returns a valid ModuleResult', () => {
    const result = analyzeHeuristics(makePR());
    expect(result).toHaveProperty('module', 'heuristics');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('findings');
    expect(result).toHaveProperty('duration_ms');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it('detects AI phrases in PR body', () => {
    const pr = makePR({
      body: 'This PR aims to address the comprehensive overview of the following changes were made to fix the issue.',
    });
    const result = analyzeHeuristics(pr);
    const phraseFinding = result.findings.find((f) => f.id === 'heuristics:ai-phrases');
    expect(phraseFinding).toBeDefined();
    expect(phraseFinding!.score).toBeGreaterThan(30);
  });

  it('detects emoji density', () => {
    const pr = makePR({
      title: 'Fix parser 🚀✨💡🎯🔥',
      body: 'Amazing fix 🎉🚀✨💡🎯🔥🔥',
    });
    const result = analyzeHeuristics(pr);
    const emojiFinding = result.findings.find((f) => f.id === 'heuristics:emoji-density');
    expect(emojiFinding).toBeDefined();
    expect(emojiFinding!.score).toBeGreaterThan(50);
  });

  it('gives low score for normal human PRs', () => {
    const pr = makePR({
      title: 'fix parser crash',
      body: 'Parser was crashing on empty input, now it returns an empty array.',
      commits: [
        {
          sha: 'abc',
          message: 'fix parser crash on empty input',
          author: 'dev',
          date: '2026-01-01',
        },
      ],
    });
    const result = analyzeHeuristics(pr);
    expect(result.score).toBeLessThan(40);
  });
});
