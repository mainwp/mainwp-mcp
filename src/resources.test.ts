/**
 * Tests for resource URI validation (moved out of index.ts).
 * Handler-level ReadResource behavior is covered through createServer() +
 * InMemoryTransport in index.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { validateResourceUri } from './resources.js';
import { MCP_ERROR_CODES } from './errors.js';

describe('validateResourceUri', () => {
  it.each([
    ['mainwp://abilities', 'abilities'],
    ['mainwp://categories', 'categories'],
    ['mainwp://status', 'status'],
    ['mainwp://help', 'help'],
  ])('parses static URI %s', (uri, type) => {
    expect(validateResourceUri(uri)).toEqual({ type });
  });

  it('parses mainwp://site/{id} with a numeric ID', () => {
    expect(validateResourceUri('mainwp://site/42')).toEqual({
      type: 'site',
      params: { site_id: 42 },
    });
  });

  it('rejects a site ID of 0 as invalid params', () => {
    expect(() => validateResourceUri('mainwp://site/0')).toThrowError(
      expect.objectContaining({ code: MCP_ERROR_CODES.INVALID_PARAMS })
    );
  });

  it('parses mainwp://help/tool/{tool_name}', () => {
    expect(validateResourceUri('mainwp://help/tool/list_sites_v1')).toEqual({
      type: 'tool-help',
      params: { tool_name: 'list_sites_v1' },
    });
  });

  it.each([
    ['uppercase tool name', 'mainwp://help/tool/DELETE_SITE'],
    ['path traversal in site', 'mainwp://site/../etc'],
    ['unknown scheme path', 'mainwp://unknown'],
    ['non-numeric site id', 'mainwp://site/abc'],
  ])('rejects %s as resource not found', (_name, uri) => {
    expect(() => validateResourceUri(uri)).toThrowError(
      expect.objectContaining({ code: MCP_ERROR_CODES.RESOURCE_NOT_FOUND })
    );
  });

  it('rejects malformed percent-encoding as invalid params', () => {
    expect(() => validateResourceUri('mainwp://site/%E0%A4%A')).toThrowError(
      expect.objectContaining({ code: MCP_ERROR_CODES.INVALID_PARAMS })
    );
  });

  it('decodes percent-encoded URIs before validation', () => {
    expect(validateResourceUri('mainwp%3A%2F%2Fsite%2F7')).toEqual({
      type: 'site',
      params: { site_id: 7 },
    });
  });
});
