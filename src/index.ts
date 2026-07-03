/**
 * pr-slop-filter — barrel export + orchestration
 *
 * Re-exports every detection module and exposes `runFilter()`,
 * the single entry-point that runs all modules, computes a weighted
 * overall score, picks a verdict, and returns a human-readable summary.
 */

import type {
  PRContext,
  FilterConfig,
  SlopReport,
  ModuleResult,
} from './types.js';

// Re-export types
export type {
  Finding,
  ModuleResult,
  PRContext,
  CommitInfo,
  FileChange,
  SlopReport,
  FilterConfig,
  PhrasePattern,
} from './types.js';

// Re-export detection modules
export { analyzeHeuristics } from './heuristics/index.js';
export { analyzeDiff } from './diff-analyzer/index.js';
export { verifyWithLLM } from './llm-verifier/index.js';

// Import for internal use
import { analyzeHeuristics } from './heuristics/index.js';
import { analyzeDiff } from './diff-analyzer/index.js';
import { verifyWithLLM } from './llm-verifier/index.js';

// ── Weights for each module ────────────────────────────────────────
const MODULE_WEIGHTS = {
  heuristics: 0.35,
  'diff-analysis': 0.35,
  'llm-verifier': 0.30,
} as const;

// ── Verdict thresholds ─────────────────────────────────────────────
type Verdict = SlopReport['verdict'];

function scoreToVerdict(score: number): Verdict {
  if (score <= 40) return 'human';
  if (score <= 60) return 'uncertain';
  if (score <= 80) return 'likely-slop';
  return 'slop';
}

// ── Confidence heuristic ───────────────────────────────────────────
// Higher when modules agree; lower when they diverge.
function computeConfidence(modules: ModuleResult[]): number {
  if (modules.length === 0) return 0;
  const scores = modules.map((m) => m.score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance =
    scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
  const stdDev = Math.sqrt(variance);
  // Low std-dev → high confidence (max 100).  Cap at 100.
  return Math.round(Math.max(0, Math.min(100, 100 - stdDev * 1.5)));
}

// ── Summary generator ──────────────────────────────────────────────
function generateSummary(
  pr: PRContext,
  overallScore: number,
  verdict: Verdict,
  modules: ModuleResult[],
  confidence: number,
): string {
  const totalFindings = modules.reduce((sum, m) => sum + m.findings.length, 0);
  const flags = modules.reduce(
    (sum, m) => sum + m.findings.filter((f) => f.severity === 'flag').length,
    0,
  );
  const warnings = modules.reduce(
    (sum, m) =>
      sum + m.findings.filter((f) => f.severity === 'warning').length,
    0,
  );

  const verdictLabel: Record<Verdict, string> = {
    human: '✅ Human-authored',
    uncertain: '❓ Uncertain',
    'likely-slop': '⚠️  Likely AI slop',
    slop: '🚩 AI-generated slop',
  };

  const lines: string[] = [
    `PR Slop Filter — #${pr.pr_number}: ${pr.title}`,
    `${'─'.repeat(50)}`,
    `Score:      ${overallScore}/100  ${scoreBar(overallScore)}`,
    `Verdict:    ${verdictLabel[verdict]}`,
    `Confidence: ${confidence}%`,
    ``,
    `Modules:`,
  ];

  for (const mod of modules) {
    const icon = mod.score > 60 ? '🚩' : mod.score > 30 ? '⚠️' : 'ℹ️';
    lines.push(
      `  ${icon} ${mod.module.padEnd(18)} ${String(mod.score).padStart(3)}/100  (${mod.findings.length} findings, ${mod.duration_ms}ms)`,
    );
  }

  if (totalFindings > 0) {
    lines.push('');
    lines.push(
      `Findings: ${totalFindings} total — ${flags} flags, ${warnings} warnings`,
    );

    // Show top findings (up to 5)
    const allFindings = modules
      .flatMap((m) => m.findings)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    for (const f of allFindings) {
      const emoji = f.severity === 'flag' ? '🚩' : f.severity === 'warning' ? '⚠️' : 'ℹ️';
      lines.push(`  ${emoji} [${f.module}] ${f.message}`);
    }
  }

  return lines.join('\n');
}

// ── Score bar helper ───────────────────────────────────────────────
export function scoreBar(score: number, width = 20): string {
  const filled = Math.round((score / 100) * width);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${score}/100`;
}

// ── Main orchestrator ──────────────────────────────────────────────
export async function runFilter(
  pr: PRContext,
  config: FilterConfig,
): Promise<SlopReport> {
  // Run all three modules (potentially in parallel when LLM is async)
  const [heuristicsResult, diffResult, llmResult] = await Promise.all([
    analyzeHeuristics(pr),
    analyzeDiff(pr),
    verifyWithLLM(pr, config),
  ]);

  const modules: ModuleResult[] = [heuristicsResult, diffResult, llmResult];

  // Weighted overall score
  const overallScore = Math.round(
    heuristicsResult.score * MODULE_WEIGHTS.heuristics +
      diffResult.score * MODULE_WEIGHTS['diff-analysis'] +
      llmResult.score * MODULE_WEIGHTS['llm-verifier'],
  );

  const verdict = scoreToVerdict(overallScore);
  const confidence = computeConfidence(modules);
  const summary = generateSummary(
    pr,
    overallScore,
    verdict,
    modules,
    confidence,
  );

  return {
    pr: {
      owner: pr.owner,
      repo: pr.repo,
      number: pr.pr_number,
      title: pr.title,
      url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.pr_number}`,
    },
    overall_score: overallScore,
    verdict,
    confidence,
    modules,
    summary,
    timestamp: new Date().toISOString(),
  };
}
