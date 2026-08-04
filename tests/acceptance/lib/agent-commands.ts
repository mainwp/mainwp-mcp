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
  /**
   * An assistant turn has been seen. A tool_reference block carries no command
   * identity, so it only counts as the start-of-conversation expansion while
   * this is still false; the literal marker names its command and counts
   * anywhere.
   */
  assistantSeen: boolean;
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
  if (record.type === 'system' && Array.isArray(record.slash_commands)) {
    if (record.slash_commands.some(command => command === commandName)) evidence.registered = true;
  }
  for (const block of contentBlocks(record)) {
    if (!block || typeof block !== 'object') continue;
    const item = block as Record<string, unknown>;
    if (item.type !== 'tool_result') continue;
    if (isLaunchMarker(item.content, commandName, evidence.assistantSeen)) evidence.launched = true;
  }
  if (record.type === 'assistant') evidence.assistantSeen = true;
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
