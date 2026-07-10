/**
 * Name Conversion Utilities Tests
 */

import { describe, it, expect } from 'vitest';
import { abilityNameToToolName } from './naming.js';

describe('abilityNameToToolName', () => {
  describe('primary namespace (prefix stripped)', () => {
    it('strips the primary namespace and converts hyphens to underscores', () => {
      expect(abilityNameToToolName('mainwp/list-sites-v1', 'mainwp')).toBe('list_sites_v1');
    });

    it('strips a custom primary namespace', () => {
      expect(abilityNameToToolName('custom/my-ability', 'custom')).toBe('my_ability');
    });

    it('handles abilities with no hyphens', () => {
      expect(abilityNameToToolName('mainwp/simple', 'mainwp')).toBe('simple');
    });

    it('handles multiple hyphens', () => {
      expect(abilityNameToToolName('mainwp/get-site-updates-count-v1', 'mainwp')).toBe(
        'get_site_updates_count_v1'
      );
    });

    it('treats only the first slash as the namespace separator', () => {
      // Raw function contract only: multi-slash names fail ABILITY_NAME_RE
      // and are filtered out during fetchAbilities, so they never reach this
      // function in practice.
      expect(abilityNameToToolName('mainwp/sub/path-name', 'mainwp')).toBe('sub/path_name');
    });
  });

  describe('non-primary namespace (prefix preserved with __)', () => {
    it('preserves the namespace with a double-underscore separator', () => {
      expect(abilityNameToToolName('acme/do-thing-v1', 'mainwp')).toBe('acme__do_thing_v1');
    });

    it('handles short ability names', () => {
      expect(abilityNameToToolName('acme/ping', 'mainwp')).toBe('acme__ping');
    });

    it('distinguishes namespaces that share a trailing name', () => {
      expect(abilityNameToToolName('one/ping-v1', 'mainwp')).toBe('one__ping_v1');
      expect(abilityNameToToolName('two/ping-v1', 'mainwp')).toBe('two__ping_v1');
    });

    it('converts hyphens in hyphenated namespaces to underscores', () => {
      // Tool names must stay within [a-z0-9_] for MCP client compatibility;
      // a namespace like `acme-corp` must not leak its hyphen into the tool name.
      expect(abilityNameToToolName('acme-corp/do-thing-v1', 'mainwp')).toBe(
        'acme_corp__do_thing_v1'
      );
    });
  });

  it('throws on missing namespace separator', () => {
    expect(() => abilityNameToToolName('invalid-ability-name', 'mainwp')).toThrow(
      /missing namespace/
    );
  });
});
