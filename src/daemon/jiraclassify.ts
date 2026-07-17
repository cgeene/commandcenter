import { execFile } from "node:child_process";
import { claudeBin } from "../config.js";

/**
 * Creation classifier — decision 7, "LLM proposes, daemon disposes."
 *
 * A NEW lightweight one-shot primitive: a headless `claude -p`-style call with a
 * cheap model, NO worktree / tmux window / agent row. It receives the task
 * title/prompt/repo plus the config allow-lists and returns a strict-JSON
 * proposal `{project, issue_type}`. It is ONLY a proposal — the daemon
 * (jirasync.ts) validates the output against the allow-list and does the JIRA
 * API call itself. The classifier NEVER calls the JIRA API.
 *
 * It is an enhancement layer, never a dependency: ANY failure/timeout/invalid/
 * out-of-list output returns null, and the daemon falls back to the per-repo
 * default project + "Task". Testability follows the injected-runner seam.
 */

export interface ClassifierInput {
  title: string;
  prompt: string;
  repo: string;
  /** Allow-list of valid project keys the model may choose from. */
  projects: string[];
  /** Allow-list of valid issue type names the model may choose from. */
  issueTypes: string[];
  /** Cheap model id from JiraConfig.classifier_model. */
  model: string;
}

export interface ClassifierProposal {
  project: string;
  issue_type: string;
}

/** The one-shot model call. Returns raw stdout. Injectable so tests never shell
 *  out to `claude`. */
export type ClassifierRunner = (opts: {
  model: string;
  prompt: string;
  timeoutMs: number;
}) => Promise<string>;

const CLASSIFY_TIMEOUT_MS = 30_000;
const PROMPT_CHARS = 2000;

function defaultRunner(opts: {
  model: string;
  prompt: string;
  timeoutMs: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      claudeBin(),
      ["-p", opts.prompt, "--model", opts.model],
      { timeout: opts.timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) =>
        err ? reject(new Error(stderr?.trim() || err.message)) : resolve(stdout),
    );
  });
}

let runClassifier: ClassifierRunner = defaultRunner;

/** Test seam: swap the one-shot runner (pass null to restore the real one). */
export function _setClassifierRunner(fn: ClassifierRunner | null): void {
  runClassifier = fn ?? defaultRunner;
}

export function buildClassifierPrompt(input: ClassifierInput): string {
  return [
    "You are triaging a software task into a JIRA ticket. Choose the single best",
    "project key and issue type from the provided allow-lists.",
    "",
    `Repo: ${input.repo}`,
    `Title: ${input.title}`,
    `Task description (truncated):`,
    input.prompt.slice(0, PROMPT_CHARS),
    "",
    `Allowed project keys: ${JSON.stringify(input.projects)}`,
    `Allowed issue types: ${JSON.stringify(input.issueTypes)}`,
    "",
    "Respond with ONLY a JSON object and nothing else, in exactly this shape:",
    '{"project": "<one of the allowed project keys>", "issue_type": "<one of the allowed issue types>"}',
  ].join("\n");
}

/** Extract the first JSON object from model output and validate its shape.
 *  Returns null on anything unparseable or malformed — the deterministic
 *  fallback is the daemon's job. */
export function parseClassifierOutput(raw: string): ClassifierProposal | null {
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.project !== "string" || typeof obj.issue_type !== "string") {
    return null;
  }
  const project = obj.project.trim();
  const issue_type = obj.issue_type.trim();
  if (!project || !issue_type) return null;
  return { project, issue_type };
}

/**
 * Ask the classifier for a {project, issue_type} proposal. Returns null on any
 * failure, timeout, or malformed output — the caller then applies the
 * deterministic default. The returned proposal is NOT yet validated against the
 * allow-list; that (and the fallback) is the daemon's responsibility.
 */
export async function classifyTicket(
  input: ClassifierInput,
): Promise<ClassifierProposal | null> {
  try {
    const raw = await runClassifier({
      model: input.model,
      prompt: buildClassifierPrompt(input),
      timeoutMs: CLASSIFY_TIMEOUT_MS,
    });
    return parseClassifierOutput(raw);
  } catch {
    return null;
  }
}
