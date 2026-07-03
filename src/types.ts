/**
 * Core types for pr-slop-filter
 * All detection modules implement these interfaces
 */

/** A single finding from a detection module */
export interface Finding {
  id: string;
  module: 'heuristics' | 'diff-analysis' | 'llm-verifier';
  severity: 'info' | 'warning' | 'flag';
  message: string;
  detail?: string;
  score: number; // 0-100 contribution to overall slop score
}

/** Result from a detection module */
export interface ModuleResult {
  module: string;
  score: number; // 0-100 (0 = definitely human, 100 = definitely slop)
  findings: Finding[];
  duration_ms: number;
}

/** PR metadata passed to detection modules */
export interface PRContext {
  owner: string;
  repo: string;
  pr_number: number;
  title: string;
  body: string;
  author: string;
  author_account_age_days?: number;
  commits: CommitInfo[];
  files_changed: FileChange[];
  labels?: string[];
  base_branch: string;
  head_branch: string;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
}

/** Final verdict */
export interface SlopReport {
  pr: {
    owner: string;
    repo: string;
    number: number;
    title: string;
    url: string;
  };
  overall_score: number; // 0-100
  verdict: 'human' | 'uncertain' | 'likely-slop' | 'slop';
  confidence: number; // 0-100
  modules: ModuleResult[];
  summary: string;
  timestamp: string;
}

/** Configuration for the filter */
export interface FilterConfig {
  threshold: number; // 0-100, default 70
  fail_on_slop: boolean;
  llm_provider?: 'openai' | 'anthropic' | 'local';
  llm_api_key?: string;
  llm_base_url?: string;
  llm_model?: string;
  github_token?: string;
  verbose: boolean;
  format: 'text' | 'json' | 'github-annotation';
}

/** AI phrase pattern with metadata */
export interface PhrasePattern {
  pattern: RegExp;
  label: string;
  weight: number; // 0-1 how much this contributes to slop score
  category: 'intro' | 'filler' | 'emoji' | 'structure' | 'meta';
}
