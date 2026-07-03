/**
 * Diff Analysis Engine — Detects AI-generated slop by analyzing code changes
 *
 * Analyzes the actual diff content against PR claims to find inconsistencies
 * that indicate AI-generated contributions.
 *
 * @module diff-analyzer
 */

import type { PRContext, ModuleResult, Finding, FileChange } from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const COMMENT_PATTERNS: Record<string, RegExp> = {
  singleLine: /^\s*(\/\/|#|;|\*|<!--)\s/m,
  blockStart: /^\s*(\/\*|""")/m,
  blockEnd: /^\s*(\*\/|""")/m,
  htmlComment: /<!--[\s\S]*?-->/g,
};

const CLAIM_KEYWORDS = {
  fix: /\b(fix|fixes|fixed|bug|bugfix|patch|resolve|resolves|resolved|issue)\b/i,
  feature: /\b(feat|feature|add|adds|added|implement|implements|new)\b/i,
  refactor: /\b(refactor|refactors|refactored|clean\s*up|reorganize|restructure)\b/i,
  docs: /\b(doc|docs|documentation|readme|comment|comments)\b/i,
  test: /\b(test|tests|testing|spec|specs|coverage)\b/i,
  style: /\b(style|format|formatting|lint|prettier|whitespace)\b/i,
  perf: /\b(perf|performance|optimi[sz]|speed|fast|slow|cache)\b/i,
};

const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/i,
  /\.spec\.[jt]sx?$/i,
  /__tests__\//i,
  /\/tests?\//i,
  /\/spec\//i,
  /\.test\.py$/i,
  /\.spec\.py$/i,
  /test_[^.]+\.py$/i,
  /_test\.go$/i,
  /_test\.rs$/i,
];

const WHITESPACE_ONLY_CHANGE = /^[\s\n\r]*$/;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Count lines in a patch that are actual code (not comments, not blank)
 */
function countCodeLines(patch: string): { code: number; comments: number; blank: number } {
  let code = 0;
  let comments = 0;
  let blank = 0;

  for (const line of patch.split('\n')) {
    // Only count added/modified lines (lines starting with +)
    if (!line.startsWith('+')) continue;
    const content = line.slice(1);

    if (content.trim() === '') {
      blank++;
    } else if (isCommentLine(content)) {
      comments++;
    } else {
      code++;
    }
  }

  return { code, comments, blank };
}

/**
 * Heuristic: is this line a comment in any common language?
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith('//')) return true;
  if (trimmed.startsWith('#') && !trimmed.startsWith('#!')) return true;
  if (trimmed.startsWith('*')) return true;
  if (trimmed.startsWith('/*')) return true;
  if (trimmed.startsWith('<!--')) return true;
  if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) return true;
  if (trimmed.startsWith(';;')) return true;
  return false;
}

/**
 * Extract unique directory paths from file changes
 */
function extractDirectories(files: FileChange[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.filename.split('/');
    if (parts.length > 1) {
      dirs.add(parts.slice(0, -1).join('/'));
    }
  }
  return [...dirs];
}

/**
 * Check if a filename matches test file patterns
 */
function isTestFile(filename: string): boolean {
  return TEST_FILE_PATTERNS.some((p) => p.test(filename));
}

/**
 * Extract keywords from text for claim matching
 */
function extractKeywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
  return new Set(words);
}

/**
 * Check if a patch contains meaningful (non-whitespace) changes
 */
function hasMeaningfulChanges(patch: string): boolean {
  const added = patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .join('\n');
  const removed = patch
    .split('\n')
    .filter((l) => l.startsWith('-') && !l.startsWith('---'))
    .map((l) => l.slice(1))
    .join('\n');

  return !WHITESPACE_ONLY_CHANGE.test(added) || !WHITESPACE_ONLY_CHANGE.test(removed);
}

// ─── Detectors ──────────────────────────────────────────────────────────────

/**
 * **Claim vs Reality Matcher**
 *
 * Parses the PR body for claims (fix, feature, refactor, etc.) and checks
 * whether the diff actually touches files/areas related to those claims.
 *
 * | Overlap Score | Meaning                          |
 * |---------------|----------------------------------|
 * | > 0.5         | Good alignment — probably human   |
 * | 0.2 – 0.5     | Weak alignment — suspicious       |
 * | < 0.2         | No alignment — likely slop        |
 */
