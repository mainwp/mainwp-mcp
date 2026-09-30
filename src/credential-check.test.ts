/**
 * Tests for startup credential validation (moved out of index.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CredentialRejectedError, validateCredentials } from './credential-check.js';
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
      /Authentication failed: The Dashboard rejected the credentials for user "admin".*MAINWP_USER from the environment.*login name or email address, not the display name/
    );
  });

  it.each([
    ['incorrect_password', "Application Password from that user's profile page"],
    ['invalid_username', 'has no user'],
  ])('preserves the WordPress %s code on a 403', async (code, guidance) => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ code, message: 'Login refused' }), { status: 403 })
    );
    const validation = validateCredentials(makeBaseConfig(), mockLogger);
    await expect(validation).rejects.toBeInstanceOf(CredentialRejectedError);
    await expect(validation).rejects.toThrow(guidance);
  });

  it('keeps the old basic-auth guidance for a bare 403 while a 401 is rejected', async () => {
    const forbiddenResponse = {
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => 'Access denied',
      headers: new Headers(),
    };
    mockFetch.mockResolvedValueOnce(forbiddenResponse);
    await expect(validateCredentials(makeBaseConfig(), mockLogger)).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringContaining('Verify MAINWP_USER and MAINWP_APP_PASSWORD'),
    });

    mockFetch.mockResolvedValueOnce({ ...forbiddenResponse, status: 401 });
    await expect(validateCredentials(makeBaseConfig(), mockLogger)).rejects.toMatchObject({
      name: 'CredentialRejectedError',
    });
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
