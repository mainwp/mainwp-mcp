import type { Config } from './config.js';
import { isSchemaObject as record, isValidId } from './security.js';

export const AGENT_APPROVAL_INSTRUCTIONS =
  'Give approval_url to the user and wait for them to approve in the Dashboard. Never open or approve the link yourself or claim approval from chat. After approval, call the same tool with operation_id only. If agent_backup_running is returned, follow its poll hint with the same operation_id.';

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

export function approvalFields(value: unknown, config: Config): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (record(value)) {
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
  }
  if (
    !record(value) ||
    typeof value.operation_id !== 'string' ||
    !value.operation_id ||
    value.operation_id.length > 255 ||
    typeof value.approval_url !== 'string' ||
    value.approval_url.length > 4096
  )
    return {
      ...fields,
      instructions:
        'Ask the user to approve the pending operation in the Dashboard. Wait for their confirmation, then resume the same tool with operation_id only. Never approve or claim approval yourself.',
    };
  try {
    const url = new URL(value.approval_url);
    const dashboard = new URL(config.dashboardUrl);
    if (
      url.origin !== dashboard.origin ||
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return {
        ...fields,
        instructions:
          'Ask the user to approve the pending operation in the Dashboard. Wait for their confirmation, then resume the same tool with operation_id only. Never approve or claim approval yourself.',
      };
    return {
      ...fields,
      operation_id: value.operation_id,
      approval_url: value.approval_url,
      instructions: AGENT_APPROVAL_INSTRUCTIONS,
    };
  } catch {
    return {
      ...fields,
      instructions:
        'Ask the user to approve the pending operation in the Dashboard. Wait for their confirmation, then resume the same tool with operation_id only. Never approve or claim approval yourself.',
    };
  }
}

/**
 * Text for a write that is waiting on Dashboard approval: a status line, the
 * link and operation ID when the Dashboard sent valid ones, then the
 * instructions from approvalFields.
 */
export function approvalPendingText(approval: Record<string, unknown>): string {
  const lines = ['Waiting for your approval in MainWP'];
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
  if (code === 'agent_backup_running')
    fields.instructions =
      'Follow the poll hint and resume the same tool with operation_id only; do not submit a new write.';
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
  const expiry =
    typeof grant.expires_at === 'number'
      ? grant.expires_at * 1000
      : typeof grant.expires_at === 'string'
        ? Date.parse(grant.expires_at)
        : NaN;
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
    const { approval_url: _url, ...outcome } = value;
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
