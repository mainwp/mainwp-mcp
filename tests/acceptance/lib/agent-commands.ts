/**
 * Plugin slash-command evidence for the agent acceptance harness.
 *
 * A command scenario types `/mainwp:<name>` as its prompt, which is only worth
 * grading if the CLI registered that command and expanded it. Registration is
 * the same in every CLI version seen so far: the `system`/`init` event's
 * `slash_commands` array names the command. Expansion has two shapes.
 *
 * Claude Code 2.1.220 recorded it in the stream, as a synthetic tool_result at
 * the start of the conversation: either the literal string
 * `Launching skill: mainwp:<name>`, or a content array carrying
 * `tool_reference` blocks when the command body names tools.
 *
 * Claude Code 2.1.221 writes neither. The stream's first content event is an
 * assistant turn already following the command, so the expansion is only
 * visible in the CLI's own session file, which pairs a user record tagged
 * `<command-name>/mainwp:<name></command-name>` with the expanded command body.
 *
 * Without one of those shapes the run graded an ordinary prompt rather than the
 * command, which is the failure this evidence exists to catch.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AgentCommandEvidence {
  /** The session advertised the command in its slash-command list. */
  registered: boolean;
  /** The transcript carried the command-expansion marker. */
  launched: boolean;
  /**
   * An assistant turn has been seen. A tool_reference block carries no command
   * identity, so it only counts as the start-of-conversation expansion while
   * this is still false; the literal marker names its command and counts
   * anywhere.
   */
  assistantSeen: boolean;
  /** The session the CLI reported, which names its session file. */
  sessionId?: string;
}

function contentBlocks(event: Record<string, unknown>): unknown[] {
  const message = event.message;
  if (!message || typeof message !== 'object') return [];
  const content = (message as Record<string, unknown>).content;
  return Array.isArray(content) ? content : [];
}

/**
 * True when `text` carries the marker for exactly this command: command names
 * use word characters and hyphens, so the character after the name must not
 * extend it or `mainwp:site-report` would claim `mainwp:site-report-extra`'s
 * launch.
 */
function textCarriesMarker(text: string, commandName: string): boolean {
  const marker = `Launching skill: ${commandName}`;
  for (let index = text.indexOf(marker); index !== -1; index = text.indexOf(marker, index + 1)) {
    const next = text.charAt(index + marker.length);
    if (next === '' || !/[\w-]/.test(next)) return true;
  }
  return false;
}

function isLaunchMarker(content: unknown, commandName: string, assistantSeen: boolean): boolean {
  if (typeof content === 'string') return textCarriesMarker(content, commandName);
  if (!Array.isArray(content)) return false;
  return content.some(block => {
    if (typeof block === 'string') return textCarriesMarker(block, commandName);
    if (!block || typeof block !== 'object') return false;
    const item = block as Record<string, unknown>;
    if (item.type === 'tool_reference') return !assistantSeen;
    return typeof item.text === 'string' && textCarriesMarker(item.text, commandName);
  });
}

/** Fold one stream-json event into the running command evidence. */
export function collectCommandEvidence(
  event: unknown,
  evidence: AgentCommandEvidence,
  commandName: string
): void {
  if (!event || typeof event !== 'object') return;
  const record = event as Record<string, unknown>;
  if (record.type === 'system') {
    if (
      Array.isArray(record.slash_commands) &&
      record.slash_commands.some(command => command === commandName)
    ) {
      evidence.registered = true;
    }
    if (typeof record.session_id === 'string') evidence.sessionId = record.session_id;
  }
  for (const block of contentBlocks(record)) {
    if (!block || typeof block !== 'object') continue;
    const item = block as Record<string, unknown>;
    if (item.type !== 'tool_result') continue;
    if (isLaunchMarker(item.content, commandName, evidence.assistantSeen)) evidence.launched = true;
  }
  if (record.type === 'assistant') evidence.assistantSeen = true;
}