function detectClaimMismatch(pr: PRContext): Finding {
  const body = pr.body.toLowerCase();
  const title = pr.title.toLowerCase();
  const combined = `${title} ${body}`;

  // Detect which claim categories are present
  const activeClaims: string[] = [];
  for (const [category, pattern] of Object.entries(CLAIM_KEYWORDS)) {
    if (pattern.test(combined)) {
      activeClaims.push(category);
    }
  }

  if (activeClaims.length === 0) {
    return {
      id: 'claim-mismatch',
      module: 'diff-analysis',
      severity: 'info',
      message: 'No specific claims detected in PR description',
      score: 10,
    };
  }

  // Extract keywords from PR body/title
  const bodyKeywords = extractKeywords(combined);

  // Extract keywords from changed filenames and patches
  const fileKeywords = new Set<string>();
  for (const file of pr.files_changed) {
    const parts = file.filename.replace(/[._/\\-]/g, ' ').toLowerCase().split(/\s+/);
    parts.forEach((p) => {
      if (p.length > 3) fileKeywords.add(p);
    });
    if (file.patch) {
      const patchWords = file.patch
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 4);
      patchWords.forEach((w) => fileKeywords.add(w));
    }
  }

  // Calculate overlap
  let overlapCount = 0;
  for (const keyword of bodyKeywords) {
    if (fileKeywords.has(keyword)) overlapCount++;
  }

  const overlapRatio = bodyKeywords.size > 0 ? overlapCount / bodyKeywords.size : 0;

  // Score: low overlap = high slop probability
  let score: number;
  let severity: Finding['severity'];
  let message: string;

  if (overlapRatio > 0.5) {
    score = 10;
    severity = 'info';
    message = `Strong claim-to-diff alignment (${(overlapRatio * 100).toFixed(0)}% keyword overlap)`;
  } else if (overlapRatio > 0.2) {
    score = 50;
    severity = 'warning';
    message = `Weak claim-to-diff alignment (${(overlapRatio * 100).toFixed(0)}% keyword overlap) — claims don't match changes well`;
  } else {
    score = 85;
    severity = 'flag';
    message = `No claim-to-diff alignment (${(overlapRatio * 100).toFixed(0)}% keyword overlap) — PR claims don't match actual changes`;
  }

  return {
    id: 'claim-mismatch',
    module: 'diff-analysis',
    severity,
    message,
    detail: `Active claims: ${activeClaims.join(', ')}. Overlap: ${overlapCount}/${bodyKeywords.size} keywords`,
    score,
  };
}

/**
 * **Unrelated File Detector**
 *
 * Flags PRs that touch many unrelated files or directories relative to
 * their stated purpose.
 *
 * | Directories | Files  | Score |
 * |-------------|--------|-------|
 * | 1-2         | < 5    | 10    |
 * | 3-4         | 5-10   | 40    |
 * | 5+          | 10+    | 70    |
 * | 8+          | 15+    | 90    |
 */
function detectUnrelatedFiles(pr: PRContext): Finding {
  const fileCount = pr.files_changed.length;
  const directories = extractDirectories(pr.files_changed);
  const dirCount = directories.length;

  let score: number;
  let severity: Finding['severity'];

  if (dirCount <= 2 && fileCount <= 5) {
    score = 10;
    severity = 'info';
  } else if (dirCount <= 4 && fileCount <= 10) {
    score = 40;
    severity = 'warning';
  } else if (dirCount >= 8 || fileCount >= 15) {
    score = 90;
    severity = 'flag';
  } else {
    score = 70;
    severity = 'flag';
  }

  return {
    id: 'unrelated-files',
    module: 'diff-analysis',
    severity,
    message: `PR touches ${fileCount} files across ${dirCount} directories`,
    detail: `Directories: ${directories.slice(0, 5).join(', ')}${dirCount > 5 ? ` (+${dirCount - 5} more)` : ''}`,
    score,
  };
}

/**
 * **Comment-to-Code Ratio Analyzer**
 *
 * AI slop PRs are often 80% verbose comments, 20% actual code.
 *
 * | Comment % | Score | Severity |
 * |-----------|-------|----------|
 * | < 30%     | 10    | info     |
 * | 30-50%    | 30    | info     |
 * | 50-70%    | 60    | warning  |
 * | > 70%     | 85    | flag     |
 */
