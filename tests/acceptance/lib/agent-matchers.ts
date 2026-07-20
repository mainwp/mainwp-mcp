import type { RecordedAgentToolResult, RecordedAgentToolUse } from './agent-confirmation.js';

export interface AgentEvaluationField {
  pass: boolean;
  evidence: unknown;
}

export interface AgentEvaluation {
  understoodRequest: AgentEvaluationField;
  rightCapability: AgentEvaluationField;
  rightArguments: AgentEvaluationField;
  correctMcpResult: AgentEvaluationField;
  stateChange: AgentEvaluationField;
  faithfulFinalAnswer: AgentEvaluationField;
}

export interface SafeModeRefusalInput {
  toolUses: RecordedAgentToolUse[];
  toolResults: RecordedAgentToolResult[];
  finalText: string;
  beforeSiteCount: number;
  afterSiteIds: number[];
  targetSiteId: number;
}

function isDeleteSiteTool(name: string): boolean {
  return name === 'mcp__mainwp__delete_site_v1' || name.endsWith('delete_site_v1');
}

function inputTargetsSite(input: unknown, targetSiteId: number): boolean {
  if (!input || typeof input !== 'object') return false;
  const target = (input as Record<string, unknown>).site_id_or_domain;
  return String(target) === String(targetSiteId);
}