/** A session line this long is a large tool result, not the command expansion. */
const SESSION_LINE_MAX_CHARS = 200_000;
/** The file is read whole, so a runaway session is skipped rather than loaded. */
const SESSION_FILE_MAX_BYTES = 32 * 1024 * 1024;
/** Shorter body lines turn up in ordinary prose and identify nothing. */
const BODY_LINE_MIN_CHARS = 40;
/** More than one, so an argument-carrying line cannot exhaust the candidates. */
const BODY_LINE_CANDIDATES = 5;
/** The CLI names each session file after its session id, and nothing else is one. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The CLI's session file for `sessionId`.
 *
 * The file lives under a directory named for the slugified cwd, which is the
 * CLI's rule to change; session ids are unique, so this searches for the file
 * name instead of reproducing that rule.
 */
function sessionFilePath(sessionId: string, env: NodeJS.ProcessEnv): string | undefined {
  if (!SESSION_ID_PATTERN.test(sessionId)) return undefined;
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  const projects = path.join(
    configured && configured.length > 0 ? configured : path.join(os.homedir(), '.claude'),
    'projects'
  );
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projects, entry.name, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Lines of the command body distinctive enough to prove the plugin's own copy
 * was expanded. Frontmatter never reaches the session file, and a line holding
 * `$ARGUMENTS` arrives substituted, so both are skipped.
 */
function commandBodyLines(commandFile: string): string[] {
  let markdown: string;
  try {
    markdown = fs.readFileSync(commandFile, 'utf8');
  } catch {
    return [];
  }
  const lines = markdown.split(/\r?\n/);
  let index = 0;
  if (lines[0]?.trim() === '---') {
    index = 1;
    while (index < lines.length && lines[index]?.trim() !== '---') index += 1;
    index += 1;
  }
  const candidates: string[] = [];
  for (; index < lines.length && candidates.length < BODY_LINE_CANDIDATES; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (line.length > BODY_LINE_MIN_CHARS && !line.includes('$')) candidates.push(line);
  }
  return candidates;
}

function sessionRecordTexts(record: Record<string, unknown>): string[] {
  const message = record.message;
  if (!message || typeof message !== 'object') return [];
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      texts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    const text = (block as Record<string, unknown>).text;
    if (typeof text === 'string') texts.push(text);
  }
  return texts;
}

/**
 * Fold the CLI's own session file into the evidence, for the CLI versions that
 * keep the expansion out of the stream.
 *
 * The file is another machine's output: a missing, oversized, or malformed one
 * leaves the evidence untouched, which classifies the run exactly as a missing
 * in-stream marker does.
 */
export function collectSessionExpansion(
  evidence: AgentCommandEvidence,
  commandName: string,
  commandFile: string,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (evidence.launched || !evidence.sessionId) return;
  const file = sessionFilePath(evidence.sessionId, env);
  if (!file) return;
  const bodyLines = commandBodyLines(commandFile);
  if (bodyLines.length === 0) return;
  let contents: string;
  try {
    if (fs.statSync(file).size > SESSION_FILE_MAX_BYTES) return;
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const tag = `<command-name>/${commandName}</command-name>`;
  let named = false;
  let expanded = false;
  for (const line of contents.split(/\r?\n/)) {
    if (line.length === 0 || line.length > SESSION_LINE_MAX_CHARS) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    const texts = sessionRecordTexts(record as Record<string, unknown>);
    if (texts.length === 0) continue;
    if (!named && (record as Record<string, unknown>).type === 'user') {
      named = texts.some(text => text.includes(tag));
    }
    // Which record carries the body is CLI detail the evidence does not need to
    // pin down; the tag above is what ties the expansion to this command.
    if (!expanded) expanded = texts.some(text => bodyLines.some(body => text.includes(body)));
    if (named && expanded) {
      evidence.launched = true;
      return;
    }
  }
}

/**
 * True when the command was not both registered and expanded. Registration
 * alone would let a typo'd command name be graded as a plain prompt, and an
 * expansion marker alone would mean the command came from somewhere other than
 * the plugin directory under test.
 */
export function commandNotLoaded(evidence: AgentCommandEvidence): boolean {
  return !evidence.registered || !evidence.launched;
}