function detectCommentRatio(pr: PRContext): Finding {
  let totalCode = 0;
  let totalComments = 0;
  let totalBlank = 0;

  for (const file of pr.files_changed) {
    if (!file.patch) continue;
    const { code, comments, blank } = countCodeLines(file.patch);
    totalCode += code;
    totalComments += comments;
    totalBlank += blank;
  }

  const total = totalCode + totalComments;
  if (total === 0) {
    return {
      id: 'comment-ratio',
      module: 'diff-analysis',
      severity: 'info',
      message: 'No code changes detected to analyze',
      score: 20,
    };
  }

  const commentRatio = totalComments / total;
  const commentPercent = Math.round(commentRatio * 100);

  let score: number;
  let severity: Finding['severity'];

  if (commentPercent < 30) {
    score = 10;
    severity = 'info';
  } else if (commentPercent < 50) {
    score = 30;
    severity = 'info';
  } else if (commentPercent < 70) {
    score = 60;
    severity = 'warning';
  } else {
    score = 85;
    severity = 'flag';
  }

  return {
    id: 'comment-ratio',
    module: 'diff-analysis',
    severity,
    message: `Comment-to-code ratio: ${commentPercent}% comments (${totalComments} comment lines / ${totalCode} code lines)`,
    score,
  };
}

/**
 * **Missing Test Detector**
 *
 * If a PR claims to fix a bug or add a feature but doesn't touch any test
 * files, that's suspicious.
 *
 * | Claim Type       | Has Tests | Score |
 * |------------------|-----------|-------|
 * | fix/feature      | yes       | 10    |
 * | fix/feature      | no        | 70    |
 * | docs/style       | N/A       | 10    |
 */
function detectMissingTests(pr: PRContext): Finding {
  const combined = `${pr.title} ${pr.body}`.toLowerCase();
  const isFixOrFeature =
    CLAIM_KEYWORDS.fix.test(combined) || CLAIM_KEYWORDS.feature.test(combined);

  if (!isFixOrFeature) {
    return {
      id: 'missing-tests',
      module: 'diff-analysis',
      severity: 'info',
      message: 'PR does not claim to fix a bug or add a feature — test presence not expected',
      score: 10,
    };
  }

  const hasTestChanges = pr.files_changed.some((f) => isTestFile(f.filename));

  if (hasTestChanges) {
    return {
      id: 'missing-tests',
      module: 'diff-analysis',
      severity: 'info',
      message: 'PR includes test file changes — good practice',
      score: 10,
    };
  }

  return {
    id: 'missing-tests',
    module: 'diff-analysis',
    severity: 'warning',
    message: 'PR claims to fix/add functionality but includes no test changes',
    detail: 'Consider adding or updating tests for bug fixes and new features',
    score: 70,
  };
}

/**
 * **Style-Only Change Detector**
 *
 * Detects PRs that only change formatting/whitespace but claim to be
 * substantive changes (bug fixes, features).
 */
function detectStyleOnlyChanges(pr: PRContext): Finding {
  const combined = `${pr.title} ${pr.body}`.toLowerCase();
  const claimsSubstantive =
    CLAIM_KEYWORDS.fix.test(combined) ||
    CLAIM_KEYWORDS.feature.test(combined) ||
    CLAIM_KEYWORDS.perf.test(combined);

  if (!claimsSubstantive) {
    return {
      id: 'style-only',
      module: 'diff-analysis',
      severity: 'info',
      message: 'PR does not claim substantive changes',
      score: 5,
    };
  }

  let meaningfulFiles = 0;
  let styleOnlyFiles = 0;

  for (const file of pr.files_changed) {
    if (!file.patch) continue;
    if (hasMeaningfulChanges(file.patch)) {
      meaningfulFiles++;
    } else {
      styleOnlyFiles++;
    }
  }

  const totalFiles = meaningfulFiles + styleOnlyFiles;
  if (totalFiles === 0) {
    return {
      id: 'style-only',
      module: 'diff-analysis',
      severity: 'info',
      message: 'No file changes to analyze',
      score: 10,
    };
  }

  const styleRatio = styleOnlyFiles / totalFiles;

  if (styleRatio > 0.8) {
    return {
      id: 'style-only',
      module: 'diff-analysis',
      severity: 'flag',
      message: `PR claims substantive changes but ${Math.round(styleRatio * 100)}% of files are whitespace/formatting only`,
      detail: `${styleOnlyFiles}/${totalFiles} files have no meaningful code changes`,
      score: 80,
    };
  }

  if (styleRatio > 0.5) {
    return {
      id: 'style-only',
      module: 'diff-analysis',
      severity: 'warning',
      message: `PR is mostly style changes (${Math.round(styleRatio * 100)}%) despite claiming substantive work`,
      score: 50,
    };
  }

  return {
    id: 'style-only',
    module: 'diff-analysis',
    severity: 'info',
    message: `PR has mostly meaningful changes (${Math.round((1 - styleRatio) * 100)}% substantive)`,
    score: 10,
  };
}

