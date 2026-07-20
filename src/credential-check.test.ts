/**
 * Tests for startup credential validation (moved out of index.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateCredentials } from './credential-check.js';
import { clearCache, initRateLimiter } from './abilities.js';
import { makeBaseConfig, makeMockLogger } from '../tests/helpers/config.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockLogger = makeMockLogger();

describe('validateCredentials', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearCache();
    initRateLimiter(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns abilities and logs success on a valid connection', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
      headers: new Headers(),
    });

    const abilities = await validateCredentials(makeBaseConfig(), mockLogger);

    expect(abilities).toEqual([]);
    expect(mockLogger.info).toHaveBeenCalledWith(
      'Credential validation successful: Connected to MainWP Dashboard'
    );
  });

  it('classifies a 401 with the basic-auth hint', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Invalid credentials',
      headers: new Headers(),
    });

    await expect(validateCredentials(makeBaseConfig(), mockLogger)).rejects.toThrow(
      /Authentication failed: Invalid credentials\. Verify MAINWP_USER and MAINWP_APP_PASSWORD/
    );
  });

  it('classifies a 401 with the bearer-token hint for token auth', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'Invalid credentials',
      headers: new Headers(),
    });

    const config = makeBaseConfig({ authType: 'bearer', apiToken: 'abc', username: undefined });
    await expect(validateCredentials(config, mockLogger)).rejects.toThrow(
      /Bearer tokens \(MAINWP_TOKEN\) are not accepted/
    );
  });

  it('classifies a 404 as a missing Abilities API endpoint', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => 'nope',
      headers: new Headers(),
    });

    await expect(validateCredentials(makeBaseConfig(), mockLogger)).rejects.toThrow(
      /Abilities API endpoint not found/
    );
  });

  it('classifies connection timeouts', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Request timeout after 30000ms'));

    await expect(validateCredentials(makeBaseConfig(), mockLogger)).rejects.toThrow(
      /Connection timeout\. Verify MAINWP_URL is reachable/
    );
  });

  it('classifies SSL certificate errors', async () => {
    mockFetch.mockRejectedValueOnce(new Error('unable to verify the first certificate'));

    await expect(validateCredentials(makeBaseConfig(), mockLogger)).rejects.toThrow(
      /SSL certificate verification failed/
    );
  });

  it('classifies network errors without an HTTP status', async () => {
    mockFetch.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND dashboard.local'));

    await expect(validateCredentials(makeBaseConfig(), mockLogger)).rejects.toThrow(
      /Network error: Cannot reach MAINWP_URL/
    );
  });

  it('prefixes unrecognized errors as credential validation failures', async () => {
    mockFetch.mockRejectedValueOnce(new Error('something odd'));

    await expect(validateCredentials(makeBaseConfig(), mockLogger)).rejects.toThrow(
      /Credential validation failed: something odd/
    );
  });
});
