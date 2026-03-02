/**
 * Safety Coverage Evaluation
 *
 * Verifies the safety annotation system is complete and consistent:
 * - Every ability has meta.annotations (no default-deny fallthrough)
 * - Every destructive tool has confirm parameter
 * - Every destructive tool with confirm also has dry_run
 * - user_confirmed is injected for all destructive+confirm tools
 * - Read-only tools do NOT have confirm or user_confirmed
 * - generateInstructions() returns non-empty for all annotated tools
 * - buildSafetyTags() returns non-empty for all tools
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getTools,
  clearToolsCache,
  generateInstructions,
  buildSafetyTags,
} from '../../src/tools.js';
import { clearCache, initRateLimiter } from '../../src/abilities.js';
import { type Config } from '../../src/config.js';
import type { Ability } from '../../src/abilities.js';

import abilitiesFixture from './fixtures/abilities-full.json';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const baseConfig: Config = {
  dashboardUrl: 'https://test.local',
  authType: 'basic',
  username: 'admin',
  appPassword: 'xxxx',
  skipSslVerify: true,
  allowHttp: false,
  rateLimit: 0,
  requestTimeout: 5000,
  maxResponseSize: 10485760,
  safeMode: false,
  requireUserConfirmation: true,
  maxSessionData: 52428800,
  schemaVerbosity: 'standard',
  responseFormat: 'compact',
  configSource: 'environment',
  retryEnabled: false,
  maxRetries: 2,
  retryBaseDelay: 1000,
  retryMaxDelay: 2000,
};

function mockAbilitiesFetch(): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => abilitiesFixture,
    headers: new Headers(),
  });
}

// Cast fixture to Ability[] for type-safe access
const abilities = abilitiesFixture as unknown as Ability[];

describe('Safety Coverage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    clearToolsCache();
    initRateLimiter(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('annotation completeness (raw abilities)', () => {
    it('every ability should have meta.annotations (no default-deny fallthrough)', () => {
      const missing: string[] = [];

      for (const ability of abilities) {
        if (!ability.meta?.annotations) {
          missing.push(ability.name);
        }
      }

      expect(
        missing,
        `Abilities missing annotations (would trigger default-deny): ${missing.join(', ')}`
      ).toEqual([]);
    });

    it('every ability should have explicit destructive boolean', () => {
      const missing: string[] = [];

      for (const ability of abilities) {
        const destructive = ability.meta?.annotations?.destructive;
        if (typeof destructive !== 'boolean') {
          missing.push(ability.name);
        }
      }

      expect(missing, `Abilities with non-boolean destructive: ${missing.join(', ')}`).toEqual([]);
    });

    it('every ability should have explicit readonly boolean', () => {
      const missing: string[] = [];

      for (const ability of abilities) {
        const readonly = ability.meta?.annotations?.readonly;
        if (typeof readonly !== 'boolean') {
          missing.push(ability.name);
        }
      }

      expect(missing, `Abilities with non-boolean readonly: ${missing.join(', ')}`).toEqual([]);
    });
  });

  describe('destructive tool safety parameters', () => {
    it('every destructive ability should have confirm parameter in schema', () => {
      const violations: string[] = [];

      for (const ability of abilities) {
        if (ability.meta?.annotations?.destructive) {
          const props = ability.input_schema?.properties as Record<string, unknown> | undefined;
          if (!props || !('confirm' in props)) {
            violations.push(ability.name);
          }
        }
      }

      expect(
        violations,
        `Destructive abilities missing confirm param: ${violations.join(', ')}`
      ).toEqual([]);
    });

    it('every destructive ability with confirm should also have dry_run', () => {
      const violations: string[] = [];

      for (const ability of abilities) {
        if (ability.meta?.annotations?.destructive) {
          const props = ability.input_schema?.properties as Record<string, unknown> | undefined;
          if (props && 'confirm' in props && !('dry_run' in props)) {
            violations.push(ability.name);
          }
        }
      }

      expect(
        violations,
        `Destructive+confirm abilities missing dry_run: ${violations.join(', ')}`
      ).toEqual([]);
    });

    it('user_confirmed should be injected for all destructive+confirm tools', async () => {
      mockAbilitiesFetch();
      const tools = await getTools({ ...baseConfig, schemaVerbosity: 'standard' });

      const violations: string[] = [];
      for (const tool of tools) {
        if (tool.annotations?.destructiveHint === true) {
          const props = (tool.inputSchema.properties || {}) as Record<string, unknown>;
          if ('confirm' in props && !('user_confirmed' in props)) {
            violations.push(tool.name);
          }
        }
      }

      expect(
        violations,
        `Destructive tools missing injected user_confirmed: ${violations.join(', ')}`
      ).toEqual([]);
    });

    it('read-only tools should NOT have confirm or user_confirmed', async () => {
      mockAbilitiesFetch();
      const tools = await getTools({ ...baseConfig, schemaVerbosity: 'standard' });

      const violations: string[] = [];
      for (const tool of tools) {
        if (tool.annotations?.readOnlyHint === true) {
          const props = (tool.inputSchema.properties || {}) as Record<string, unknown>;
          if ('confirm' in props) {
            violations.push(`${tool.name} has confirm`);
          }
          if ('user_confirmed' in props) {
            violations.push(`${tool.name} has user_confirmed`);
          }
        }
      }

      expect(
        violations,
        `Read-only tools with confirmation params: ${violations.join(', ')}`
      ).toEqual([]);
    });
  });

  describe('instruction and tag generation', () => {
    it('generateInstructions should return non-empty for all annotated abilities', () => {
      const violations: string[] = [];

      for (const ability of abilities) {
        const meta = ability.meta?.annotations;
        if (!meta) continue;

        const props = ability.input_schema?.properties as Record<string, unknown> | undefined;
        const hasDryRun = props ? 'dry_run' in props : false;
        const hasConfirm = props ? 'confirm' in props : false;

        const instructions = generateInstructions(meta, hasDryRun, hasConfirm);
        if (!instructions || instructions.trim().length === 0) {
          violations.push(ability.name);
        }
      }

      expect(
        violations,
        `Abilities with empty generated instructions: ${violations.join(', ')}`
      ).toEqual([]);
    });

    it('buildSafetyTags should return non-empty for destructive tools', () => {
      const violations: string[] = [];

      for (const ability of abilities) {
        const meta = ability.meta?.annotations;
        if (!meta?.destructive) continue;

        const props = ability.input_schema?.properties as Record<string, unknown> | undefined;
        const hasDryRun = props ? 'dry_run' in props : false;
        const hasConfirm = props ? 'confirm' in props : false;

        const standardTags = buildSafetyTags(meta, hasDryRun, hasConfirm, 'standard');
        if (!standardTags || standardTags.trim().length === 0) {
          violations.push(`${ability.name} (standard)`);
        }

        const compactTags = buildSafetyTags(meta, hasDryRun, hasConfirm, 'compact');
        if (!compactTags || compactTags.trim().length === 0) {
          violations.push(`${ability.name} (compact)`);
        }
      }

      expect(
        violations,
        `Destructive abilities with empty safety tags: ${violations.join(', ')}`
      ).toEqual([]);
    });

    it('buildSafetyTags for read-only tools should mention read-only in standard mode', () => {
      const violations: string[] = [];

      for (const ability of abilities) {
        const meta = ability.meta?.annotations;
        if (!meta?.readonly) continue;

        const props = ability.input_schema?.properties as Record<string, unknown> | undefined;
        const hasDryRun = props ? 'dry_run' in props : false;
        const hasConfirm = props ? 'confirm' in props : false;

        const tags = buildSafetyTags(meta, hasDryRun, hasConfirm, 'standard');
        if (!tags.includes('Read-only')) {
          violations.push(ability.name);
        }
      }

      expect(
        violations,
        `Read-only abilities missing Read-only tag: ${violations.join(', ')}`
      ).toEqual([]);
    });
  });

  describe('consistency checks', () => {
    it('destructive and readonly should be mutually exclusive', () => {
      const violations: string[] = [];

      for (const ability of abilities) {
        const meta = ability.meta?.annotations;
        if (meta?.destructive === true && meta?.readonly === true) {
          violations.push(ability.name);
        }
      }

      expect(
        violations,
        `Abilities that are both destructive and readonly: ${violations.join(', ')}`
      ).toEqual([]);
    });

    it('MCP annotations should match ability annotations', async () => {
      mockAbilitiesFetch();
      const tools = await getTools({ ...baseConfig, schemaVerbosity: 'standard' });

      const violations: string[] = [];
      for (const tool of tools) {
        // Find matching ability
        const abilityName = `mainwp/${tool.name.replace(/_/g, '-')}`;
        const ability = abilities.find(a => a.name === abilityName);
        if (!ability) {
          violations.push(`${tool.name}: no matching ability found (${abilityName})`);
          continue;
        }
        if (!ability.meta?.annotations) continue;

        const meta = ability.meta.annotations;

        if (tool.annotations?.readOnlyHint !== meta.readonly) {
          violations.push(`${tool.name}: readOnlyHint mismatch`);
        }
        if (tool.annotations?.destructiveHint !== meta.destructive) {
          violations.push(`${tool.name}: destructiveHint mismatch`);
        }
        if (tool.annotations?.idempotentHint !== meta.idempotent) {
          violations.push(`${tool.name}: idempotentHint mismatch`);
        }
      }

      expect(violations, `MCP annotation mismatches: ${violations.join(', ')}`).toEqual([]);
    });
  });
});