/**
 * **Diff Size Analyzer**
 *
 * Flags suspiciously large or small diffs relative to claimed scope.
 *
 * | Lines    | Claim      | Score | Reason              |
 * |----------|------------|-------|---------------------|
 * | < 20     | big fix    | 70    | Too small for claim  |
 * | < 20     | small fix  | 10    | Reasonable           |
 * | > 500    | any        | 60    | Suspiciously large   |
 * | > 2000   | any        | 85    | Massive, likely slop |
 */
function detectDiffSize(pr: PRContext): Finding {
  const combined = `${pr.title} ${pr.body}`.toLowerCase();
  const isSmallClaim =
    /\b(typo|minor|small|quick|trivial|simple)\b/i.test(combined);
  const isBigClaim =
    /\b(overhaul|rewrite|major|large|complete|comprehensive|entire)\b/i.test(combined);

  const totalLines = pr.files_changed.reduce(
    (sum, f) => sum + f.additions + f.deletions,
    0
  );

  let score: number;
  let severity: Finding['severity'];
  let message: string;

  if (totalLines > 2000) {
    score = 85;
    severity = 'flag';
    message = `Massive diff: ${totalLines} lines changed — likely automated or AI-generated bulk changes`;
  } else if (totalLines > 500 && !isBigClaim) {
    score = 60;
    severity = 'warning';
    message = `Large diff: ${totalLines} lines changed — unusually big for the stated scope`;
  } else if (totalLines < 20 && isBigClaim) {
    score = 70;
    severity = 'warning';
    message = `Tiny diff (${totalLines} lines) but PR claims major changes — mismatch`;
  } else if (totalLines < 20) {
    score = 10;
    severity = 'info';
    message = `Small diff: ${totalLines} lines — consistent with minor changes`;
  } else {
    score = 20;
    severity = 'info';
    message = `Diff size: ${totalLines} lines — within normal range`;
  }

  return {
    id: 'diff-size',
    module: 'diff-analysis',
    severity,
    message,
    detail: `+${pr.files_changed.reduce((s, f) => s + f.additions, 0)} / -${pr.files_changed.reduce((s, f) => s + f.deletions, 0)} across ${pr.files_changed.length} files`,
    score,
  };
}

// ─── Main Export ────────────────────────────────────────────────────────────

/**
 * Run all diff analysis detectors against a PR context.
 *
 * Returns a `ModuleResult` with an aggregated score (0-100) and
 * individual findings from each detector.
 *
 * @param pr - The PR context containing title, body, commits, and file changes
 * @returns ModuleResult with weighted score and findings
 */
export function analyzeDiff(pr: PRContext): ModuleResult {
  const start = performance.now();

  const findings: Finding[] = [
    detectClaimMismatch(pr),
    detectUnrelatedFiles(pr),
    detectCommentRatio(pr),
    detectMissingTests(pr),
    detectStyleOnlyChanges(pr),
    detectDiffSize(pr),
  ];

  // Weighted average — claim mismatch and unrelated files are strongest signals
  const weights: Record<string, number> = {
    'claim-mismatch': 1.3,
    'unrelated-files': 1.2,
    'comment-ratio': 1.0,
    'missing-tests': 0.9,
    'style-only': 1.1,
    'diff-size': 0.8,
  };

  let weightedSum = 0;
  let totalWeight = 0;
  for (const f of findings) {
    const w = weights[f.id] ?? 1.0;
    weightedSum += f.score * w;
    totalWeight += w;
  }

  const score = Math.round(totalWeight > 0 ? weightedSum / totalWeight : 50);

  return {
    module: 'diff-analysis',
    score: Math.min(100, Math.max(0, score)),
    findings,
    duration_ms: Math.round(performance.now() - start),
  };
}

// Re-export helpers for testing
export {
  countCodeLines,
  isCommentLine,
  extractDirectories,
  isTestFile,
  extractKeywords,
  hasMeaningfulChanges,
  detectClaimMismatch,
  detectUnrelatedFiles,
  detectCommentRatio,
  detectMissingTests,
  detectStyleOnlyChanges,
  detectDiffSize,
};
