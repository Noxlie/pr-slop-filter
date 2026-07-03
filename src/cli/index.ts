#!/usr/bin/env node
/**
 * pr-slop CLI
 *
 * Commands:
 *   pr-slop check   — check a specific PR
 *   pr-slop scan    — scan all open PRs in a repo
 *   pr-slop preflight — check local changes before pushing
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { Octokit } from 'octokit';
import { execSync } from 'node:child_process';
import { runFilter, scoreBar } from '../index.js';
import type { PRContext, FilterConfig, SlopReport, CommitInfo, FileChange } from '../types.js';

// ── Helpers ────────────────────────────────────────────────────────

function getOctokit(token?: string): Octokit {
  const t = token ?? process.env.GITHUB_TOKEN;
  if (!t) {
    console.error(
      chalk.red(
        '✖ No GitHub token. Set GITHUB_TOKEN env var or pass --token.',
      ),
    );
    process.exit(1);
  }
  return new Octokit({ auth: t });
}

function parseRepo(repo: string): { owner: string; name: string } {
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    console.error(chalk.red('✖ --repo must be owner/repo (e.g. octocat/hello-world)'));
    process.exit(1);
  }
  return { owner: parts[0], name: parts[1] };
}

function buildConfig(opts: Record<string, unknown>): FilterConfig {
  return {
    threshold: Number(opts.threshold ?? 70),
    fail_on_slop: false,
    verbose: Boolean(opts.verbose),
    format: (opts.format as FilterConfig['format']) ?? 'text',
    github_token: (opts.token as string) ?? process.env.GITHUB_TOKEN,
    llm_provider: opts.llmProvider as FilterConfig['llm_provider'],
    llm_api_key: opts.llmApiKey as string,
    llm_model: opts.llmModel as string,
  };
}

// ── PR fetching ────────────────────────────────────────────────────

async function fetchPRContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PRContext> {
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  const { data: commits } = await octokit.rest.pulls.listCommits({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const { data: files } = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  return {
    owner,
    repo,
    pr_number: prNumber,
    title: pr.title ?? '',
    body: pr.body ?? '',
    author: pr.user?.login ?? 'unknown',
    commits: commits.map(
      (c): CommitInfo => ({
        sha: c.sha,
        message: c.commit.message?.split('\n')[0] ?? '',
        author: c.commit.author?.name ?? 'unknown',
        date: c.commit.author?.date ?? '',
      }),
    ),
    files_changed: files.map(
      (f): FileChange => ({
        filename: f.filename,
        status: f.status as FileChange['status'],
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      }),
    ),
    labels: pr.labels?.map((l) => (typeof l === 'string' ? l : l.name ?? '')),
    base_branch: pr.base?.ref ?? 'main',
    head_branch: pr.head?.ref ?? '',
  };
}

// ── Output renderers ───────────────────────────────────────────────

function severityEmoji(sev: 'flag' | 'warning' | 'info'): string {
  return sev === 'flag' ? '🚩' : sev === 'warning' ? '⚠️' : 'ℹ️';
}

function verdictColor(verdict: string): typeof chalk {
  switch (verdict) {
    case 'human':
      return chalk.green;
    case 'uncertain':
      return chalk.yellow;
    case 'likely-slop':
      return chalk.hex('#FF8C00');
    case 'slop':
      return chalk.red.bold;
    default:
      return chalk.white;
  }
}

function renderText(report: SlopReport, verbose: boolean): void {
  const vc = verdictColor(report.verdict);

  console.log('');
  console.log(chalk.bold(`🔍 PR Slop Filter — #${report.pr.number}: ${report.pr.title}`));
  console.log(chalk.gray('─'.repeat(60)));
  console.log(
    `   Score:      ${vc(scoreBar(report.overall_score))}`,
  );
  console.log(
    `   Verdict:    ${vc(report.verdict.toUpperCase())}`,
  );
  console.log(
    `   Confidence: ${chalk.cyan(report.confidence + '%')}`,
  );
  console.log('');

  // Per-module scores
  console.log(chalk.bold('   Module Breakdown:'));
  for (const mod of report.modules) {
    const bar = scoreBar(mod.score);
    const modColor =
      mod.score > 60 ? chalk.red : mod.score > 30 ? chalk.yellow : chalk.green;
    console.log(
      `   ${modColor(mod.module.padEnd(20))} ${modColor(bar)}  ${chalk.gray(`(${mod.findings.length} findings, ${mod.duration_ms}ms)`)}`,
    );
  }

  // Findings
  const allFindings = report.modules.flatMap((m) =>
    m.findings.map((f) => ({ ...f, moduleName: m.module })),
  );

  if (allFindings.length > 0) {
    console.log('');
    console.log(chalk.bold(`   Findings (${allFindings.length}):`));

    const sorted = allFindings.sort((a, b) => b.score - a.score);
    const show = verbose ? sorted : sorted.slice(0, 10);

    for (const f of show) {
      const emoji = severityEmoji(f.severity);
      const label =
        f.severity === 'flag'
          ? chalk.red.bold('FLAG')
          : f.severity === 'warning'
            ? chalk.yellow('WARN')
            : chalk.blue('INFO');
      console.log(
        `   ${emoji} ${label} ${chalk.gray(`[${f.moduleName}]`)} ${f.message}`,
      );
      if (verbose && f.detail) {
        console.log(`      ${chalk.gray(f.detail)}`);
      }
    }

    if (!verbose && sorted.length > 10) {
      console.log(
        chalk.gray(`   ... and ${sorted.length - 10} more (use --verbose to see all)`),
      );
    }
  }

  console.log('');
  console.log(chalk.gray(`   ${report.pr.url}`));
  console.log(chalk.gray(`   ${report.timestamp}`));
  console.log('');
}

function renderJson(report: SlopReport): void {
  console.log(JSON.stringify(report, null, 2));
}

function renderGithubAnnotation(report: SlopReport): void {
  for (const mod of report.modules) {
    for (const f of mod.findings) {
      const level =
        f.severity === 'flag'
          ? 'error'
          : f.severity === 'warning'
            ? 'warning'
            : 'notice';
      // GitHub Actions annotation format
      console.log(`::${level}::[slop:${f.module}] ${f.message}`);
    }
  }
  // Summary line
  const vc = verdictColor(report.verdict);
  console.log('');
  console.log(vc(report.summary));
}

// ── Git diff helper (for preflight) ────────────────────────────────

function getGitDiff(staged: boolean): string {
  try {
    const flag = staged ? '--cached' : 'HEAD';
    return execSync(`git diff ${flag}`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    console.error(chalk.red('✖ Failed to read git diff. Are you in a git repo?'));
    process.exit(1);
  }
}

function buildPreflightPR(diff: string): PRContext {
  // Parse diff into synthetic PR context
  const fileBlocks = diff.split(/^diff --git /m).filter(Boolean);
  const files: FileChange[] = fileBlocks.map((block) => {
    const nameMatch = block.match(/^a\/(.+?) b\//);
    const filename = nameMatch?.[1] ?? 'unknown';
    const additions = (block.match(/^\+[^+]/gm) ?? []).length;
    const deletions = (block.match(/^-[^-]/gm) ?? []).length;
    return {
      filename,
      status: 'modified' as const,
      additions,
      deletions,
      patch: block,
    };
  });

  return {
    owner: 'local',
    repo: 'local',
    pr_number: 0,
    title: 'Local changes (preflight)',
    body: '',
    author: 'local',
    commits: [],
    files_changed: files,
    base_branch: 'HEAD',
    head_branch: 'working-tree',
  };
}

// ── CLI definition ─────────────────────────────────────────────────

const program = new Command();

program
  .name('pr-slop')
  .description('🤖 Detect AI-generated slop PRs before they waste maintainers\' time')
  .version('1.0.0');

// ── check ──────────────────────────────────────────────────────────

program
  .command('check')
  .description('Check a specific PR for AI slop')
  .requiredOption('--repo <owner/repo>', 'GitHub repository (owner/repo)')
  .requiredOption('--pr <number>', 'PR number to check', Number)
  .option('--threshold <number>', 'Slop score threshold (0-100)', Number, 70)
  .option('--format <format>', 'Output format: text, json, github-annotation', 'text')
  .option('--verbose', 'Show all findings with details')
  .option('--token <token>', 'GitHub token (overrides GITHUB_TOKEN env)')
  .option('--json', 'Shorthand for --format json')
  .option('--llm-provider <provider>', 'LLM provider: openai, anthropic, local')
  .option('--llm-api-key <key>', 'LLM API key')
  .option('--llm-model <model>', 'LLM model name')
  .action(async (opts) => {
    if (opts.json) opts.format = 'json';

    const { owner, name } = parseRepo(opts.repo);
    const octokit = getOctokit(opts.token);
    const config = buildConfig(opts);

    console.log(chalk.cyan(`⏳ Fetching PR #${opts.pr} from ${owner}/${name}...`));

    try {
      const pr = await fetchPRContext(octokit, owner, name, opts.pr);
      const report = await runFilter(pr, config);

      if (opts.format === 'json') {
        renderJson(report);
      } else if (opts.format === 'github-annotation') {
        renderGithubAnnotation(report);
      } else {
        renderText(report, opts.verbose);
      }

      // Exit code based on threshold
      if (report.overall_score >= config.threshold) {
        process.exit(1);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`✖ Error: ${message}`));
      process.exit(2);
    }
  });

// ── scan ───────────────────────────────────────────────────────────

program
  .command('scan')
  .description('Scan all open PRs in a repository')
  .requiredOption('--repo <owner/repo>', 'GitHub repository (owner/repo)')
  .option('--open', 'Only scan open PRs (default: true)', true)
  .option('--threshold <number>', 'Slop score threshold (0-100)', Number, 70)
  .option('--format <format>', 'Output format: text, json, github-annotation', 'text')
  .option('--verbose', 'Show all findings with details')
  .option('--token <token>', 'GitHub token (overrides GITHUB_TOKEN env)')
  .option('--json', 'Shorthand for --format json')
  .option('--llm-provider <provider>', 'LLM provider: openai, anthropic, local')
  .option('--llm-api-key <key>', 'LLM API key')
  .option('--llm-model <model>', 'LLM model name')
  .action(async (opts) => {
    if (opts.json) opts.format = 'json';

    const { owner, name } = parseRepo(opts.repo);
    const octokit = getOctokit(opts.token);
    const config = buildConfig(opts);

    console.log(chalk.cyan(`⏳ Fetching open PRs from ${owner}/${name}...`));

    try {
      const { data: prs } = await octokit.rest.pulls.list({
        owner,
        repo: name,
        state: 'open',
        per_page: 100,
        sort: 'created',
        direction: 'desc',
      });

      if (prs.length === 0) {
        console.log(chalk.green('✅ No open PRs found.'));
        return;
      }

      console.log(chalk.cyan(`   Found ${prs.length} open PR(s)\n`));

      const reports: SlopReport[] = [];
      let flagged = 0;

      for (const pr of prs) {
        process.stdout.write(
          chalk.gray(`   Checking #${pr.number}: ${pr.title.slice(0, 50)}...`),
        );

        const prCtx = await fetchPRContext(octokit, owner, name, pr.number);
        const report = await runFilter(prCtx, config);
        reports.push(report);

        if (report.overall_score >= config.threshold) flagged++;

        // Inline status
        const vc = verdictColor(report.verdict);
        console.log(
          ` ${vc(String(report.overall_score).padStart(3))}/100  ${vc(report.verdict)}`,
        );
      }

      console.log('');
      console.log(chalk.bold('─'.repeat(60)));
      console.log(
        chalk.bold(
          `   Results: ${reports.length} scanned, ${chalk.red(flagged + ' flagged')}, ${chalk.green(reports.length - flagged + ' clean')}`,
        ),
      );
      console.log('');

      if (opts.format === 'json') {
        console.log(JSON.stringify(reports, null, 2));
      } else {
        // Show flagged PRs detail
        for (const report of reports) {
          if (report.overall_score >= config.threshold) {
            renderText(report, opts.verbose);
          }
        }
      }

      // Exit 1 if any PR is above threshold
      if (flagged > 0) process.exit(1);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`✖ Error: ${message}`));
      process.exit(2);
    }
  });

// ── preflight ──────────────────────────────────────────────────────

program
  .command('preflight')
  .description('Check local changes before pushing (reads git diff)')
  .option('--staged', 'Only check staged changes')
  .option('--threshold <number>', 'Slop score threshold (0-100)', Number, 70)
  .option('--format <format>', 'Output format: text, json, github-annotation', 'text')
  .option('--verbose', 'Show all findings with details')
  .option('--json', 'Shorthand for --format json')
  .option('--llm-provider <provider>', 'LLM provider: openai, anthropic, local')
  .option('--llm-api-key <key>', 'LLM API key')
  .option('--llm-model <model>', 'LLM model name')
  .action(async (opts) => {
    if (opts.json) opts.format = 'json';

    const config = buildConfig(opts);

    console.log(
      chalk.cyan(
        `⏳ Reading ${opts.staged ? 'staged' : 'unstaged'} changes...`,
      ),
    );

    const diff = getGitDiff(Boolean(opts.staged));

    if (!diff.trim()) {
      console.log(chalk.green('✅ No changes to check.'));
      return;
    }

    const pr = buildPreflightPR(diff);
    const report = await runFilter(pr, config);

    if (opts.format === 'json') {
      renderJson(report);
    } else if (opts.format === 'github-annotation') {
      renderGithubAnnotation(report);
    } else {
      renderText(report, opts.verbose);
    }

    if (report.overall_score >= config.threshold) {
      console.log(
        chalk.red.bold(
          `\n✖ Score ${report.overall_score}/100 exceeds threshold ${config.threshold}. Consider reviewing your changes.\n`,
        ),
      );
      process.exit(1);
    } else {
      console.log(
        chalk.green.bold(
          `\n✅ Score ${report.overall_score}/100 is below threshold ${config.threshold}. Looks good to push!\n`,
        ),
      );
    }
  });

// ── Parse & run ────────────────────────────────────────────────────

program.parse();
