/**
 * LLM Verification Engine for PR Slop Filter
 *
 * Uses an LLM to detect AI-generated PRs that slip past heuristic analysis.
 * Supports OpenAI, Anthropic, and local OpenAI-compatible endpoints.
 *
 * @module llm-verifier
 */

import type {
  PRContext,
  FilterConfig,
  ModuleResult,
  Finding,
  FileChange,
} from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Default timeout for LLM API calls (ms) */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Approximate characters per token (used for cost estimation) */
const CHARS_PER_TOKEN = 4;

/** Maximum characters included from each file's patch in the prompt */
const MAX_PATCH_CHARS_PER_FILE = 500;

/** Maximum total diff summary characters to keep prompt affordable */
const MAX_DIFF_SUMMARY_CHARS = 4_000;

/** Model pricing: USD per 1M tokens (input, output) */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI
  'gpt-4o':        { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':   { input: 0.15,  output: 0.60  },
  'gpt-4-turbo':   { input: 10.00, output: 30.00 },
  'gpt-3.5-turbo': { input: 0.50,  output: 1.50  },
  // Anthropic
  'claude-sonnet-4-20250514': { input: 3.00,  output: 15.00 },
  'claude-3-5-sonnet-20241022': { input: 3.00,  output: 15.00 },
  'claude-3-5-haiku-20241022':  { input: 0.80,  output: 4.00  },
  'claude-3-opus-20240229':     { input: 15.00, output: 75.00 },
  'claude-3-haiku-20240307':    { input: 0.25,  output: 1.25  },
};

/** Default pricing for unknown models (conservative mid-range estimate) */
const DEFAULT_PRICING = { input: 3.00, output: 15.00 };

// ─── Types ──────────────────────────────────────────────────────────────────

/** Structured LLM response after parsing */
interface LLMVerdict {
  /** Slop score 0-100 */
  score: number;
  /** LLM's reasoning */
  reasoning: string;
}

/** Token cost breakdown */
interface CostEstimate {
  /** Approximate input tokens */
  inputTokens: number;
  /** Estimated output tokens */
  outputTokens: number;
  /** Estimated cost in USD */
  estimatedCostUSD: number;
  /** Model used for pricing lookup */
  model: string;
}

/** Provider-specific request configuration */
interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

// ─── Prompt Construction ────────────────────────────────────────────────────

/**
 * Build a compact diff summary from file changes.
 * Truncates patches and limits total size to avoid token explosion.
 *
 * @param files - Changed files from the PR
 * @returns A string summarizing the diff
 */
function buildDiffSummary(files: FileChange[]): string {
  const lines: string[] = [];

  for (const file of files) {
    const header = `${file.status.toUpperCase()} ${file.filename} (+${file.additions}/-${file.deletions})`;
    lines.push(header);

    if (file.patch) {
      // Truncate individual patches
      const truncated =
        file.patch.length > MAX_PATCH_CHARS_PER_FILE
          ? file.patch.slice(0, MAX_PATCH_CHARS_PER_FILE) + '\n... [truncated]'
          : file.patch;
      lines.push(truncated);
    }

    lines.push(''); // blank separator

    // Stop if we've exceeded the total budget
    if (lines.join('\n').length > MAX_DIFF_SUMMARY_CHARS) {
      lines.push('... [remaining files omitted]');
      break;
    }
  }

  return lines.join('\n');
}

/**
 * Build the verification prompt sent to the LLM.
 *
 * @param pr - The PR context with metadata, commits, and file changes
 * @returns The user-facing prompt string
 */
function buildPrompt(pr: PRContext): string {
  const commitSummary = pr.commits
    .map((c) => `  - ${c.sha.slice(0, 7)} ${c.message.split('\n')[0]}`)
    .join('\n');

  const diffSummary = buildDiffSummary(pr.files_changed);

  const stats = {
    filesChanged: pr.files_changed.length,
    totalAdditions: pr.files_changed.reduce((s, f) => s + f.additions, 0),
    totalDeletions: pr.files_changed.reduce((s, f) => s + f.deletions, 0),
    commitCount: pr.commits.length,
  };

  return `You are a code reviewer specializing in detecting AI-generated pull requests ("AI slop").
Analyze the following PR and determine if it's a genuine human contribution or AI-generated slop.

## PR Metadata
- Repository: ${pr.owner}/${pr.repo}
- Author: ${pr.author}
- Title: ${pr.title}
- Branch: ${pr.head_branch} -> ${pr.base_branch}
- Stats: ${stats.filesChanged} files, +${stats.totalAdditions}/-${stats.totalDeletions}, ${stats.commitCount} commits

## PR Description
${pr.body || '(no description provided)'}

## Commit Messages
${commitSummary || '(no commits)'}

## Diff Summary
${diffSummary || '(no diff available)'}

## Instructions
Evaluate this PR for signs of AI generation. Look for:
- Generic, boilerplate commit messages or PR descriptions
- Code that reads like ChatGPT/Copilot output (excessive comments, over-engineering, generic variable names)
- PR description that's overly formal or uses AI-typical phrasing
- Changes that don't match the stated purpose
- Unusual patterns in commit history (single bulk commit, no iteration)
- Code quality that doesn't match the PR description's claims

Respond in EXACTLY this format (nothing else):
SCORE: <number 0-100>
REASONING: <1-3 sentences explaining your verdict>

Where 0 = definitely human, 100 = definitely AI-generated slop.`;
}

