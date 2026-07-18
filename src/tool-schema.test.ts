/**
 * Tool Schema Conversion Tests
 *
 * Regression coverage for hostile/malformed remote input schemas.
 * PHP dashboards serialize empty associative arrays as JSON arrays, so a
 * no-input ability can arrive with `properties: []`. Passing that through
 * invalidates the entire tools/list response for spec-compliant MCP clients
 * (the official SDK rejects it with a zod error), which leaves the server
 * connected but with zero usable tools.
 */

import { describe, it, expect } from 'vitest';
import { abilityToTool } from './tool-schema.js';
import type { Ability } from './abilities.js';

function makeAbility(overrides: Partial<Ability> = {}): Ability {
  return {
    name: 'mainwp/get-network-snapshot-v1',
    label: 'Get Network Snapshot',
    description: 'Returns a snapshot of the network.',
    category: 'mainwp-sites',
    ...overrides,
  };
}

describe('abilityToTool input schema sanitization', () => {
  it('coerces array-typed properties (PHP empty array) to an empty object', () => {
    // JSON.parse round-trip mirrors how the payload actually arrives
    const ability = makeAbility({
      input_schema: JSON.parse('{"type":"object","properties":[]}') as Record<string, unknown>,
    });

    const tool = abilityToTool(ability, 'mainwp');

    expect(Array.isArray(tool.inputSchema.properties)).toBe(false);
    expect(tool.inputSchema.properties).toEqual({});
    expect(tool.inputSchema.required).toEqual([]);
  });

  it('coerces non-object properties to an empty object', () => {
    const ability = makeAbility({
      input_schema: { type: 'object', properties: 'bogus' },
    });

    const tool = abilityToTool(ability, 'mainwp');

    expect(tool.inputSchema.properties).toEqual({});
  });

  it('coerces a non-array required field to an empty array', () => {
    const ability = makeAbility({
      input_schema: { type: 'object', properties: {}, required: 'site_id' },
    });

    const tool = abilityToTool(ability, 'mainwp');

    expect(tool.inputSchema.required).toEqual([]);
  });

  it('drops non-string entries from required', () => {
    const ability = makeAbility({
      input_schema: {
        type: 'object',
        properties: { site_id: { type: 'integer', description: 'Site ID.' } },
        required: ['site_id', 7, null, { bad: true }],
      },
    });

    const tool = abilityToTool(ability, 'mainwp');

    expect(tool.inputSchema.required).toEqual(['site_id']);
  });

  it('coerces primitive and array property values to empty objects', () => {
    // A string-valued property is truthy and reaches the description
    // backfill, which throws on primitives in strict-mode ESM and fails the
    // whole tools/list response instead of isolating one bad property.
    const ability = makeAbility({
      input_schema: JSON.parse(
        '{"type":"object","properties":{"site_id":"bogus","tags":[],"ok":{"type":"string"}}}'
      ) as Record<string, unknown>,
    });

    const tool = abilityToTool(ability, 'mainwp');

    const props = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.site_id).toEqual({ description: 'Site ID.' });
    expect(props.tags).toEqual({ description: 'Tags.' });
    expect(props.ok).toEqual({ type: 'string', description: 'Ok.' });
  });

  it('keeps a __proto__ parameter as an own property without polluting detection', () => {
    // A plain-object property map would send {confirm:...} through the
    // prototype setter: the __proto__ parameter vanishes from the schema and
    // 'confirm' in props starts observing the inherited attacker value.
    const ability = makeAbility({
      input_schema: JSON.parse(
        '{"type":"object","properties":{"__proto__":{"confirm":{"type":"boolean"}},"site_id":{"type":"integer","description":"Site ID."}}}'
      ) as Record<string, unknown>,
      meta: { annotations: { destructive: true, readonly: false, idempotent: false } },
    });

    const tool = abilityToTool(ability, 'mainwp');

    const props = tool.inputSchema.properties as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(props, '__proto__')).toBe(true);
    // No real confirm parameter exists, so no confirmation flow is advertised
    expect('confirm' in props).toBe(false);
    expect(tool.description).not.toContain('CONFIRMATION FLOW');
  });

  it('preserves well-formed object properties unchanged', () => {
    const ability = makeAbility({
      input_schema: {
        type: 'object',
        properties: { site_id: { type: 'integer', description: 'Site ID.' } },
        required: ['site_id'],
      },
    });

    const tool = abilityToTool(ability, 'mainwp');

    expect(tool.inputSchema.properties).toEqual({
      site_id: { type: 'integer', description: 'Site ID.' },
    });
    expect(tool.inputSchema.required).toEqual(['site_id']);
  });
});

describe('abilityToTool confirmation parameter injection', () => {
  function makeDestructiveAbility(withDryRun: boolean): Ability {
    const properties: Record<string, unknown> = {
      site_id: { type: 'integer', description: 'Site ID.' },
      confirm: { type: 'boolean', description: 'Confirm.' },
    };
    if (withDryRun) {
      properties.dry_run = { type: 'boolean', description: 'Dry run.' };
    }
    return makeAbility({
      name: 'mainwp/delete-site-v1',
      input_schema: { type: 'object', properties },
      meta: { annotations: { destructive: true, readonly: false, idempotent: false } },
    });
  }

  it('declares confirmation_token so schema-validating clients can send it', () => {
    const tool = abilityToTool(makeDestructiveAbility(true), 'mainwp');

    const props = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.user_confirmed).toBeDefined();
    expect(props.confirmation_token).toMatchObject({ type: 'string' });
  });

  it('advertises the token-bound flow in the standard description', () => {
    const tool = abilityToTool(makeDestructiveAbility(true), 'mainwp');

    expect(tool.description).toContain('confirmation_token');
    expect(tool.description).toContain('preview what will be affected');
  });

  it('does not promise a preview when the ability lacks dry_run', () => {
    const tool = abilityToTool(makeDestructiveAbility(false), 'mainwp');

    expect(tool.description).toContain('no preview available');
    expect(tool.description).not.toContain('preview what will be affected');
    expect(tool.description).toContain('confirmation_token');
  });
});
