/**
 * Session Data Tracking Tests
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { MCP_ERROR_CODES, McpError } from './errors.js';
import { formatBytes, getSessionDataUsage, resetSessionData, trackSessionData } from './session.js';
import { makeBaseConfig, makeMockLogger } from '../tests/helpers/config.js';

describe('session data tracking', () => {
  beforeEach(resetSessionData);

  it('accumulates usage and returns each UTF-8 byte count', () => {
    const config = makeBaseConfig();
    const logger = makeMockLogger();

    expect(trackSessionData('hello', config, logger, 'for test')).toBe(5);
    expect(trackSessionData('€', config, logger, 'for test')).toBe(3);
    expect(getSessionDataUsage(config)).toEqual({ used: 8, limit: config.maxSessionData });
  });

  it('throws RESOURCE_EXHAUSTED with formatted usage when the cap would be exceeded', () => {
    const config = makeBaseConfig({ maxSessionData: 1024 });
    const logger = makeMockLogger();
    trackSessionData('a'.repeat(800), config, logger, 'for test');

    let thrown: unknown;
    try {
      trackSessionData('b'.repeat(736), config, logger, 'for test');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(McpError);
    expect(thrown).toMatchObject({ code: MCP_ERROR_CODES.RESOURCE_EXHAUSTED });
    expect((thrown as Error).message).toContain('1.5 KB of 1.0 KB');
    expect(getSessionDataUsage(config).used).toBe(800);
  });

  it('resets accumulated session usage', () => {
    const config = makeBaseConfig();
    trackSessionData('data', config, makeMockLogger(), 'for test');

    resetSessionData();

    expect(getSessionDataUsage(config)).toEqual({ used: 0, limit: config.maxSessionData });
  });
});

describe('formatBytes', () => {
  it('formats byte values', () => {
    expect(formatBytes(512)).toBe('512 bytes');
  });

  it('formats kilobyte values', () => {
    expect(formatBytes(2560)).toBe('2.5 KB');
  });

  it('formats megabyte values', () => {
    expect(formatBytes(1572864)).toBe('1.5 MB');
  });
});
