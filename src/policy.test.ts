/**
 * Tests for the pure policy-decision gate.
 *
 * decidePolicy is the single policy authority: every ability-resolving
 * surface (CallTool, ListTools, resources, completions, tool-help) routes
 * through it. The table below covers every decision branch.
 */

import { describe, it, expect } from 'vitest';
import { decidePolicy, classifyDestructive, isToolAllowed, type PolicyDecision } from './policy.js';
import { makeBaseConfig } from '../tests/helpers/config.js';

describe('decidePolicy', () => {
  interface Row {
    name: string;
    blocked: string[] | undefined;
    allowed: string[] | undefined;
    destructive: boolean;
    safeMode: boolean;
    requireUserConfirmation: boolean;
    expected: PolicyDecision;
  }

  const rows: Row[] = [
    {
      name: 'blocked tool, non-destructive',
      blocked: ['t'],
      allowed: [],
      destructive: false,
      safeMode: false,
      requireUserConfirmation: false,
      expected: 'blocked-by-policy',
    },
    {
      name: 'block wins over safe mode and confirmation',
      blocked: ['t'],
      allowed: [],
      destructive: true,
      safeMode: true,
      requireUserConfirmation: true,
      expected: 'blocked-by-policy',
    },
    {
      name: 'allowlist excludes tool',
      blocked: [],
      allowed: ['x'],
      destructive: false,
      safeMode: false,
      requireUserConfirmation: false,
      expected: 'blocked-by-policy',
    },
    {
      name: 'allowlist includes tool',
      blocked: [],
      allowed: ['t'],
      destructive: false,
      safeMode: false,
      requireUserConfirmation: false,
      expected: 'allow',
    },
    {
      name: 'empty lists allow',
      blocked: [],
      allowed: [],
      destructive: false,
      safeMode: false,
      requireUserConfirmation: false,
      expected: 'allow',
    },
    {
      name: 'destructive blocked by safe mode',
      blocked: [],
      allowed: [],
      destructive: true,
      safeMode: true,
      requireUserConfirmation: false,
      expected: 'safe-mode-blocked',
    },
    {
      name: 'safe mode wins over confirmation',
      blocked: [],
      allowed: [],
      destructive: true,
      safeMode: true,
      requireUserConfirmation: true,
      expected: 'safe-mode-blocked',
    },
    {
      name: 'destructive needs confirmation',
      blocked: [],
      allowed: [],
      destructive: true,
      safeMode: false,
      requireUserConfirmation: true,
      expected: 'needs-confirmation',
    },
    {
      name: 'allowlisted destructive still needs confirmation',
      blocked: [],
      allowed: ['t'],
      destructive: true,
      safeMode: false,
      requireUserConfirmation: true,
      expected: 'needs-confirmation',
    },
    {
      name: 'destructive with both flags off allows',
      blocked: [],
      allowed: [],
      destructive: true,
      safeMode: false,
      requireUserConfirmation: false,
      expected: 'allow',
    },
    {
      name: 'safe mode ignores non-destructive',
      blocked: [],
      allowed: [],
      destructive: false,
      safeMode: true,
      requireUserConfirmation: false,
      expected: 'allow',
    },
    {
      name: 'confirmation ignores non-destructive',
      blocked: [],
      allowed: [],
      destructive: false,
      safeMode: false,
      requireUserConfirmation: true,
      expected: 'allow',
    },
    {
      name: 'undefined lists allow',
      blocked: undefined,
      allowed: undefined,
      destructive: true,
      safeMode: false,
      requireUserConfirmation: false,
      expected: 'allow',
    },
  ];

  it.each(rows)('$name', row => {
    const config = makeBaseConfig({
      blockedTools: row.blocked,
      allowedTools: row.allowed,
      safeMode: row.safeMode,
      requireUserConfirmation: row.requireUserConfirmation,
    });
    expect(decidePolicy(config, 't', row.destructive)).toBe(row.expected);
  });

  it('defaults isDestructive to false so listing surfaces never see destructive-only decisions', () => {
    const config = makeBaseConfig({ safeMode: true, requireUserConfirmation: true });
    expect(decidePolicy(config, 't')).toBe('allow');
  });

  it('blockedTools wins over allowedTools when a tool is in both', () => {
    const config = makeBaseConfig({ blockedTools: ['t'], allowedTools: ['t'] });
    expect(decidePolicy(config, 't')).toBe('blocked-by-policy');
  });
});

describe('classifyDestructive', () => {
  it.each([
    ['undefined annotations', undefined, true],
    ['empty annotations', {}, true],
    ['explicit destructive: false', { destructive: false }, false],
    ['explicit destructive: true', { destructive: true }, true],
  ] as const)('%s → %s', (_name, annotations, expected) => {
    expect(classifyDestructive(annotations)).toBe(expected);
  });

  it('pins current truthiness semantics for hostile non-boolean values', () => {
    // Remote annotations are hostile input. The pre-refactor behavior was
    // `annotations?.destructive ?? true` used in boolean position: nullish
    // falls back to destructive (fail-closed), any other value keeps its
    // truthiness. classifyDestructive must not change this wire behavior.
    expect(classifyDestructive({ destructive: null as unknown as boolean })).toBe(true);
    expect(classifyDestructive({ destructive: 'yes' as unknown as boolean })).toBe(true);
    expect(classifyDestructive({ destructive: 0 as unknown as boolean })).toBe(false);
    expect(classifyDestructive({ destructive: '' as unknown as boolean })).toBe(false);
  });
});

describe('isToolAllowed (policy wrapper)', () => {
  it('returns true only when decidePolicy allows the listing decision', () => {
    const config = makeBaseConfig({ blockedTools: ['blocked_tool'] });
    expect(isToolAllowed(config, 'blocked_tool')).toBe(false);
    expect(isToolAllowed(config, 'other_tool')).toBe(true);
  });

  it('ignores safeMode and confirmation (listing is never destructive-gated)', () => {
    const config = makeBaseConfig({ safeMode: true, requireUserConfirmation: true });
    expect(isToolAllowed(config, 'delete_site_v1')).toBe(true);
  });
});
