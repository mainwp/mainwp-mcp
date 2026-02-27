/**
 * MCP Prompt Templates Tests
 */

import { describe, it, expect } from 'vitest';
import { getPromptList, getPrompt, getPromptArgumentCompletions } from './prompts.js';

describe('getPromptList', () => {
  it('should return all prompt definitions', () => {
    const prompts = getPromptList();

    expect(Array.isArray(prompts)).toBe(true);
    expect(prompts.length).toBeGreaterThan(0);
  });

  it('should include name, description, and arguments', () => {
    const prompts = getPromptList();

    for (const prompt of prompts) {
      expect(prompt).toHaveProperty('name');
      expect(prompt).toHaveProperty('description');
      expect(typeof prompt.name).toBe('string');
      expect(typeof prompt.description).toBe('string');
    }
  });

  it('should include troubleshoot-site prompt', () => {
    const prompts = getPromptList();
    const troubleshoot = prompts.find(p => p.name === 'troubleshoot-site');

    expect(troubleshoot).toBeDefined();
    expect(troubleshoot?.arguments).toBeDefined();
    expect(troubleshoot?.arguments?.length).toBeGreaterThan(0);
  });

  it('should include maintenance-check prompt', () => {
    const prompts = getPromptList();
    const maintenance = prompts.find(p => p.name === 'maintenance-check');

    expect(maintenance).toBeDefined();
  });

  it('should include update-workflow prompt', () => {
    const prompts = getPromptList();
    const update = prompts.find(p => p.name === 'update-workflow');

    expect(update).toBeDefined();
    expect(update?.arguments?.some(a => a.name === 'update_type')).toBe(true);
  });
});

describe('getPrompt', () => {
  it('should return messages for troubleshoot-site prompt', () => {
    const result = getPrompt('troubleshoot-site', { site_id: '123' });

    expect(result).toHaveProperty('messages');
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it('should throw on unknown prompt name', () => {
    expect(() => getPrompt('unknown-prompt')).toThrow(/Unknown prompt/);
  });

  it('should interpolate argument values', () => {
    const result = getPrompt('site-report', { site_id: '456' });

    const message = result.messages[0];
    expect(message.role).toBe('user');
    expect(message.content).toHaveProperty('text');
    const text = (message.content as { text: string }).text;
    expect(text).toContain('456');
  });

  it('should use placeholder when argument not provided', () => {
    const result = getPrompt('site-report', {});

    const message = result.messages[0];
    const text = (message.content as { text: string }).text;
    expect(text).toContain('[site_id]');
  });

  it('should handle optional arguments', () => {
    const result = getPrompt('update-workflow', { update_type: 'plugins' });

    const message = result.messages[0];
    const text = (message.content as { text: string }).text;
    expect(text).toContain('plugins');
  });

  it('should return messages with proper role', () => {
    const result = getPrompt('maintenance-check');

    const message = result.messages[0];
    expect(message.role).toBe('user');
  });

  it('should include content type text', () => {
    const result = getPrompt('network-summary');

    const message = result.messages[0];
    expect(message.content).toHaveProperty('type', 'text');
  });
});

describe('getPromptArgumentCompletions', () => {
  it('should return completions for update_type', () => {
    const completions = getPromptArgumentCompletions('update-workflow', 'update_type');

    expect(completions).toContain('plugins');
    expect(completions).toContain('themes');
    expect(completions).toContain('core');
    expect(completions).toContain('all');
  });

  it('should return completions for issue_type', () => {
    const completions = getPromptArgumentCompletions('troubleshoot-site', 'issue_type');

    expect(completions).toContain('connectivity');
    expect(completions).toContain('performance');
    expect(completions).toContain('security');
    expect(completions).toContain('updates');
  });

  it('should return empty for site_id (dynamic argument)', () => {
    const completions = getPromptArgumentCompletions('site-report', 'site_id');

    expect(completions).toEqual([]);
  });

  it('should return empty for site_ids (dynamic argument)', () => {
    const completions = getPromptArgumentCompletions('security-audit', 'site_ids');

    expect(completions).toEqual([]);
  });

  it('should return empty for unknown arguments', () => {
    const completions = getPromptArgumentCompletions('any-prompt', 'unknown_arg');

    expect(completions).toEqual([]);
  });
});

describe('getPrompt - argument validation', () => {
  it('should reject non-numeric site_id', () => {
    expect(() => getPrompt('troubleshoot-site', { site_id: 'abc' })).toThrow('Invalid site_id');
  });

  it('should accept numeric site_id', () => {
    expect(() => getPrompt('troubleshoot-site', { site_id: '123' })).not.toThrow();
  });

  it('should reject invalid issue_type', () => {
    expect(() => getPrompt('troubleshoot-site', { site_id: '1', issue_type: 'hacking' })).toThrow(
      'Invalid issue_type'
    );
  });

  it('should accept valid issue_type', () => {
    expect(() =>
      getPrompt('troubleshoot-site', { site_id: '1', issue_type: 'security' })
    ).not.toThrow();
  });

  it('should accept comma-separated numeric site_ids', () => {
    expect(() => getPrompt('security-audit', { site_ids: '1,2,3' })).not.toThrow();
  });

  it('should accept "all" as site_ids', () => {
    expect(() => getPrompt('security-audit', { site_ids: 'all' })).not.toThrow();
  });

  it('should reject non-numeric site_ids', () => {
    expect(() => getPrompt('security-audit', { site_ids: 'abc' })).toThrow('Invalid site_ids');
  });

  it('should reject invalid update_type', () => {
    expect(() => getPrompt('update-workflow', { update_type: 'backdoor' })).toThrow(
      'Invalid update_type'
    );
  });

  it('should accept valid update_type', () => {
    expect(() => getPrompt('update-workflow', { update_type: 'plugins' })).not.toThrow();
  });
});