// ─── Token Counting & Cost ──────────────────────────────────────────────────

/**
 * Estimate the number of tokens in a string.
 * Uses a simple character-based heuristic (4 chars ≈ 1 token).
 *
 * @param text - The text to estimate tokens for
 * @returns Approximate token count
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Calculate estimated cost for an LLM call.
 *
 * @param promptTokens - Number of input tokens
 * @param model - Model identifier for pricing lookup
 * @returns Cost breakdown
 */
function estimateCost(promptTokens: number, model: string): CostEstimate {
  // Estimate output tokens: typically shorter than input for this task
  const outputTokens = Math.min(500, Math.ceil(promptTokens * 0.1));

  // Look up pricing (try exact match, then partial match)
  let pricing = MODEL_PRICING[model];
  if (!pricing) {
    // Try partial match (e.g., "gpt-4o-2024-08-06" matches "gpt-4o")
    const match = Object.keys(MODEL_PRICING).find((k) => model.startsWith(k));
    pricing = match ? MODEL_PRICING[match] : DEFAULT_PRICING;
  }

  const inputCost = (promptTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;

  return {
    inputTokens: promptTokens,
    outputTokens,
    estimatedCostUSD: inputCost + outputCost,
    model,
  };
}

// ─── Response Parsing ───────────────────────────────────────────────────────

/**
 * Parse the LLM's response into a structured verdict.
 * Handles various response formats gracefully.
 *
 * @param responseText - Raw text from the LLM
 * @returns Parsed score and reasoning, defaults to 50 if unparseable
 */
function parseVerdict(responseText: string): LLMVerdict {
  // Try to extract SCORE: <number>
  const scoreMatch = responseText.match(/SCORE:\s*(\d+)/i);
  // Try to extract REASONING: <text>
  const reasoningMatch = responseText.match(/REASONING:\s*(.+)/is);

  let score = 50; // default for unparseable
  let reasoning = 'Unable to parse LLM response';

  if (scoreMatch) {
    const parsed = parseInt(scoreMatch[1], 10);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
      score = parsed;
    }
  }

  if (reasoningMatch) {
    reasoning = reasoningMatch[1].trim();
    // Cap reasoning length
    if (reasoning.length > 500) {
      reasoning = reasoning.slice(0, 500) + '…';
    }
  } else if (!scoreMatch) {
    // If neither field was found, use the raw response (truncated) as reasoning
    reasoning = responseText.length > 300
      ? responseText.slice(0, 300) + '…'
      : responseText;
  }

  return { score, reasoning };
}

// ─── Provider Adapters ──────────────────────────────────────────────────────

/**
 * Build the OpenAI-compatible request (also used for local endpoints).
 *
 * @param prompt - The user prompt
 * @param config - Filter config with API key, model, and base URL
 * @returns Provider request configuration
 */
function buildOpenAIRequest(prompt: string, config: FilterConfig): ProviderRequest {
  const baseUrl = (config.llm_base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = config.llm_model || 'gpt-4o-mini';

  return {
    url: `${baseUrl}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llm_api_key}`,
    },
    body: {
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert at detecting AI-generated code contributions. Be concise and precise.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 500,
    },
  };
}

/**
 * Build the Anthropic API request.
 *
 * @param prompt - The user prompt
 * @param config - Filter config with API key and model
 * @returns Provider request configuration
 */
function buildAnthropicRequest(prompt: string, config: FilterConfig): ProviderRequest {
  const model = config.llm_model || 'claude-3-5-haiku-20241022';

  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.llm_api_key!,
      'anthropic-version': '2023-06-01',
    },
    body: {
      model,
      max_tokens: 500,
      system:
        'You are an expert at detecting AI-generated code contributions. Be concise and precise.',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    },
  };
}

/**
 * Call an LLM endpoint with timeout support.
 *
 * @param request - Provider-specific request configuration
 * @param timeoutMs - Timeout in milliseconds
 * @returns Raw response text from the LLM
 * @throws On HTTP errors or timeout
 */
