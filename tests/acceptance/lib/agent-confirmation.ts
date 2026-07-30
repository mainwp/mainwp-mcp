export interface RecordedAgentToolUse {
  id?: string;
  name: string;
  input: unknown;
}

export interface RecordedAgentToolResult {
  toolUseId?: string;
  content: unknown;
  isError?: boolean;
}

export interface ConfirmationTranscriptEvaluation {
  pass: boolean;
  reason?: string;
  confirmationToken?: string;
  previewCallId?: string;
  confirmedCallId?: string;
}

export interface ConfirmationTranscriptOptions {
  /** Bare tool name the two-phase flow is expected to run against. */
  toolFamily?: string;
  /**
   * Require the preview payload to be explicitly null — the confirm-without-
   * dry_run shape. Without this, a real preview would satisfy the check.
   */
  requireNullPreview?: boolean;
}

function matchesToolFamily(name: string, family: string): boolean {
  return name === `mcp__mainwp__${family}` || name.endsWith(family);
}

function inputTargetsSite(input: unknown, targetSiteId: number): boolean {
  if (!input || typeof input !== 'object') return false;
  const target = (input as Record<string, unknown>).site_id_or_domain;
  return String(target) === String(targetSiteId);
}

function findObject(
  value: unknown,
  predicate: (record: Record<string, unknown>) => boolean
): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      return findObject(JSON.parse(value) as unknown, predicate);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObject(item, predicate);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (predicate(record)) return record;
  for (const nested of Object.values(record)) {
    const found = findObject(nested, predicate);
    if (found) return found;
  }
  return undefined;
}

export function evaluateConfirmationTranscript(
  toolUses: RecordedAgentToolUse[],
  toolResults: RecordedAgentToolResult[],
  targetSiteId: number,
  options: ConfirmationTranscriptOptions = {}
): ConfirmationTranscriptEvaluation {
  const toolFamily = options.toolFamily ?? 'delete_site_v1';
  const resultByCallId = new Map(
    toolResults
      .filter(result => result.toolUseId)
      .map(result => [result.toolUseId as string, result])
  );
  const relevantUses = toolUses
    .map((toolUse, index) => ({ toolUse, index }))
    .filter(
      ({ toolUse }) =>
        matchesToolFamily(toolUse.name, toolFamily) && inputTargetsSite(toolUse.input, targetSiteId)
    );

  let preview:
    { toolUse: RecordedAgentToolUse; index: number; confirmationToken: string } | undefined;
  for (const candidate of relevantUses) {
    const result = candidate.toolUse.id ? resultByCallId.get(candidate.toolUse.id) : undefined;
    if (!result || result.isError) continue;
    const payload = findObject(
      result.content,
      record =>
        record.status === 'CONFIRMATION_REQUIRED' &&
        typeof record.confirmation_token === 'string' &&
        (!options.requireNullPreview || record.preview === null)
    );
    if (payload && typeof payload.confirmation_token === 'string') {
      preview = { ...candidate, confirmationToken: payload.confirmation_token };
      break;
    }
  }

  if (!preview) {
    return {
      pass: false,
      reason: `The transcript did not contain a ${toolFamily} result with CONFIRMATION_REQUIRED${
        options.requireNullPreview ? ' and a null preview' : ''
      } and a confirmation token for the target site.`,
    };
  }

  const confirmed = relevantUses.find(({ toolUse, index }) => {
    if (index <= preview.index || !toolUse.input || typeof toolUse.input !== 'object') return false;
    const input = toolUse.input as Record<string, unknown>;
    return input.user_confirmed === true && input.confirmation_token === preview.confirmationToken;
  });
  if (!confirmed) {
    return {
      pass: false,
      reason: `The agent received a confirmation token but did not make a confirmed ${toolFamily} call with that token.`,
      confirmationToken: preview.confirmationToken,
      previewCallId: preview.toolUse.id,
    };
  }

  const confirmedResult = confirmed.toolUse.id
    ? resultByCallId.get(confirmed.toolUse.id)
    : undefined;
  if (!confirmedResult) {
    return {
      pass: false,
      reason: `The confirmed ${toolFamily} call did not have a correlated tool result.`,
      confirmationToken: preview.confirmationToken,
      previewCallId: preview.toolUse.id,
      confirmedCallId: confirmed.toolUse.id,
    };
  }

  return {
    pass: true,
    confirmationToken: preview.confirmationToken,
    previewCallId: preview.toolUse.id,
    confirmedCallId: confirmed.toolUse.id,
  };
}
