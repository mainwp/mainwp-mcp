/**
 * Plugin slash-command evidence for the agent acceptance harness.
 *
 * A command scenario types `/mainwp:<name>` as its prompt, which is only worth
 * grading if the CLI registered that command and expanded it. Claude Code
 * 2.1.220 advertises plugin commands on the `system`/`init` event's
 * `slash_commands` array and records the expansion as a synthetic tool_result
 * at the start of the conversation: either the literal string
 * `Launching skill: mainwp:<name>`, or a content array carrying
 * `tool_reference` blocks when the command body names tools. Without both
 * signals the run graded an ordinary prompt rather than the command, which is
 * the failure this evidence exists to catch.
 */

export interface AgentCommandEvidence {
  /** The session advertised the command in its slash-command list. */
  registered: boolean;
  /** The transcript carried the command-expansion marker. */
  launched: boolean;
}

function contentBlocks(event: Record<string, unknown>): unknown[] {
  const message = event.message;
  if (!message || typeof message !== 'object') return [];
  const content = (message as Record<string, unknown>).content;
  return Array.isArray(content) ? content : [];
}

function isLaunchMarker(content: unknown, commandName: string): boolean {
  const marker = `Launching skill: ${commandName}`;
  if (typeof content === 'string') return content.includes(marker);
  if (!Array.isArray(content)) return false;
  return content.some(block => {
    if (typeof block === 'string') return block.includes(marker);
    if (!block || typeof block !== 'object') return false;
    const item = block as Record<string, unknown>;
    if (item.type === 'tool_reference') return true;
    return typeof item.text === 'string' && item.text.includes(marker);
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
  if (record.type === 'system' && Array.isArray(record.slash_commands)) {
    if (record.slash_commands.some(command => command === commandName)) evidence.registered = true;
  }
  for (const block of contentBlocks(record)) {
    if (!block || typeof block !== 'object') continue;
    const item = block as Record<string, unknown>;
    if (item.type !== 'tool_result') continue;
    if (isLaunchMarker(item.content, commandName)) evidence.launched = true;
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
