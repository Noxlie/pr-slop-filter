/**
 * @module heuristics
 * @description Heuristic detection engine for AI-generated PR content.
 *
 * Each detector returns a {@link Finding} with a score contribution (0-100).
 * All findings are aggregated into a single {@link ModuleResult} by
 * {@link analyzeHeuristics}, which is the module's public entry point.
 *
 * Detectors included:
 * 1. Perplexity Scorer — character-level entropy of PR text
 * 2. Emoji Density Detector — count of Unicode emoji in title + body
 * 3. AI Phrase Detector — regex patterns for common LLM phrases
 * 4. Commit Message Analyzer — length, conventional-commit ratio, typo heuristic
 * 5. Formatting Pattern Detector — unnaturally perfect markdown structure
 * 6. Account Age Checker — flags brand-new GitHub accounts
 */

import type {
  PRContext,
  ModuleResult,
  Finding,
  PhrasePattern,
  CommitInfo,
} from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Module identifier used in every Finding. */
const MODULE_ID = 'heuristics' as const;

/**
 * Entropy thresholds (bits per character).
 * English prose typically sits around 4.0–4.5 bpc.
 * AI-generated text tends to cluster tighter (3.2–3.8 bpc).
 * We map the range [2.5, 5.0] → score [100, 0].
 */
const ENTROPY_FLOOR = 2.5;
const ENTROPY_CEIL = 5.0;

/** Emoji count thresholds. */
const EMOJI_SUSPICIOUS = 3;
const EMOJI_FLAG = 7;

/** Account age thresholds (days). */
const ACCOUNT_AGE_FLAG = 30;

/** Commit message length threshold (characters) considered suspiciously long. */
const COMMIT_AVG_LENGTH_SUSPICIOUS = 50;

/**
 * Comprehensive set of AI-slop phrase patterns.
 * Each entry is a case-insensitive RegExp paired with a human-readable label,
 * a weight (0-1) reflecting how strongly it signals slop, and a category.
 */
