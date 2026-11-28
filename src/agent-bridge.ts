import type { Config } from './config.js';
import { isSchemaObject as record, isValidId, sanitizeError } from './security.js';

export const AGENT_APPROVAL_INSTRUCTIONS =
  'Give approval_url to the user and wait for them to approve in the Dashboard. Never open or approve the link yourself or claim approval from chat. A call with only an operation_id continues a change you already allowed, after its safety backup or approval. If agent_backup_running is returned, follow its poll hint with the same operation_id.';

// Agent Bridge refuses gated writes with these codes before anything runs, and
// each message already says what to do next. agent_child_unchecked is left out
// because it arrives as a 502. Only 4xx responses set the upstream error code.
export const AGENT_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'agent_access_off',
  'agent_code_off',
  'agent_read_only',
  'agent_rule_blocked',
  'agent_store_blocked',
  'agent_backup_unavailable',
  'agent_approval_cancelled',
  'agent_child_outdated',
]);

// The Child gives PHP and WP-CLI up to 120 seconds, plus the Dashboard round trip.
export const AGENT_WRITE_TIMEOUT_MS = 150_000;

export const AGENT_WRITE_TIMEOUT_TEXT =
  'The change may still be running. Check the site before trying again.';

type Grant = { site_ids: number[]; expires_at: number };
const grants = new Map<string, Grant>();

export function clearAgentGrants(): void {
  grants.clear();
}

export function getAgentGrant(identity: string, grantId: string): Grant | undefined {
  const key = `${identity}:${grantId}`;
  const grant = grants.get(key);
  if (grant && grant.expires_at <= Date.now()) {
    grants.delete(key);
    return undefined;
  }
  return grant;
}

