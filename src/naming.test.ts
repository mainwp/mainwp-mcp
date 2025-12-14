/**
 * Name Conversion Utilities Tests
 */

import { describe, it, expect } from 'vitest';
import { abilityNameToToolName, toolNameToAbilityName } from './naming.js';

describe('abilityNameToToolName', () => {
  it('should convert mainwp/list-sites-v1 to list_sites_v1', () => {
    expect(abilityNameToToolName('mainwp/list-sites-v1')).toBe('list_sites_v1');
  });

  it('should strip namespace prefix', () => {
    expect(abilityNameToToolName('custom/my-ability')).toBe('my_ability');
  });

  it('should convert hyphens to underscores', () => {
    expect(abilityNameToToolName('ns/a-b-c-d')).toBe('a_b_c_d');
  });

  it('should handle multiple hyphens', () => {
    expect(abilityNameToToolName('mainwp/get-site-updates-count-v1')).toBe(
      'get_site_updates_count_v1'
    );
  });

  it('should throw on missing namespace separator', () => {
    expect(() => abilityNameToToolName('invalid-ability-name')).toThrow(/missing namespace/);
  });

  it('should handle ability with no hyphens after namespace', () => {
    expect(abilityNameToToolName('mainwp/simple')).toBe('simple');
  });

  it('should handle deeply nested namespace', () => {
    // Only first slash is the namespace separator
    expect(abilityNameToToolName('mainwp/sub/path-name')).toBe('sub/path_name');
  });
});

describe('toolNameToAbilityName', () => {
  it('should convert list_sites_v1 to mainwp/list-sites-v1', () => {
    expect(toolNameToAbilityName('list_sites_v1', 'mainwp')).toBe('mainwp/list-sites-v1');
  });

  it('should prepend custom namespace', () => {
    expect(toolNameToAbilityName('my_tool', 'custom')).toBe('custom/my-tool');
  });

  it('should convert underscores to hyphens', () => {
    expect(toolNameToAbilityName('a_b_c_d', 'ns')).toBe('ns/a-b-c-d');
  });

  it('should handle tool name with no underscores', () => {
    expect(toolNameToAbilityName('simple', 'mainwp')).toBe('mainwp/simple');
  });

  it('should handle empty namespace', () => {
    expect(toolNameToAbilityName('test_tool', '')).toBe('/test-tool');
  });

  it('should be inverse of abilityNameToToolName for standard names', () => {
    const original = 'mainwp/list-sites-v1';
    const toolName = abilityNameToToolName(original);
    const restored = toolNameToAbilityName(toolName, 'mainwp');
    expect(restored).toBe(original);
  });
});
