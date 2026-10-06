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
import { abilityToTool, generateInstructions } from './tool-schema.js';
import type { Ability, AbilityAnnotations } from './abilities.js';

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

  it('declares the token flow for one required schema-named confirmation field', () => {
    const ability = makeAbility({
      name: 'mainwp/set-dashboard-ip-restrictions-v1',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['confirm_lockout_risk'],
        properties: {
          confirm_lockout_risk: { type: 'boolean', enum: [true] },
        },
      },
      meta: { annotations: { destructive: true, readonly: false, idempotent: true } },
    });

    const tool = abilityToTool(ability, 'mainwp');
    const props = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.user_confirmed).toBeDefined();
    expect(props.confirmation_token).toBeDefined();
    expect(props.user_confirmed.description).toContain('confirm_lockout_risk:true');
    expect(props.confirmation_token.description).toContain('confirm_lockout_risk:true');
    expect(props.user_confirmed.description).not.toContain('confirm:true');
    expect(tool.description).toContain('confirm_lockout_risk:true');
    expect(tool.description).toContain('no preview available');
  });

  it('does not advertise an upstream preview for named confirmation even with dry_run declared', () => {
    const ability = makeAbility({
      input_schema: {
        type: 'object',
        required: ['confirm_lockout_risk'],
        properties: {
          confirm_lockout_risk: { type: 'boolean', enum: [true] },
          dry_run: { type: 'boolean' },
        },
      },
      meta: { annotations: { destructive: true, readonly: false, idempotent: true } },
    });

    const tool = abilityToTool(ability, 'mainwp');

    expect(tool.description).toContain('no preview available');
    expect(tool.description).not.toContain('preview what will be affected');
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

  it('does not promise a preview in the compact description when the ability lacks dry_run', () => {
    const tool = abilityToTool(makeDestructiveAbility(false), 'mainwp', 'compact');
    const description = tool.description ?? '';

    expect(description).toContain('FLOW:');
    expect(description).not.toContain('-> preview ->');
    expect(description).toContain('no preview available');
  });

  it.each([true, false])(
    'agrees between standard and compact on whether a preview exists (dry_run: %s)',
    withDryRun => {
      const ability = makeDestructiveAbility(withDryRun);
      const standard = abilityToTool(ability, 'mainwp', 'standard').description ?? '';
      const compact = abilityToTool(ability, 'mainwp', 'compact').description ?? '';

      expect(standard.includes('preview what will be affected')).toBe(withDryRun);
      expect(compact.includes('-> preview ->')).toBe(withDryRun);
      expect(standard.includes('no preview available')).toBe(!withDryRun);
      expect(compact.includes('no preview available')).toBe(!withDryRun);
    }
  );

  it.each([true, false])(
    'gates the compact flow on explicit approval like the standard one (dry_run: %s)',
    withDryRun => {
      // The same-turn self-approval loophole closed in the standard builder
      // must not survive in compact mode's shorthand.
      const compact =
        abilityToTool(makeDestructiveAbility(withDryRun), 'mainwp', 'compact').description ?? '';

      expect(compact).toContain('a bare request is not approval');
      expect(compact).toContain('explicit approval');
    }
  );

  it('skips injection when the declared confirm channel cannot accept true', () => {
    // Detection runs on the raw schema: conversion coerces `confirm: false`
    // to {}, which would otherwise advertise a confirmation flow that the
    // execution gate fails closed on.
    const ability = makeAbility({
      name: 'mainwp/delete-site-v1',
      input_schema: {
        type: 'object',
        properties: { site_id: { type: 'integer', description: 'Site ID.' }, confirm: false },
      },
      meta: { annotations: { destructive: true, readonly: false, idempotent: false } },
    });

    const tool = abilityToTool(ability, 'mainwp');

    const props = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.user_confirmed).toBeUndefined();
    expect(props.confirmation_token).toBeUndefined();
    expect(tool.description).not.toContain('confirmation_token');
  });
});