// The reason text from the Dashboard is shown in the transcript as plain text.
// It is flattened to one line so it cannot add lines to the pending text, and
// sanitizeError redacts it and caps it at 500 characters.
function approvalReason(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const reason = sanitizeError(
    value
      .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
  return reason || undefined;
}

const APPROVAL_FALLBACK_INSTRUCTIONS =
  'Ask the user to approve the pending operation in the Dashboard. Wait for their confirmation, then resume the same tool with operation_id only. Never approve or claim approval yourself.';

// A link is passed on only when it is an http(s) page on the configured
// Dashboard origin with no credentials in it.
function dashboardLink(value: unknown, config: Config): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    const dashboard = new URL(config.dashboardUrl);
    if (
      url.origin !== dashboard.origin ||
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}

// The operation card link must point at the operation the response names.
function operationLink(value: unknown, operationId: unknown, config: Config): string | undefined {
  if (typeof operationId !== 'string' || !operationId || operationId.length > 255) return undefined;
  const link = dashboardLink(value, config);
  return link && new URL(link).searchParams.get('operation') === operationId ? link : undefined;
}

function isSeconds(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

// elapsed_seconds is required. An estimate is kept only with the source that
// explains it: null with "unknown", or a positive whole number with
// "site_db_history". Any other combination drops both.
function backupWait(value: unknown): Record<string, unknown> | undefined {
  if (!record(value) || !isSeconds(value.elapsed_seconds)) return undefined;
  const wait: Record<string, unknown> = { elapsed_seconds: value.elapsed_seconds };
  const estimate = value.estimated_seconds;
  const source = value.estimate_source;
  const unknownEstimate = estimate === null && source === 'unknown';
  const measuredEstimate = isSeconds(estimate) && estimate > 0 && source === 'site_db_history';
  if (unknownEstimate || measuredEstimate) {
    wait.estimated_seconds = estimate;
    wait.estimate_source = source;
  }
  return wait;
}

export function approvalFields(value: unknown, config: Config): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (!record(value)) return { instructions: APPROVAL_FALLBACK_INSTRUCTIONS };
  const reason = approvalReason(value.approval_reason);
  if (reason) fields.approval_reason = reason;
  for (const key of [
    'operation_id',
    'request_id',
    'poll',
    'expires_at',
    'preview',
    'task_grant',
    'grant_id',
    'site_ids',
  ]) {
    if (Object.hasOwn(value, key)) fields[key] = value[key];
  }
  const operationId = value.operation_id;
  const link =
    typeof operationId === 'string' && operationId && operationId.length <= 255
      ? dashboardLink(value.approval_url, config)
      : undefined;
  if (!link) return { ...fields, instructions: APPROVAL_FALLBACK_INSTRUCTIONS };
  return {
    ...fields,
    operation_id: operationId,
    approval_url: link,
    instructions: AGENT_APPROVAL_INSTRUCTIONS,
  };
}

/**
 * Text for a write that is waiting on Dashboard approval: a status line, the
 * Dashboard's reason when it gave one, the link and operation ID when the
 * Dashboard sent valid ones, then the instructions from approvalFields.
 */
export function approvalPendingText(approval: Record<string, unknown>): string {
  const lines = ['Waiting for your approval in MainWP'];
  if (typeof approval.approval_reason === 'string')
    lines.push(`Reason: ${approval.approval_reason}`);
  if (typeof approval.approval_url === 'string')
    lines.push(`Approval link: ${approval.approval_url}`);
  if (typeof approval.operation_id === 'string')
    lines.push(`Operation ID: ${approval.operation_id}`);
  if (typeof approval.instructions === 'string') lines.push(approval.instructions);
  return lines.join('\n');
}

export function agentOutcomeFields(
  value: unknown,
  code: string,
  config: Config
): Record<string, unknown> {
  if (code === 'agent_approval_required') return approvalFields(value, config);
  if (!record(value)) return {};
  const fields: Record<string, unknown> = {};
  if (code === 'outcome_unknown') {
    for (const key of ['operation_id', 'request_id']) {
      if (Object.hasOwn(value, key)) fields[key] = value[key];
    }
    return fields;
  }
  for (const key of [
    'operation_id',
    'poll',
    'expires_at',
    'preview',
    'task_grant',
    'grant_id',
    'site_ids',
  ]) {
    if (Object.hasOwn(value, key)) fields[key] = value[key];
  }
  if (code !== 'agent_backup_running' && code !== 'agent_backup_failed') return fields;
  if (Object.hasOwn(value, 'request_id')) fields.request_id = value.request_id;
  const approvalUrl = operationLink(value.approval_url, value.operation_id, config);
  if (approvalUrl) fields.approval_url = approvalUrl;
  const rulesUrl = dashboardLink(value.backup_rules_url, config);
  if (rulesUrl) fields.backup_rules_url = rulesUrl;
  const wait = backupWait(value.backup_wait);
  if (wait) fields.backup_wait = wait;
  const links =
    'approval_url and backup_rules_url are Dashboard pages for the user. Never open them or act on them yourself.';
  fields.instructions =
    code === 'agent_backup_running'
      ? `A safety backup is running. Follow the poll hint and resume the same tool with operation_id only; do not submit a new write. Without backup_wait.estimated_seconds, do not guess how long the backup will take. ${links}`
      : `The safety backup failed, so nothing changed. Follow the message for what to do next, and do not work around the backup with another tool. ${links}`;
  return fields;
}

export function describeAgentResponse(
  value: unknown,
  config: Config,
  identity: string,
  taskGrant?: unknown
): unknown {
  if (!record(value)) return value;
  const payload =
    record(value.data) && typeof value.code === 'string' && value.code.startsWith('agent_')
      ? value.data
      : value;
  const grant = record(payload.task_grant) ? payload.task_grant : payload;
  let expiry = NaN;
  if (typeof grant.expires_at === 'number') {
    expiry = grant.expires_at * 1000;
  } else if (typeof grant.expires_at === 'string') {
    expiry = Date.parse(grant.expires_at);
  }
  const sites = Array.isArray(grant.site_ids)
    ? grant.site_ids.map(site =>
        typeof site === 'string' && /^\d+$/.test(site) ? Number(site) : site
      )
    : undefined;
  if (
    typeof grant.grant_id === 'string' &&
    grant.grant_id.length > 0 &&
    grant.grant_id.length <= 255 &&
    sites &&
    sites.length <= 1000 &&
    sites.every(isValidId) &&
    Number.isFinite(expiry) &&
    expiry > Date.now()
  ) {
    for (const [key, cached] of grants) if (cached.expires_at <= Date.now()) grants.delete(key);
    const key = `${identity}:${grant.grant_id}`;
    grants.delete(key);
    if (grants.size >= 100) grants.delete(grants.keys().next().value!);
    grants.set(key, { site_ids: sites as number[], expires_at: expiry });
  }
  if (typeof value.code === 'string' && value.code.startsWith('agent_')) {
    const nested = record(value.data);
    const fields = agentOutcomeFields(payload, value.code, config);
    // Links and wait details reach the client only after agentOutcomeFields
    // validates them, so the unchecked copies are removed from either envelope.
    const {
      approval_url: _url,
      backup_rules_url: _rulesUrl,
      backup_wait: _wait,
      ...outcome
    } = value;
    return { ...outcome, ...(nested ? { data: fields } : {}), ...fields };
  }
  const grantId = typeof grant.grant_id === 'string' ? grant.grant_id : taskGrant;
  if (typeof grantId === 'string' && getAgentGrant(identity, grantId)) {
    return {
      ...value,
      instructions:
        'The Dashboard reports a task grant for these sites. It validates every call; other sites and the destructive proxy may still require approval. Pass grant_id as the string task_grant on later covered writes.',
    };
  }
  return value;
}
