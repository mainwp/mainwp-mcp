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
