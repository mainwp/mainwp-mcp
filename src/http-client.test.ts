/**
 * HTTP Client Tests
 *
 * Focused coverage for createFetch's redirect handling. The streaming body cap
 * and pagination paths are exercised in abilities.test.ts; these tests pin the
 * SSRF fail-closed behavior: a hostile/MITM'd Dashboard must never make this
 * host follow a 3xx Location header to an attacker-chosen origin.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFetch, readLimitedBody } from './http-client.js';
import { makeBaseConfig } from '../tests/helpers/config.js';

// Mock fetch globally (same approach as abilities.test.ts).
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const DASHBOARD_URL = 'https://dashboard.local/wp-json/wp/v2/abilities';

describe('createFetch redirect handling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests redirect: manual so a hostile Dashboard cannot auto-redirect the client', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      type: 'basic',
      headers: new Headers(),
      body: null,
      text: async () => '[]',
    });

    const customFetch = createFetch(makeBaseConfig());
    const response = await customFetch(DASHBOARD_URL);
    await readLimitedBody(response, 1000); // drain + clear the deadline timer

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.redirect).toBe('manual');
  });

  it('fails closed on a 3xx redirect instead of following the Location target', async () => {
    // A compromised Dashboard points the client at cloud metadata.
    const attackerTarget = 'http://169.254.169.254/latest/meta-data/';
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 302,
      type: 'basic',
      headers: new Headers({ location: attackerTarget }),
      body: null,
      text: async () => '',
    });

    const customFetch = createFetch(makeBaseConfig());

    await expect(customFetch(DASHBOARD_URL)).rejects.toMatchObject({
      status: 302,
      code: 'redirect_not_allowed',
    });

    // The attacker-chosen Location must never be requested.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalledWith(attackerTarget, expect.anything());
  });

  it('fails closed on an opaqueredirect response (older undici manual-redirect shape)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 0,
      type: 'opaqueredirect',
      headers: new Headers(),
      body: null,
      text: async () => '',
    });

    const customFetch = createFetch(makeBaseConfig());

    await expect(customFetch(DASHBOARD_URL)).rejects.toMatchObject({
      code: 'redirect_not_allowed',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('cancels the rejected redirect body so undici can release the connection', async () => {
    // Real Response with a real stream, not the plain-object mocks above: the
    // point of this test is the body stream, and undici stalls connections
    // whose bodies are neither read nor canceled.
    let cancelled = false;
    mockFetch.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }
      )
    );

    const customFetch = createFetch(makeBaseConfig());

    await expect(customFetch(DASHBOARD_URL)).rejects.toMatchObject({
      code: 'redirect_not_allowed',
    });
    expect(cancelled).toBe(true);
  });

  it('passes a normal 2xx response through unchanged', async () => {
    const okResponse = {
      ok: true,
      status: 200,
      type: 'basic',
      headers: new Headers(),
      body: null,
      text: async () => '[]',
    };
    mockFetch.mockResolvedValueOnce(okResponse);

    const customFetch = createFetch(makeBaseConfig());
    const response = await customFetch(DASHBOARD_URL);
    await readLimitedBody(response, 1000); // drain + clear the deadline timer

    expect(response).toBe(okResponse);
  });

  it('returns 4xx/5xx responses without throwing so the caller error path is unchanged', async () => {
    const serverError = {
      ok: false,
      status: 500,
      type: 'basic',
      headers: new Headers(),
      body: null,
      text: async () => 'boom',
    };
    mockFetch.mockResolvedValueOnce(serverError);

    const customFetch = createFetch(makeBaseConfig());
    // createFetch must NOT throw on 4xx/5xx — callers (paginateApi / execute)
    // own that error path via readLimitedBody + createHttpError.
    const response = await customFetch(DASHBOARD_URL);
    await readLimitedBody(response, 1000); // drain + clear the deadline timer

    expect(response).toBe(serverError);
    expect(response.status).toBe(500);
  });
});