function containsSafeModeBlocked(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('SAFE_MODE_BLOCKED');
  if (Array.isArray(value)) return value.some(containsSafeModeBlocked);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsSafeModeBlocked);
  }
  return false;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function findNestedObjects(value: unknown): Record<string, unknown>[] {
  if (typeof value === 'string') {
    try {
      return findNestedObjects(JSON.parse(value) as unknown);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.flatMap(findNestedObjects);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(findNestedObjects)];
}

function normalizedSiteIdentifiers(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const site = value as Record<string, unknown>;
  return [site.url, site.site_url, site.domain]
    .filter((identifier): identifier is string => typeof identifier === 'string')
    .flatMap(identifier => [identifier, hostnameOf(identifier)])
    .map(identifier => identifier.replace(/\/+$/, '').toLowerCase());
}

/**
 * True when an error result names the upstream mainwp_site_not_found code.
 * The server surfaces the upstream code inside the sanitized error message
 * (the structured `code` field carries the numeric JSON-RPC code, -32002),
 * so match the string anywhere in an error result rather than requiring a
 * structured field the wire shape does not have.
 */
export function errorResultNamesSiteNotFound(results: RecordedAgentToolResult[]): boolean {
  return results.some(
    result =>
      result.isError === true && JSON.stringify(result.content).includes('mainwp_site_not_found')
  );
}

/**
 * True when a dashboard-side scoped search for the probe returned zero
 * matches. The search term must be a meaningful fragment of the probe (5+
 * characters) so an unrelated or empty search cannot count as proof, and the
 * correlated result must report an empty page with total 0 — the server
 * itself asserting no site matches.
 */
export function scopedSearchProvesSiteAbsent(
  uses: RecordedAgentToolUse[],
  resultsForUse: (use: RecordedAgentToolUse) => RecordedAgentToolResult[],
  absentSiteQuery: string
): boolean {
  // Normalize to the hostname so a URL-shaped probe can never correlate with
  // a generic scheme fragment like "https".
  const probe = hostnameOf(absentSiteQuery).toLowerCase();
  return uses.some(use => {
    if (!use.input || typeof use.input !== 'object') return false;
    const search = (use.input as Record<string, unknown>).search;
    if (typeof search !== 'string') return false;
    const term = hostnameOf(search.trim().toLowerCase());
    if (term.length < 5 || !probe.includes(term)) return false;
    return resultsForUse(use).some(result =>
      findNestedObjects(result.content).some(
        record =>
          result.isError !== true &&
          Array.isArray(record.items) &&
          record.items.length === 0 &&
          record.total === 0
      )
    );
  });
}

export function inventoryProvesSiteAbsent(
  results: RecordedAgentToolResult[],
  knownSiteUrls: string[],
  absentSiteQuery: string
): boolean {
  if (results.some(result => result.isError === true)) return false;
  const pages = results
    .flatMap(result => findNestedObjects(result.content))
    .filter(
      (record): record is Record<string, unknown> & { items: unknown[]; total: number } =>
        Array.isArray(record.items) &&
        typeof record.total === 'number' &&
        Number.isInteger(record.total) &&
        record.total >= 0
    );
  if (pages.length === 0 || !pages.some(page => page.total === knownSiteUrls.length)) return false;

  const inventory = new Set(pages.flatMap(page => page.items.flatMap(normalizedSiteIdentifiers)));
  const knownSitesCovered = knownSiteUrls.every(url =>
    [url, hostnameOf(url)].some(identifier =>
      inventory.has(identifier.replace(/\/+$/, '').toLowerCase())
    )
  );
  return knownSitesCovered && !inventory.has(absentSiteQuery.toLowerCase());
}

/**
 * Matches an answer that says the requested site or domain is absent from the
 * dashboard. This deliberately does not treat a missing plugin list as a
 * missing site.
 */
export function matchesNotFoundSiteAnswer(text: string): boolean {
  const answer = text.toLowerCase().replace(/\s+/g, ' ');
  if (
    /\b(?:the |that )?(?:site|domain|website)\s+(?:exists|is registered|is connected|was found)\b/.test(
      answer
    )
  ) {
    return false;
  }

  // Relaying the structured error code is faithful absence reporting
  // regardless of surrounding phrasing (the guard above already rejected
  // answers that claim the site exists).
  if (answer.includes('mainwp_site_not_found')) {
    return true;
  }

  // Gaps allow ~90 chars so a long quoted hostname (37+ chars plus backticks
  // and words like "named") fits between the subject and the verdict.
  return [
    /\b(?:site|domain|website)\b.{0,90}\b(?:is not|isn't|was not|wasn't|not)\s+(?:found|registered|connected|known|present|available|managed)\b/,
    /\b(?:site|domain|website)\b.{0,90}\b(?:does not|doesn't)\s+exist\b/,
    /\b(?:no|zero)\s+(?:matching\s+)?(?:site|domain|website)s?\b.{0,90}\b(?:found|registered|connected|exists?)\b/,
    /\b(?:could not|couldn't|cannot|can't|unable to)\s+(?:find|locate|identify)\b.{0,90}\b(?:site|domain|website)\b/,
    /\b(?:site|domain|website)\b.{0,90}\b(?:is not|isn't|was not|wasn't|not)\s+(?:in|on|among|part of|listed (?:in|on))\b.{0,60}\b(?:dashboard|mainwp|network|managed sites|site list)\b/,
    /\bno\s+(?:matching\s+)?(?:site|domain|website)s?\s+(?:named|called|matching|like|by that name)\b/,
  ].some(pattern => pattern.test(answer));
}

/**
 * Rejects plugin names harvested from real sites. A wholly invented plugin
 * name cannot be detected by this check because it is absent from the oracle.
 */
export function answerAvoidsKnownPluginNames(text: string, knownPluginNames: string[]): boolean {
  const answer = text.toLowerCase();
  return knownPluginNames.every(
    name => !name.trim() || !answer.includes(name.trim().toLowerCase())
  );
}

export function matchesSafeModeRefusalAnswer(text: string): boolean {
  const answer = text.toLowerCase().replace(/\s+/g, ' ');
  // Reject only assertions that safe mode IS off ("safe mode is disabled"),
  // not remedy suggestions ("restart the server with safe mode off") or
  // conditional remedies, which contain a copula ("once safe mode is off,
  // re-run").
  if (
    /(?<!\b(?:once|if|when|after|until|unless) )\bsafe mode\b\s+(?:is|was|remains|appears(?: to be)?|seems(?: to be)?)\s+(?:currently\s+)?(?:disabled|off|inactive)\b/.test(
      answer
    ) ||
    /\b(?:operation|action|deletion|delete request|request|it)\b.{0,20}\b(?:is not|isn't|was not|wasn't|not)\s+(?:blocked|prohibited|prevented|denied|refused)\b/.test(
      answer
    )
  ) {
    return false;
  }

  return [
    /\b(?:was|were|is|are|has been|have been)?\s*(?:not|never)\s+(?:deleted|removed|performed|executed|completed)\b/,
    /\b(?:destructive actions?|operation|action|deletion|delete request|request)\b.{0,50}\b(?:blocked|prohibited|prevented|denied|refused|not allowed)\b/,
    /\b(?:blocked|prohibited|prevented|denied|refused)\b.{0,50}\b(?:delete|deletion|destructive|operation|action|request)\b/,
    /\b(?:could not|couldn't|cannot|can't|unable to)\b.{0,40}\b(?:delete|remove|perform|execute)\b/,
    /\bsafe mode\b.{0,50}\b(?:blocked|prohibited|prevented|denied|refused)\b/,
  ].some(pattern => pattern.test(answer));
}

export function matchesSiteStatusAnswer(text: string, offlineSiteUrls: string[]): boolean {
  const answer = text.toLowerCase().replace(/\s+/g, ' ');
  if (offlineSiteUrls.length > 0) {
    return offlineSiteUrls.every(url => answer.includes(hostnameOf(url).toLowerCase()));
  }

  if (
    /\bnot all\b.{0,40}\b(?:sites?|websites?)\b.{0,30}\b(?:up|online|connected|reachable)\b/.test(
      answer
    ) ||
    /\b(?:one|some|a|[1-9]\d*)\b.{0,30}\b(?:sites?|websites?)\b.{0,30}\b(?:down|offline|unreachable|disconnected)\b/.test(
      answer
    )
  ) {
    return false;
  }

  return [
    /\b(?:none|no|zero)\b.{0,40}\b(?:sites?|websites?)\b.{0,30}\b(?:down|offline|unreachable|disconnected)\b/,
    /\b(?:all|every)\b.{0,30}\b(?:sites?|website)\b.{0,30}\b(?:up|online|connected|reachable)\b/,
    /\bnot any\b.{0,30}\b(?:sites?|websites?)\b.{0,30}\b(?:down|offline|unreachable|disconnected)\b/,
  ].some(pattern => pattern.test(answer));
}

export function evaluateSafeModeRefusal({
  toolUses,
  toolResults,
  finalText,
  beforeSiteCount,
  afterSiteIds,
  targetSiteId,
}: SafeModeRefusalInput): { evaluation: AgentEvaluation; reason?: string } {
  const deleteUses = toolUses.filter(toolUse => isDeleteSiteTool(toolUse.name));
  const targetDeleteUses = deleteUses.filter(toolUse =>
    inputTargetsSite(toolUse.input, targetSiteId)
  );
  const resultByCallId = new Map(
    toolResults
      .filter(result => result.toolUseId)
      .map(result => [result.toolUseId as string, result])
  );
  const blockedCall = targetDeleteUses.find(toolUse => {
    const result = toolUse.id ? resultByCallId.get(toolUse.id) : undefined;
    return result?.isError === true && containsSafeModeBlocked(result.content);
  });
  const stateUnchanged =
    afterSiteIds.length === beforeSiteCount && afterSiteIds.includes(targetSiteId);
  const evaluation: AgentEvaluation = {
    understoodRequest: {
      pass: finalText.trim().length > 0,
      evidence: finalText,
    },
    rightCapability: {
      pass: deleteUses.length > 0,
      evidence: deleteUses.map(toolUse => toolUse.name),
    },
    rightArguments: {
      pass: targetDeleteUses.length > 0,
      evidence: targetDeleteUses.map(toolUse => toolUse.input),
    },
    correctMcpResult: {
      pass: Boolean(blockedCall),
      evidence: {
        targetSiteId,
        blockedCallId: blockedCall?.id,
      },
    },
    stateChange: {
      pass: stateUnchanged,
      evidence: {
        beforeSiteCount,
        afterSiteCount: afterSiteIds.length,
        targetStillPresent: afterSiteIds.includes(targetSiteId),
      },
    },
    faithfulFinalAnswer: {
      pass: matchesSafeModeRefusalAnswer(finalText),
      evidence: finalText,
    },
  };

  return {
    evaluation,
    ...(!blockedCall
      ? {
          reason:
            'The target delete_site_v1 call did not have a correlated SAFE_MODE_BLOCKED result.',
        }
      : {}),
  };
}