async function callLLM(
  request: ProviderRequest,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '(no body)');
      throw new Error(
        `LLM API returned ${response.status}: ${errorBody.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    return extractResponseText(data);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract the assistant's text from a provider response.
 * Handles both OpenAI and Anthropic response formats.
 *
 * @param data - Parsed JSON response from the provider
 * @returns The assistant's text content
 * @throws If the response format is unrecognizable
 */
function extractResponseText(data: Record<string, unknown>): string {
  // OpenAI format: { choices: [{ message: { content: "..." } }] }
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  if (choices?.[0]) {
    const message = choices[0].message as Record<string, unknown> | undefined;
    if (typeof message?.content === 'string') {
      return message.content;
    }
  }

  // Anthropic format: { content: [{ type: "text", text: "..." }] }
  const content = data.content as Array<Record<string, unknown>> | undefined;
  if (content?.[0]?.type === 'text' && typeof content[0].text === 'string') {
    return content[0].text;
  }

  throw new Error('Unrecognizable LLM response format');
}

// ─── Finding Helpers ────────────────────────────────────────────────────────

let findingCounter = 0;

/**
 * Create a Finding with a unique ID.
 */
function makeFinding(
  severity: Finding['severity'],
  message: string,
  detail?: string,
  score = 0,
): Finding {
  return {
    id: `llm-${++findingCounter}`,
    module: 'llm-verifier',
    severity,
    message,
    detail,
    score,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Verify a PR using an LLM to detect AI-generated slop.
 *
 * This module is optional — if no API key is configured, it returns a neutral
 * result. When active, it sends PR context (title, body, commits, diff summary)
 * to the configured LLM provider and asks for a slop score.
 *
 * @param pr - The pull request context
 * @param config - Filter configuration including LLM provider settings
 * @returns A ModuleResult with the LLM's slop assessment
 *
 * @example
 * ```ts
 * const result = await verifyWithLLM(prContext, {
 *   threshold: 70,
 *   fail_on_slop: true,
 *   llm_provider: 'openai',
 *   llm_api_key: process.env.OPENAI_API_KEY,
 *   verbose: true,
 *   format: 'text',
 * });
 * ```
 */
export async function verifyWithLLM(
  pr: PRContext,
  config: FilterConfig,
): Promise<ModuleResult> {
  const start = performance.now();
  const findings: Finding[] = [];

  // ── Skip mode: no API key ──────────────────────────────────────────────
  if (!config.llm_api_key) {
    findings.push(
      makeFinding('info', 'LLM verification skipped — no API key'),
    );
    return {
      module: 'llm-verifier',
      score: 0,
      findings,
      duration_ms: Math.round(performance.now() - start),
    };
  }

  // ── Build prompt ───────────────────────────────────────────────────────
  const prompt = buildPrompt(pr);
  const inputTokens = estimateTokens(prompt);
  const model = config.llm_model || getDefaultModel(config.llm_provider);
  const cost = estimateCost(inputTokens, model);

  findings.push(
    makeFinding(
      'info',
      `Estimated ${cost.inputTokens} input tokens (~$${cost.estimatedCostUSD.toFixed(4)} USD)`,
      `Model: ${model}, Provider: ${config.llm_provider ?? 'openai'}`,
    ),
  );

  // ── Build provider-specific request ────────────────────────────────────
  let request: ProviderRequest;
  switch (config.llm_provider) {
    case 'anthropic':
      request = buildAnthropicRequest(prompt, config);
      break;
    case 'local':
      request = buildOpenAIRequest(prompt, config);
      break;
    case 'openai':
    default:
      request = buildOpenAIRequest(prompt, config);
      break;
  }

  // ── Call LLM ───────────────────────────────────────────────────────────
  let rawResponse: string;
  try {
    rawResponse = await callLLM(request, DEFAULT_TIMEOUT_MS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Distinguish timeout from other errors
    if (message.includes('abort') || message.includes('timeout')) {
      findings.push(
        makeFinding('warning', 'LLM verification timed out', message, 50),
      );
      return {
        module: 'llm-verifier',
        score: 50,
        findings,
        duration_ms: Math.round(performance.now() - start),
      };
    }

    findings.push(
      makeFinding('warning', 'LLM verification failed', message, 50),
    );
    return {
      module: 'llm-verifier',
      score: 50,
      findings,
      duration_ms: Math.round(performance.now() - start),
    };
  }

  // ── Parse response ─────────────────────────────────────────────────────
  const verdict = parseVerdict(rawResponse);

  findings.push(
    makeFinding(
      verdict.score >= 70 ? 'flag' : verdict.score >= 40 ? 'warning' : 'info',
      `LLM score: ${verdict.score}/100`,
      verdict.reasoning,
      verdict.score,
    ),
  );

  return {
    module: 'llm-verifier',
    score: verdict.score,
    findings,
    duration_ms: Math.round(performance.now() - start),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Get the default model name for a given provider.
 *
 * @param provider - LLM provider identifier
 * @returns Default model name
 */
function getDefaultModel(provider?: string): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-3-5-haiku-20241022';
    case 'local':
      return 'local';
    case 'openai':
    default:
      return 'gpt-4o-mini';
  }
}

// ─── Test-only exports ──────────────────────────────────────────────────────
// These are exported for unit testing but are not part of the public API.

export {
  buildPrompt,
  buildDiffSummary,
  parseVerdict,
  estimateTokens,
  estimateCost,
  extractResponseText,
  callLLM,
  buildOpenAIRequest,
  buildAnthropicRequest,
  getDefaultModel,
  makeFinding,
  type LLMVerdict,
  type CostEstimate,
  type ProviderRequest,
  DEFAULT_TIMEOUT_MS,
  CHARS_PER_TOKEN,
  MAX_PATCH_CHARS_PER_FILE,
  MAX_DIFF_SUMMARY_CHARS,
};