const AI_PHRASE_PATTERNS: PhrasePattern[] = [
  // Intro / preamble patterns
  { pattern: /this\s+PR\s+aims\s+to/i, label: 'This PR aims to', weight: 0.8, category: 'intro' },
  { pattern: /here\s+is\s+a\s+comprehensive/i, label: 'Here is a comprehensive', weight: 0.9, category: 'intro' },
  { pattern: /the\s+following\s+changes\s+were\s+made/i, label: 'The following changes were made', weight: 0.85, category: 'intro' },
  { pattern: /this\s+PR\s+addresses/i, label: 'This PR addresses', weight: 0.7, category: 'intro' },
  { pattern: /please\s+review\s+the\s+following/i, label: 'Please review the following', weight: 0.75, category: 'intro' },
  { pattern: /i\s+have\s+implemented/i, label: 'I have implemented', weight: 0.7, category: 'intro' },
  { pattern: /this\s+pull\s+request\s+(introduces|adds|implements|fixes)/i, label: 'This pull request [verb]', weight: 0.75, category: 'intro' },
  { pattern: /in\s+this\s+PR[,.]?\s+(I|we)\s+(have|added|implemented|fixed|updated)/i, label: 'In this PR, I/we have…', weight: 0.7, category: 'intro' },

  // Filler / transition phrases
  { pattern: /it\s+is\s+worth\s+noting\s+that/i, label: 'It is worth noting that', weight: 0.8, category: 'filler' },
  { pattern: /as\s+per\s+the\s+(requirement|specification|issue)/i, label: 'As per the requirement', weight: 0.7, category: 'filler' },
  { pattern: /in\s+order\s+to/i, label: 'In order to', weight: 0.5, category: 'filler' },
  { pattern: /for\s+the\s+(purpose|sake)\s+of/i, label: 'For the purpose/sake of', weight: 0.6, category: 'filler' },
  { pattern: /at\s+this\s+point\s+in\s+time/i, label: 'At this point in time', weight: 0.7, category: 'filler' },
  { pattern: /due\s+to\s+the\s+fact\s+that/i, label: 'Due to the fact that', weight: 0.7, category: 'filler' },
  { pattern: /with\s+regard(s)?\s+to/i, label: 'With regard(s) to', weight: 0.6, category: 'filler' },
  { pattern: /leverage(d)?\s+(the\s+)?existing/i, label: 'Leveraged existing', weight: 0.75, category: 'filler' },

  // Structure / meta commentary
  { pattern: /##\s*(Summary|Changes|Description|Overview|Motivation|Testing)\s*\n/i, label: 'Standard H2 section header', weight: 0.6, category: 'structure' },
  { pattern: /###?\s*(Changes?\s+made|What\s+(I|was)\s+(changed|done)|Key\s+changes)/i, label: 'AI-style "Changes made" header', weight: 0.75, category: 'structure' },
  { pattern: /\*\*Key\s+(changes?|features?|improvements?)\*\*/i, label: '**Key changes/features**', weight: 0.7, category: 'structure' },
  { pattern: /-\s*(Added|Updated|Fixed|Removed|Refactored|Improved|Implemented)\s+[A-Z]/gm, label: 'Bullet list of past-tense verbs', weight: 0.65, category: 'structure' },
  { pattern: /```[\s\S]*?```\s*\n\s*```/m, label: 'Consecutive code blocks', weight: 0.5, category: 'structure' },
  { pattern: /this\s+(PR|change)\s+(also|additionally)\s+(includes?|contains?)/i, label: 'This PR also includes', weight: 0.7, category: 'structure' },
  { pattern: /(?:^|\n)\s*\d+\.\s+[A-Z][^\n]{20,}\n\s*\d+\.\s+[A-Z]/m, label: 'Numbered list with long items', weight: 0.55, category: 'structure' },

  // Emoji-heavy markers
  { pattern: /(?:🚀|✨|💡|🎯|🔥|🎉|✅|🛠|🔧|📦){2,}/u, label: 'Multiple decorative emojis in sequence', weight: 0.8, category: 'emoji' },
  { pattern: /(?:^|\n).*?(?:🚀|✨|💡|🎯|🔥).*(?:🚀|✨|💡|🎯|🔥)/mu, label: 'Multiple AI-favorite emojis in text', weight: 0.7, category: 'emoji' },

  // Closing / meta
  { pattern: /please\s+let\s+me\s+know\s+(if|your\s+thoughts)/i, label: 'Please let me know', weight: 0.5, category: 'meta' },
  { pattern: /looking\s+forward\s+to\s+(your\s+)?feedback/i, label: 'Looking forward to feedback', weight: 0.65, category: 'meta' },
  { pattern: /happy\s+to\s+(discuss|address|make\s+changes|iterate)/i, label: 'Happy to discuss/address', weight: 0.6, category: 'meta' },
  { pattern: /feel\s+free\s+to\s+(reach\s+out|comment|suggest)/i, label: 'Feel free to reach out', weight: 0.6, category: 'meta' },
  { pattern: /this\s+(is\s+)?(?:a\s+)?(?:significant|important|notable)\s+(improvement|enhancement|change|update)/i, label: 'Significant improvement/enhancement', weight: 0.7, category: 'meta' },
  { pattern: /resolves?\s+#\d+|closes?\s+#\d+|fixes?\s+#\d+/i, label: 'Auto-issue linking (resolves/closes/fixes #N)', weight: 0.3, category: 'meta' },
];

/**
 * Regex matching any Unicode emoji character.
 *
 * Covers:
 * - Miscellaneous Symbols and Pictographs (U+1F300–U+1F9FF)
 * - Supplemental Symbols and Pictographs (U+1FA00–U+1FA6F, U+1FA70–U+1FAFF)
 * - Emoticons (U+1F600–U+1F64F)
 * - Transport and Map Symbols (U+1F680–U+1F6FF)
 * - Miscellaneous Symbols (U+2600–U+26FF)
 * - Dingbats (U+2700–U+27BF)
 * - Enclosed Alphanumerics / Supplement (U+2460–U+24FF)
 * - Skin-tone modifiers (U+1F3FB–U+1F3FF)
 * - Variation Selectors (U+FE0F, U+FE0E)
 * - Zero-Width Joiner sequences (U+200D)
 * - Regional Indicator Symbols (U+1F1E6–U+1F1FF) — flags
 * - Keycap digits (U+0023, U+002A, U+0030–U+0039 + U+FE0F + U+20E3)
 * - Combining marks that follow emoji bases
 *
 * This is a broad "one or more emoji code-points" matcher.
 * It intentionally captures multi-codepoint emoji (ZWJ sequences, flags, keycaps)
 * as a single match by using a greedy quantifier over the character class.
 */
const EMOJI_REGEX =
  /(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(?:\u200D(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*/gu;

/**
 * Simplified emoji regex for counting individual emoji characters
 * (not ZWJ sequences — one per visual glyph).
 */
const EMOJI_CHAR_REGEX =
  /[\u{1F300}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2460}-\u{24FF}\u{1F1E6}-\u{1F1FF}]/gu;

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

/**
 * Clamp a numeric value to the [min, max] range.
 *
 * @param value - The value to clamp.
 * @param min   - Lower bound.
 * @param max   - Upper bound.
 * @returns The clamped value.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Linearly map a value from one range to another.
 *
 * @param value       - Input value.
 * @param inMin       - Input range minimum.
 * @param inMax       - Input range maximum.
 * @param outMin      - Output range minimum.
 * @param outMax      - Output range maximum.
 * @param clampResult - Whether to clamp the output to [outMin, outMax].
 * @returns Mapped value.
 */
function linearMap(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
  clampResult = true,
): number {
  const ratio = (value - inMin) / (inMax - inMin);
  const mapped = outMin + ratio * (outMax - outMin);
  return clampResult ? clamp(mapped, Math.min(outMin, outMax), Math.max(outMin, outMax)) : mapped;
}

/**
 * Count the number of emoji characters in a string.
 *
 * Uses the broad Unicode emoji range regex. Each distinct emoji
 * character (including skin-tone variants) counts as one; ZWJ
 * sequences are counted as one visual emoji.
 *
 * @param text - The text to scan.
 * @returns The number of emoji found.
 */
export function countEmojis(text: string): number {
  const matches = text.match(EMOJI_CHAR_REGEX);
  return matches ? matches.length : 0;
}

/**
 * Extract all emoji strings from text (preserving multi-codepoint sequences).
 *
 * @param text - The text to scan.
 * @returns Array of matched emoji strings.
 */
export function extractEmojis(text: string): string[] {
  const matches = text.match(EMOJI_REGEX);
  return matches ?? [];
}

/**
 * Compute the Shannon entropy (in bits per character) of a string
 * using character-level (unigram) frequency analysis.
 *
 * Higher entropy → more diverse / less predictable text → more likely human.
 * Lower entropy  → more uniform / repetitive → more likely AI.
 *
 * @param text - The text to analyze. Empty or single-char strings return 0.
 * @returns Entropy in bits per character.
 */
export function computeCharEntropy(text: string): number {
  if (text.length <= 1) return 0;

  const freq = new Map<string, number>();
  for (const ch of text) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }

  let entropy = 0;
  const len = text.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/**
 * Check if a commit message follows the Conventional Commits spec.
 *
 * Matches patterns like `feat:`, `fix(scope):`, `chore!:`, etc.
 *
 * @param message - A single commit message (first line only).
 * @returns `true` if the message matches conventional-commit format.
 */
function isConventionalCommit(message: string): boolean {
  return /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-zA-Z0-9_./-]+\))?!?:\s/.test(
    message.trim(),
  );
}

/**
 * Very simple "typo" heuristic.
 *
 * Returns `true` if the text likely contains a typo by looking for
 * common patterns: repeated letters (3+), common misspellings, and
 * obvious concatenation errors. This is intentionally conservative —
 * it will under-detect typos (low false-positive rate).
 *
 * @param text - Text to check.
 * @returns `true` if a probable typo is detected.
 */
function hasProbableTypo(text: string): boolean {
  const normalized = text.toLowerCase().trim();

  // Repeated characters: "commmit", "fiix", "helllo"
  if (/(.)\1{2,}/.test(normalized)) return true;

  // Common misspellings in commit messages
  const commonTypos = [
    /refact?ro/,   // refactro, refractor
    /implment/,    // implment
    /udpate/,      // udpate
    /adn\s/,       // adn (and)
    /teh\s/,       // teh (the)
    /recieve/,     // recieve
    /occured/,     // occured
    /seperat/,     // seperat
    /dependancy/,  // dependancy
    /compatable/,  // compatable
    /neccessary/,  // neccessary
    /sucessful/,   // sucessful
    /immediatly/,  // immediatly
  ];

  return commonTypos.some((re) => re.test(normalized));
}

/**
 * Determine the severity level for a given score contribution.
 *
 * @param score - Score contribution (0-100).
 * @returns Severity classification.
 */
function scoreToSeverity(score: number): Finding['severity'] {
  if (score >= 60) return 'flag';
  if (score >= 30) return 'warning';
  return 'info';
}

// ---------------------------------------------------------------------------
// Individual detectors
// ---------------------------------------------------------------------------

/**
 * **Perplexity Scorer** — measure text uniformity via character-level entropy.
 *
 * AI-generated writing tends to have lower entropy (more statistically uniform)
 * than human writing. We compute Shannon entropy of character unigrams and
 * map the result to a 0–100 slop score.
 *
 * | Entropy (bpc) | Interpretation       | Score |
 * |---------------|----------------------|-------|
 * | < 3.0         | Very likely AI       | ~85   |
 * | 3.0–3.8       | Suspicious           | ~60   |
 * | 3.8–4.5       | Normal human range   | ~25   |
 * | > 4.5         | Very human           | ~5    |
 *
 * @param title - PR title.
 * @param body  - PR body / description.
 * @returns A Finding with the entropy score.
 */
export function detectPerplexity(title: string, body: string): Finding {
  const combined = `${title}\n${body}`;
  // Strip markdown formatting to get raw prose
  const prose = combined
    .replace(/```[\s\S]*?```/g, ' ')  // remove code blocks
    .replace(/`[^`]+`/g, ' ')         // inline code
    .replace(/#{1,6}\s+/g, '')        // heading markers
    .replace(/[*_~]+/g, '')           // emphasis markers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links → text
    .replace(/https?:\/\/\S+/g, '')   // bare URLs
    .replace(/\s+/g, ' ')
    .trim();

  if (prose.length < 50) {
    return {
      id: 'heuristics:perplexity',
      module: MODULE_ID,
      severity: 'info',
      message: 'Perplexity scorer: text too short for reliable analysis',
      detail: `Only ${prose.length} characters of prose (need ≥50). Skipping.`,
      score: 10, // Low contribution for very short text
    };
  }

  const entropy = computeCharEntropy(prose);
  // Map entropy [ENTROPY_FLOOR, ENTROPY_CEIL] → score [100, 0] (inverted)
  const score = Math.round(linearMap(entropy, ENTROPY_FLOOR, ENTROPY_CEIL, 100, 0));

  return {
    id: 'heuristics:perplexity',
    module: MODULE_ID,
    severity: scoreToSeverity(score),
    message: `Character entropy: ${entropy.toFixed(2)} bpc (low entropy suggests AI)`,
    detail: [
      `Text length: ${prose.length} characters`,
      `Unique characters: ${new Set(prose).size}`,
      `Entropy: ${entropy.toFixed(3)} bits/char`,
      `Score mapping: ${entropy.toFixed(2)} bpc → ${score}/100`,
    ].join('\n'),
    score,
  };
}

/**
 * **Emoji Density Detector** — count emojis in PR title + body.
 *
 * AI-generated content (especially from LLMs) tends to overuse decorative
 * emojis like 🚀✨💡🎯🔥. We count all emoji characters and map to a score.
 *
 * | Count | Interpretation     | Score |
 * |-------|--------------------|-------|
 * | 0     | Clean              | 0     |
 * | 1–3   | Normal             | 10    |
 * | 4–7   | Suspicious         | 40    |
 * | 8–15  | Flag               | 70    |
 * | >15   | Definite slop      | 95    |
 *
 * @param title - PR title.
 * @param body  - PR body.
 * @returns A Finding with emoji density analysis.
 */
export function detectEmojiDensity(title: string, body: string): Finding {
  const combined = `${title} ${body}`;
  const count = countEmojis(combined);
  const found = extractEmojis(combined);

  let score: number;
  if (count === 0) score = 0;
  else if (count <= EMOJI_SUSPICIOUS) score = 10;
  else if (count <= EMOJI_FLAG) score = 40;
  else if (count <= 15) score = 70;
  else score = 95;

  const sample = found.slice(0, 10).join(' ');
  const suffix = found.length > 10 ? ` …and ${found.length - 10} more` : '';

  return {
    id: 'heuristics:emoji-density',
    module: MODULE_ID,
    severity: scoreToSeverity(score),
    message: `Found ${count} emoji${count !== 1 ? 's' : ''} in PR text`,
    detail: [
      `Emoji count: ${count}`,
      count > EMOJI_FLAG ? 'Exceeds flag threshold (>7)' : count > EMOJI_SUSPICIOUS ? 'Exceeds suspicious threshold (>3)' : 'Within normal range',
      count > 0 ? `Sample: ${sample}${suffix}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    score,
  };
}

/**
 * **AI Phrase Detector** — regex matching against 30+ known AI-slop phrases.
 *
 * Returns a Finding whose score is the weighted sum of matched patterns,
 * normalized to 0–100. Multiple matches accumulate but are capped.
 *
 * @param title - PR title.
 * @param body  - PR body.
 * @returns A Finding listing all matched AI phrases.
 */
export function detectAIPhrases(title: string, body: string): Finding {
  const combined = `${title}\n${body}`;
  const matches: Array<{ label: string; weight: number; category: string }> = [];

  for (const { pattern, label, weight, category } of AI_PHRASE_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    if (pattern.test(combined)) {
      matches.push({ label, weight, category });
    }
  }

  if (matches.length === 0) {
    return {
      id: 'heuristics:ai-phrases',
      module: MODULE_ID,
      severity: 'info',
      message: 'No AI-slop phrases detected',
      detail: `Scanned against ${AI_PHRASE_PATTERNS.length} patterns. None matched.`,
      score: 0,
    };
  }

  // Compute weighted score: each match contributes its weight, diminishing returns
  // after the first few matches (logarithmic scaling)
  const rawWeight = matches.reduce((sum, m) => sum + m.weight, 0);
  const maxPossibleWeight = AI_PHRASE_PATTERNS.reduce((sum, p) => sum + p.weight, 0);
  // Use logarithmic dampening: first matches matter most
  const dampened = Math.log2(1 + rawWeight) / Math.log2(1 + maxPossibleWeight);
  const score = Math.round(clamp(dampened * 100, 0, 100));

  const byCategory = matches.reduce<Record<string, string[]>>((acc, m) => {
    (acc[m.category] ??= []).push(m.label);
    return acc;
  }, {});

  const detailLines = [
    `Matched ${matches.length}/${AI_PHRASE_PATTERNS.length} AI phrase patterns`,
    `Combined weight: ${rawWeight.toFixed(2)} / ${maxPossibleWeight.toFixed(2)}`,
    '',
    'Matches by category:',
    ...Object.entries(byCategory).map(
      ([cat, labels]) => `  [${cat}] ${labels.join(', ')}`,
    ),
  ];

  return {
    id: 'heuristics:ai-phrases',
    module: MODULE_ID,
    severity: scoreToSeverity(score),
    message: `Detected ${matches.length} AI-slop phrase${matches.length !== 1 ? 's' : ''} in PR text`,
    detail: detailLines.join('\n'),
    score,
  };
}

/**
 * **Commit Message Analyzer** — flags suspiciously well-formatted commit messages.
 *
 * Three sub-checks:
 * 1. **Average length** — AI commits tend to be consistently long and descriptive.
 * 2. **Conventional commit ratio** — if 100% of commits follow Conventional Commits
 *    exactly, that's suspicious (humans are messy).
 * 3. **Zero typos** — if every commit message passes a simple typo check with
 *    flying colors, it may be AI-generated.
 *
 * Each sub-check contributes to the overall finding score.
 *
 * @param commits - Array of commit info objects.
 * @returns A Finding with commit analysis details.
 */
export function detectCommitAnomalies(commits: CommitInfo[]): Finding {
  if (commits.length === 0) {
    return {
      id: 'heuristics:commit-analysis',
      module: MODULE_ID,
      severity: 'info',
      message: 'No commits to analyze',
      detail: 'The PR has no commit data available.',
      score: 0,
    };
  }

  const messages = commits.map((c) => c.message);
  const firstLines = messages.map((m) => m.split('\n')[0].trim());

  // Sub-check 1: Average commit message length
  const avgLength = firstLines.reduce((sum, m) => sum + m.length, 0) / firstLines.length;
  const lengthScore = Math.round(
    clamp(linearMap(avgLength, 20, COMMIT_AVG_LENGTH_SUSPICIOUS * 2, 0, 80), 0, 80),
  );

  // Sub-check 2: Conventional commit ratio
  const conventionalCount = firstLines.filter(isConventionalCommit).length;
  const conventionalRatio = conventionalCount / commits.length;
  // 100% conventional is suspicious; 70-100% range maps to score
  const conventionalScore =
    conventionalRatio >= 1.0 && commits.length >= 3
      ? 60 // All commits are conventional AND there are ≥3 — very suspicious
      : conventionalRatio >= 0.8 && commits.length >= 3
        ? 35
        : 0;

  // Sub-check 3: Typo heuristic — zero typos across all messages
  const typoCount = messages.filter(hasProbableTypo).length;
  // If no typos detected and enough commits to matter, it's mildly suspicious
  const typoScore = typoCount === 0 && commits.length >= 5 ? 30 : 0;

  // Aggregate: take the max of the three sub-scores, plus a small bonus
  // if multiple flags fire together
  const flagsTriggered = [lengthScore > 20, conventionalScore > 0, typoScore > 0].filter(
    Boolean,
  ).length;
  const multiFlagBonus = flagsTriggered >= 2 ? 15 : 0;

  const score = clamp(
    Math.max(lengthScore, conventionalScore, typoScore) + multiFlagBonus,
    0,
    100,
  );

  return {
    id: 'heuristics:commit-analysis',
    module: MODULE_ID,
    severity: scoreToSeverity(score),
    message: `Commit messages show ${flagsTriggered} suspicious pattern${flagsTriggered !== 1 ? 's' : ''}`,
    detail: [
      `Commits analyzed: ${commits.length}`,
      `Average first-line length: ${avgLength.toFixed(0)} chars (threshold: ${COMMIT_AVG_LENGTH_SUSPICIOUS}) → score ${lengthScore}`,
      `Conventional commits: ${conventionalCount}/${commits.length} (${(conventionalRatio * 100).toFixed(0)}%) → score ${conventionalScore}`,
      `Typo detected: ${typoCount > 0 ? `yes (${typoCount})` : 'none'} → score ${typoScore}`,
      `Multi-flag bonus: +${multiFlagBonus}`,
      `Final score: ${score}`,
    ].join('\n'),
    score,
  };
}

/**
 * **Formatting Pattern Detector** — detects unnaturally perfect markdown.
 *
 * AI-generated PR descriptions tend to have:
 * - Consistent heading hierarchy (H2 → H3, no skipped levels)
 * - Well-structured bullet lists with consistent markers
 * - Code blocks with language annotations
 * - Balanced section lengths
 * - No informal elements (no inline typos, no casual tone markers)
 *
 * Returns a Finding scoring structural perfection.
 *
 * @param body - PR body / description markdown.
 * @returns A Finding with formatting analysis.
 */
export function detectFormattingPatterns(body: string): Finding {
  if (!body || body.trim().length < 20) {
    return {
      id: 'heuristics:formatting',
      module: MODULE_ID,
      severity: 'info',
      message: 'PR body too short for formatting analysis',
      detail: `Body length: ${body?.length ?? 0} characters. Skipping.`,
      score: 0,
    };
  }

  const lines = body.split('\n');
  const signals: Array<{ name: string; score: number; detail: string }> = [];

  // Signal 1: Consistent heading hierarchy
  const headings = lines
    .map((line, i) => ({ level: /^(#{1,6})\s/.exec(line)?.[1].length, line: line.trim(), index: i }))
    .filter((h): h is { level: number; line: string; index: number } => h.level !== undefined);

  if (headings.length >= 2) {
    const levels = headings.map((h) => h.level);
    // Check for perfect sequential hierarchy (no skipped levels, ascending order)
    let hierarchyPerfect = true;
    for (let i = 1; i < levels.length; i++) {
      if (levels[i] > levels[i - 1] + 1) {
        hierarchyPerfect = false;
        break;
      }
    }
    const allSameLevel = new Set(levels).size === 1;
    if (hierarchyPerfect && levels.length >= 3) {
      signals.push({
        name: 'Perfect heading hierarchy',
        score: 30,
        detail: `${headings.length} headings in perfect order: ${levels.map((l) => '#'.repeat(l)).join(' → ')}`,
      });
    } else if (allSameLevel && levels.length >= 3) {
      signals.push({
        name: 'Uniform heading level',
        score: 15,
        detail: `All ${headings.length} headings are ${'#'.repeat(levels[0])} — suspiciously consistent`,
      });
    }
  }

  // Signal 2: Bullet list consistency
  const bulletLines = lines.filter((l) => /^\s*[-*+]\s/.test(l));
  if (bulletLines.length >= 3) {
    const markers = bulletLines.map((l) => l.match(/^\s*([-*+])/)?.[1]);
    const uniqueMarkers = new Set(markers).size;
    if (uniqueMarkers === 1) {
      signals.push({
        name: 'Perfectly consistent bullet markers',
        score: 20,
        detail: `All ${bulletLines.length} bullet items use "${markers[0]}" — no mixing`,
      });
    }
  }

  // Signal 3: Code blocks with language annotations
  const codeBlocks = body.match(/```\w+/g) ?? [];
  const totalCodeBlocks = (body.match(/```/g) ?? []).length / 2;
  if (totalCodeBlocks >= 2 && codeBlocks.length === Math.floor(totalCodeBlocks)) {
    signals.push({
      name: 'All code blocks annotated',
      score: 15,
      detail: `All ${Math.floor(totalCodeBlocks)} code blocks have language specifiers`,
    });
  }

  // Signal 4: Balanced section lengths
  if (headings.length >= 3) {
    const sectionLengths: number[] = [];
    for (let i = 0; i < headings.length; i++) {
      const start = headings[i].index;
      const end = i + 1 < headings.length ? headings[i + 1].index : lines.length;
      sectionLengths.push(end - start);
    }
    const avg = sectionLengths.reduce((a, b) => a + b, 0) / sectionLengths.length;
    const maxDeviation = Math.max(...sectionLengths.map((l) => Math.abs(l - avg)));
    // If no section deviates more than 40% from average → suspicious
    if (maxDeviation / avg < 0.4 && sectionLengths.length >= 3) {
      signals.push({
        name: 'Uniform section lengths',
        score: 25,
        detail: `Sections vary by ≤${((maxDeviation / avg) * 100).toFixed(0)}% from mean (${avg.toFixed(1)} lines). Range: ${Math.min(...sectionLengths)}–${Math.max(...sectionLengths)}`,
      });
    }
  }

  // Signal 5: Presence of a summary section
  if (/^#{1,3}\s*(summary|overview|description|motivation)/im.test(body)) {
    signals.push({
      name: 'Has summary section header',
      score: 10,
      detail: 'Detected standard summary/overview section header',
    });
  }

  // Signal 6: Structured list of changes (common AI pattern)
  const changeListPattern =
    /(?:^|\n)#{1,3}\s*(?:changes|what\s+(?:was\s+)?(?:changed|done)|key\s+(?:changes|features|updates))\s*\n(?:\s*[-*]\s+.+\n){2,}/im;
  if (changeListPattern.test(body)) {
    signals.push({
      name: 'Structured changes list',
      score: 20,
      detail: 'Body contains a heading followed by a structured bullet list of changes',
    });
  }

  // Signal 7: Perfect markdown — no raw text without structure
  const structuredLines = lines.filter(
    (l) =>
      /^\s*$/.test(l) || // blank
      /^#{1,6}\s/.test(l) || // heading
      /^\s*[-*+]\s/.test(l) || // bullet
      /^\s*\d+\.\s/.test(l) || // numbered list
      /^```/.test(l) || // code fence
      /^\s*>/.test(l) || // blockquote
      /\|.*\|/.test(l) || // table row
      /^---/.test(l), // horizontal rule
  );
  const structureRatio = structuredLines.length / Math.max(lines.length, 1);
  if (structureRatio > 0.7 && lines.length >= 10) {
    signals.push({
      name: 'Highly structured text',
      score: 25,
      detail: `${(structureRatio * 100).toFixed(0)}% of lines are structured markdown elements (${structuredLines.length}/${lines.length} lines)`,
    });
  }

  const totalScore = clamp(
    signals.reduce((sum, s) => sum + s.score, 0),
    0,
    100,
  );

  if (signals.length === 0) {
    return {
      id: 'heuristics:formatting',
      module: MODULE_ID,
      severity: 'info',
      message: 'No suspicious formatting patterns detected',
      detail: 'PR body formatting appears natural.',
      score: 0,
    };
  }

  return {
    id: 'heuristics:formatting',
    module: MODULE_ID,
    severity: scoreToSeverity(totalScore),
    message: `Detected ${signals.length} suspicious formatting pattern${signals.length !== 1 ? 's' : ''}`,
    detail: [
      `Formatting signals detected: ${signals.length}`,
      '',
      ...signals.map((s) => `  [${s.score}] ${s.name}: ${s.detail}`),
      '',
      `Total formatting score: ${totalScore}`,
    ].join('\n'),
    score: totalScore,
  };
}

/**
 * **Account Age Checker** — flags authors with recently created GitHub accounts.
 *
 * New accounts (< 30 days old) are a strong signal of drive-by AI slop,
 * especially when combined with other indicators.
 *
 * @param authorAccountAgeDays - Account age in days, or `undefined` if unknown.
 * @param author               - Author username (for messaging).
 * @returns A Finding with account age analysis.
 */
export function detectAccountAge(
  authorAccountAgeDays: number | undefined,
  author: string,
): Finding {
  if (authorAccountAgeDays === undefined) {
    return {
      id: 'heuristics:account-age',
      module: MODULE_ID,
      severity: 'info',
      message: `Account age for @${author} is unknown`,
      detail: 'No account age data available. Skipping this check.',
      score: 0,
    };
  }

  let score: number;
  let severity: Finding['severity'];

  if (authorAccountAgeDays < 7) {
    score = 85;
    severity = 'flag';
  } else if (authorAccountAgeDays < ACCOUNT_AGE_FLAG) {
    score = 60;
    severity = 'warning';
  } else if (authorAccountAgeDays < 90) {
    score = 15;
    severity = 'info';
  } else {
    score = 0;
    severity = 'info';
  }

  return {
    id: 'heuristics:account-age',
    module: MODULE_ID,
    severity,
    message: `@${author}'s account is ${authorAccountAgeDays} day${authorAccountAgeDays !== 1 ? 's' : ''} old`,
    detail: [
      `Account age: ${authorAccountAgeDays} days`,
      authorAccountAgeDays < ACCOUNT_AGE_FLAG
        ? `Below ${ACCOUNT_AGE_FLAG}-day threshold — suspicious`
        : 'Account age is within normal range',
      `Score contribution: ${score}`,
    ].join('\n'),
    score,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run all heuristic detectors against a PR context and aggregate results.
 *
 * This is the module's public entry point. It executes every detector,
 * collects their findings, and computes an aggregate score. The final
 * score is a weighted average of individual finding scores (not just the
 * max), giving a more nuanced overall picture.
 *
 * @param pr - The PR context containing title, body, author, commits, etc.
 * @returns A {@link ModuleResult} with the aggregate score and all findings.
 *
 * @example
 * ```ts
 * import { analyzeHeuristics } from './heuristics/index.js';
 * const result = analyzeHeuristics(prContext);
 * console.log(result.score, result.findings.length);
 * ```
 */
export function analyzeHeuristics(pr: PRContext): ModuleResult {
  const t0 = performance.now();

  const findings: Finding[] = [
    detectPerplexity(pr.title, pr.body),
    detectEmojiDensity(pr.title, pr.body),
    detectAIPhrases(pr.title, pr.body),
    detectCommitAnomalies(pr.commits),
    detectFormattingPatterns(pr.body),
    detectAccountAge(pr.author_account_age_days, pr.author),
  ];

  // Aggregate score: weighted average.
  // Weights reflect how reliable each detector is on its own.
  const weights: Record<string, number> = {
    'heuristics:perplexity': 1.0,
    'heuristics:emoji-density': 0.7,
    'heuristics:ai-phrases': 1.2, // Strongest signal — phrase matching is very reliable
    'heuristics:commit-analysis': 0.9,
    'heuristics:formatting': 0.8,
    'heuristics:account-age': 0.6,
  };

  let weightedSum = 0;
  let totalWeight = 0;

  for (const finding of findings) {
    const w = weights[finding.id] ?? 1.0;
    weightedSum += finding.score * w;
    totalWeight += w;
  }

  const aggregateScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

  const duration_ms = Math.round(performance.now() - t0);

  return {
    module: MODULE_ID,
    score: clamp(aggregateScore, 0, 100),
    findings,
    duration_ms,
  };
}
