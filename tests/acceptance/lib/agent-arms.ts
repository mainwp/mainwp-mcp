import fs from 'node:fs';
import path from 'node:path';

/**
 * Bare-vs-skill comparison support for the agent acceptance harness.
 *
 * Both arms run in throwaway directories outside the repository checkout, so
 * neither inherits the repo's CLAUDE.md, settings, or skills. The only planned
 * difference between them is the staged skill.
 */

export const AGENT_ARM_IDS = ['bare', 'skill'] as const;
export type AgentArmId = (typeof AGENT_ARM_IDS)[number];

/** Directory name of the canonical skill, and the name Claude Code reports. */
export const AGENT_SKILL_NAME = 'mainwp-dashboard';

export interface AgentArm {
  id: AgentArmId;
  cwd: string;
  skillStaged: boolean;
}

/**
 * Create the isolated working directory for one arm and, for the skill arm,
 * copy the canonical skill into the `.claude/skills/` location Claude Code
 * discovers from the working directory. The packed tarball never carries the
 * skill, so staging is the only way the treatment arm can see it.
 */
export function stageAgentArm(root: string, id: AgentArmId, canonicalSkillDir: string): AgentArm {
  const cwd = path.join(root, `arm-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  if (id !== 'skill') return { id, cwd, skillStaged: false };
  if (!fs.existsSync(path.join(canonicalSkillDir, 'SKILL.md'))) {
    throw new Error(`Canonical skill not found for staging: ${canonicalSkillDir}`);
  }
  const target = path.join(cwd, '.claude', 'skills', AGENT_SKILL_NAME);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(canonicalSkillDir, target, { recursive: true });
  return { id, cwd, skillStaged: true };
}

export interface AgentSkillEvidence {
  /** The skill appeared in the session's advertised skill list. */
  discovered: boolean;
  /** The agent actually launched the skill through the Skill tool. */
  invoked: boolean;
}

/**
 * Fold one stream-json event into the running skill evidence.
 *
 * Claude Code 2.1.220 advertises loaded skills on the `system`/`init` event and
 * records an invocation as a `Skill` tool_use whose input names the skill.
 * Absence of both is what marks an arm `skill-not-loaded` instead of letting a
 * silent comparison run against an arm that never saw the skill.
 */
export function collectSkillEvidence(
  event: unknown,
  evidence: AgentSkillEvidence,
  skillName = AGENT_SKILL_NAME
): void {
  if (!event || typeof event !== 'object') return;
  const record = event as Record<string, unknown>;
  if (record.type === 'system' && Array.isArray(record.skills)) {
    if (record.skills.some(skill => skill === skillName)) evidence.discovered = true;
  }
  const message = record.message;
  const content =
    message && typeof message === 'object'
      ? (message as Record<string, unknown>).content
      : undefined;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const item = block as Record<string, unknown>;
    if (item.type !== 'tool_use' || item.name !== 'Skill') continue;
    const input = item.input;
    if (input && typeof input === 'object') {
      const named = (input as Record<string, unknown>).skill;
      if (named === skillName || (typeof named === 'string' && named.endsWith(`:${skillName}`))) {
        evidence.invoked = true;
      }
    }
  }
}

export const AGENT_METRIC_FIELDS = [
  'understoodRequest',
  'rightCapability',
  'rightArguments',
  'correctMcpResult',
  'stateChange',
  'faithfulFinalAnswer',
  'mcpToolCalls',
  'totalToolCalls',
  'errorResults',
  'turns',
] as const;

export type AgentMetricField = (typeof AGENT_METRIC_FIELDS)[number];

export type AgentArmMetrics = Record<AgentMetricField, number>;

export interface AgentArmDelta {
  field: AgentMetricField;
  bare: number;
  skill: number;
  delta: number;
}

/**
 * Mean of every metric across the samples for one arm. Boolean evaluation
 * fields arrive as 0/1, so their mean is the pass rate; with a single sample it
 * is just the boolean itself.
 */
export function aggregateArmMetrics(samples: AgentArmMetrics[]): AgentArmMetrics {
  const aggregate = {} as AgentArmMetrics;
  for (const field of AGENT_METRIC_FIELDS) {
    aggregate[field] = samples.length
      ? samples.reduce((total, sample) => total + sample[field], 0) / samples.length
      : 0;
  }
  return aggregate;
}

export function diffArmMetrics(bare: AgentArmMetrics, skill: AgentArmMetrics): AgentArmDelta[] {
  return AGENT_METRIC_FIELDS.map(field => ({
    field,
    bare: bare[field],
    skill: skill[field],
    // Rounded so float means (1/3, 2/3) do not print 17 digits of noise.
    delta: Math.round((skill[field] - bare[field]) * 1000) / 1000,
  }));
}

export interface CredentialLeakFinding {
  sentinelInRawStream: boolean;
  redactedTokenInTranscript: boolean;
}

export function hasCredentialLeak(finding: CredentialLeakFinding): boolean {
  return finding.sentinelInRawStream || finding.redactedTokenInTranscript;
}

/**
 * Two independent leak signals for one agent run.
 *
 * A grep of the written transcript alone is vacuous: the Redactor scrubs the
 * application password before anything reaches disk. So the sentinel is looked
 * for in the raw stream, and the redaction token is looked for in the redacted
 * view — either one means the credential reached the agent's output.
 */
export function detectCredentialLeak(
  rawStream: string,
  redactedStream: string,
  sentinels: string[],
  redactionToken = '<redacted:app-password>'
): CredentialLeakFinding {
  return {
    sentinelInRawStream: sentinels.some(
      sentinel => sentinel.length > 0 && rawStream.includes(sentinel)
    ),
    redactedTokenInTranscript: redactedStream.includes(redactionToken),
  };
}