describe('Dashboard 6.3 preview sentence de-duplication', () => {
  const previewSentence = 'Call dry_run first and show the plan to the user.';
  const reminder = 'Always preview with dry_run or confirm before executing. Show preview to user.';
  const shippedInstructions = [
    [
      'updates',
      'Changes child sites. Requires confirm:true or dry_run:true. Call dry_run first and show the plan to the user. Operations with >200 sites are automatically queued and return a job_id for status polling. Individual update failures do not fail the entire operation.',
      'Changes child sites. Requires confirm:true or dry_run:true. Operations with >200 sites are automatically queued and return a job_id for status polling. Individual update failures do not fail the entire operation.',
    ],
    [
      'unignore',
      "Removes update holds on the Dashboard. Requires confirm:true or dry_run:true. Call dry_run first and show the plan to the user. Removes only the site's own holds; global holds and whole-site ignore flags remain in effect.",
      "Removes update holds on the Dashboard. Requires confirm:true or dry_run:true. Removes only the site's own holds; global holds and whole-site ignore flags remain in effect.",
    ],
  ];

  function annotations(instructions: unknown): AbilityAnnotations {
    return {
      destructive: true,
      readonly: false,
      idempotent: true,
      instructions: instructions as string,
    };
  }

  function ability(instructions: unknown): Ability {
    return makeAbility({
      input_schema: {
        type: 'object',
        properties: { confirm: { type: 'boolean' }, dry_run: { type: 'boolean' } },
      },
      meta: { annotations: annotations(instructions) },
    });
  }

  it.each(shippedInstructions)(
    'removes only the shipped %s preview sentence',
    (_, input, remaining) => {
      expect(abilityToTool(ability(input), 'mainwp', 'standard').description).toBe(
        `[sites] Returns a snapshot of the network. ${remaining} ${reminder} ` +
          '[DESTRUCTIVE, Requires two-step confirmation, Supports dry_run]' +
          '\n\nCONFIRMATION FLOW: 1) Call with confirm:true to preview what will be affected. ' +
          '2) Show preview to user and ask for confirmation. ' +
          '3) If confirmed, call again with user_confirmed:true and the confirmation_token ' +
          'from the first response to execute. ' +
          'A bare request for the operation is not approval: require explicit prior ' +
          'authorization to proceed through confirmation, or an approving reply after step 2.'
      );
    }
  );

  it.each([
    [previewSentence, ''],
    [`${previewSentence} Keep this sentence.`, 'Keep this sentence.'],
    [`Keep this sentence. ${previewSentence}`, 'Keep this sentence.'],
    [`Keep this sentence! ${previewSentence} Keep this too.`, 'Keep this sentence! Keep this too.'],
    [`Keep this sentence? ${previewSentence}`, 'Keep this sentence?'],
    [`${previewSentence} ${previewSentence}`, ''],
  ])('removes a standalone sentence from %j', (input, remaining) => {
    expect(generateInstructions(annotations(input), true, true)).toBe(
      remaining ? `${remaining} ${reminder}` : reminder
    );
  });

  it.each([
    'Show the dry_run preview before executing.',
    'Do not call dry_run first and show the plan to the user.',
    'Never Call dry_run first and show the plan to the user.',
    'call dry_run first and show the plan to the user.',
    `Keep this: ${previewSentence}`,
    `Keep this; ${previewSentence}`,
    `Keep this.${previewSentence}`,
    `${previewSentence}Keep this sentence.`,
  ])('keeps other or embedded preview text: %j', input => {
    expect(generateInstructions(annotations(input), true, true)).toBe(`${input} ${reminder}`);
  });

  it.each([null, true, 42, {}, ['preview']])('ignores non-string instructions: %j', input => {
    expect(generateInstructions(annotations(input), true, true)).toBe(reminder);
  });

  it('sanitizes control characters before removing the sentence', () => {
    const input = `\u0000${previewSentence}\u001b Keep this sentence.\u200b`;
    expect(generateInstructions(annotations(input), true, true)).toBe(
      `Keep this sentence. ${reminder}`
    );
    expect(generateInstructions(annotations(`Keep this.\n${previewSentence}\t`), true, true)).toBe(
      `Keep this. ${reminder}`
    );
  });

  it.each(shippedInstructions)('keeps compact %s output byte-identical', (_, input) => {
    expect(abilityToTool(ability(input), 'mainwp', 'compact').description).toBe(
      'Returns a snapshot of the network. [destructive, confirm, dry_run] ' +
        'FLOW: confirm:true -> preview -> show user; a bare request is not approval; ' +
        'on explicit approval -> user_confirmed:true + confirmation_token'
    );
  });
});

describe('abilityToTool schema verbosity keeps semantic property fields', () => {
  const fieldValues: Array<[string, unknown]> = [
    ['const', true],
    ['const', null],
    ['const', 0],
    ['nullable', true],
    ['nullable', false],
    ['writeOnly', true],
    ['writeOnly', false],
  ];
  const cases = (['compact', 'standard'] as const).flatMap(verbosity =>
    fieldValues.map(([field, value]) => [verbosity, field, value] as const)
  );

  it.each(cases)('keeps %s %s: %j on the property', (verbosity, field, value) => {
    // A declared falsy value is still a declaration: compact mode must copy it
    // by key presence, not truthiness.
    const ability = makeAbility({
      input_schema: {
        type: 'object',
        properties: { target: { type: 'boolean', description: 'Target.', [field]: value } },
      },
    });

    const tool = abilityToTool(ability, 'mainwp', verbosity);

    const props = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(field in props.target).toBe(true);
    expect(props.target[field]).toEqual(value);
  });
});
