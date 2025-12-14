/**
 * MCP Error Handling Tests
 */

import { describe, it, expect } from 'vitest';
import {
  McpError,
  McpErrorFactory,
  MCP_ERROR_CODES,
  toMcpErrorResponse,
  formatErrorResponse,
} from './errors.js';

describe('McpError', () => {
  it('should create error with code and message', () => {
    const error = new McpError(MCP_ERROR_CODES.INVALID_PARAMS, 'Invalid input');

    expect(error.code).toBe(MCP_ERROR_CODES.INVALID_PARAMS);
    expect(error.message).toBe('Invalid input');
    expect(error.name).toBe('McpError');
  });

  it('should include optional data field', () => {
    const data = { field: 'test', value: 123 };
    const error = new McpError(MCP_ERROR_CODES.INTERNAL_ERROR, 'Error occurred', data);

    expect(error.data).toEqual(data);
  });

  it('should convert to MCP error response format', () => {
    const error = new McpError(MCP_ERROR_CODES.TOOL_NOT_FOUND, 'Tool not found: test_tool', {
      tool: 'test_tool',
    });

    const response = error.toResponse();

    expect(response).toEqual({
      error: {
        code: MCP_ERROR_CODES.TOOL_NOT_FOUND,
        message: 'Tool not found: test_tool',
        data: { tool: 'test_tool' },
      },
    });
  });

  it('should omit data field when not provided', () => {
    const error = new McpError(MCP_ERROR_CODES.TIMEOUT, 'Request timed out');
    const response = error.toResponse();

    expect(response.error.data).toBeUndefined();
  });
});

describe('McpErrorFactory', () => {
  it('should create invalidParams error', () => {
    const error = McpErrorFactory.invalidParams('Invalid parameter');

    expect(error.code).toBe(MCP_ERROR_CODES.INVALID_PARAMS);
    expect(error.message).toBe('Invalid parameter');
  });

  it('should create invalidParams error with data', () => {
    const error = McpErrorFactory.invalidParams('Invalid field', { field: 'name' });

    expect(error.data).toEqual({ field: 'name' });
  });

  it('should create toolNotFound error with tool name', () => {
    const error = McpErrorFactory.toolNotFound('my_tool');

    expect(error.code).toBe(MCP_ERROR_CODES.TOOL_NOT_FOUND);
    expect(error.message).toContain('my_tool');
    expect(error.data).toEqual({ tool: 'my_tool' });
  });

  it('should create resourceNotFound error', () => {
    const error = McpErrorFactory.resourceNotFound('mainwp://invalid');

    expect(error.code).toBe(MCP_ERROR_CODES.RESOURCE_NOT_FOUND);
    expect(error.data).toEqual({ uri: 'mainwp://invalid' });
  });

  it('should create promptNotFound error', () => {
    const error = McpErrorFactory.promptNotFound('unknown-prompt');

    expect(error.code).toBe(MCP_ERROR_CODES.PROMPT_NOT_FOUND);
    expect(error.data).toEqual({ prompt: 'unknown-prompt' });
  });

  it('should create abilityNotFound error', () => {
    const error = McpErrorFactory.abilityNotFound('mainwp/unknown');

    expect(error.code).toBe(MCP_ERROR_CODES.ABILITY_NOT_FOUND);
    expect(error.data).toEqual({ ability: 'mainwp/unknown' });
  });

  it('should create resourceExhausted error', () => {
    const error = McpErrorFactory.resourceExhausted('Session limit exceeded');

    expect(error.code).toBe(MCP_ERROR_CODES.RESOURCE_EXHAUSTED);
  });

  it('should create timeout error', () => {
    const error = McpErrorFactory.timeout();

    expect(error.code).toBe(MCP_ERROR_CODES.TIMEOUT);
  });

  it('should create timeout error with custom message', () => {
    const error = McpErrorFactory.timeout('Connection timeout');

    expect(error.message).toBe('Connection timeout');
  });

  it('should create cancelled error', () => {
    const error = McpErrorFactory.cancelled();

    expect(error.code).toBe(MCP_ERROR_CODES.CANCELLED);
  });

  it('should create permissionDenied error', () => {
    const error = McpErrorFactory.permissionDenied();

    expect(error.code).toBe(MCP_ERROR_CODES.PERMISSION_DENIED);
  });

  it('should create unauthorized error', () => {
    const error = McpErrorFactory.unauthorized();

    expect(error.code).toBe(MCP_ERROR_CODES.UNAUTHORIZED);
  });

  it('should create rateLimited error', () => {
    const error = McpErrorFactory.rateLimited();

    expect(error.code).toBe(MCP_ERROR_CODES.RATE_LIMITED);
  });

  it('should create server error', () => {
    const error = McpErrorFactory.server('Server error');

    expect(error.code).toBe(MCP_ERROR_CODES.SERVER_ERROR);
  });

  it('should create internal error', () => {
    const error = McpErrorFactory.internal('Internal error');

    expect(error.code).toBe(MCP_ERROR_CODES.INTERNAL_ERROR);
  });
});

describe('toMcpErrorResponse', () => {
  it('should preserve McpError code', () => {
    const error = new McpError(MCP_ERROR_CODES.TIMEOUT, 'Timed out');
    const response = toMcpErrorResponse(error);

    expect(response.error.code).toBe(MCP_ERROR_CODES.TIMEOUT);
  });

  it('should apply sanitization function', () => {
    const error = new McpError(MCP_ERROR_CODES.INTERNAL_ERROR, 'Error at /secret/path');
    const sanitize = (msg: string) => msg.replace(/\/secret\/path/, '[redacted]');

    const response = toMcpErrorResponse(error, sanitize);

    expect(response.error.message).toBe('Error at [redacted]');
  });

  it('should infer code from error message keywords - cancelled', () => {
    const response = toMcpErrorResponse(new Error('Operation cancelled'));

    expect(response.error.code).toBe(MCP_ERROR_CODES.CANCELLED);
  });

  it('should infer code from error message keywords - aborted', () => {
    const response = toMcpErrorResponse(new Error('Request aborted'));

    expect(response.error.code).toBe(MCP_ERROR_CODES.CANCELLED);
  });

  it('should infer code from error message keywords - not found', () => {
    const response = toMcpErrorResponse(new Error('Resource not found'));

    expect(response.error.code).toBe(MCP_ERROR_CODES.RESOURCE_NOT_FOUND);
  });

  it('should infer code from error message keywords - limit exceeded', () => {
    const response = toMcpErrorResponse(new Error('Rate limit exceeded'));

    expect(response.error.code).toBe(MCP_ERROR_CODES.RESOURCE_EXHAUSTED);
  });

  it('should infer code from error message keywords - invalid', () => {
    // Note: case-sensitive matching uses lowercase "invalid"
    const response = toMcpErrorResponse(new Error('invalid parameter'));

    expect(response.error.code).toBe(MCP_ERROR_CODES.INVALID_PARAMS);
  });

  it('should infer code from error message keywords - unauthorized', () => {
    // Note: case-sensitive matching uses lowercase "unauthorized"
    const response = toMcpErrorResponse(new Error('unauthorized access'));

    expect(response.error.code).toBe(MCP_ERROR_CODES.UNAUTHORIZED);
  });

  it('should infer code from error message keywords - permission', () => {
    // Note: case-sensitive matching uses lowercase "permission"
    const response = toMcpErrorResponse(new Error('permission denied'));

    expect(response.error.code).toBe(MCP_ERROR_CODES.PERMISSION_DENIED);
  });

  it('should infer code from error message keywords - timeout', () => {
    const response = toMcpErrorResponse(new Error('Connection timeout'));

    expect(response.error.code).toBe(MCP_ERROR_CODES.TIMEOUT);
  });

  it('should default to INTERNAL_ERROR for unknown errors', () => {
    const response = toMcpErrorResponse(new Error('Something went wrong'));

    expect(response.error.code).toBe(MCP_ERROR_CODES.INTERNAL_ERROR);
  });

  it('should handle non-Error objects', () => {
    const response = toMcpErrorResponse('String error');

    expect(response.error.message).toBe('String error');
  });
});

describe('formatErrorResponse', () => {
  it('should return JSON string', () => {
    const error = McpErrorFactory.invalidParams('Bad input');
    const formatted = formatErrorResponse(error);

    expect(() => JSON.parse(formatted)).not.toThrow();
  });

  it('should include proper structure', () => {
    const error = McpErrorFactory.timeout();
    const formatted = formatErrorResponse(error);
    const parsed = JSON.parse(formatted);

    expect(parsed).toHaveProperty('error');
    expect(parsed.error).toHaveProperty('code');
    expect(parsed.error).toHaveProperty('message');
  });

  it('should apply sanitization', () => {
    const error = new Error('Error at /Users/test/secret');
    const sanitize = (msg: string) => msg.replace(/\/Users\/test\/secret/, '[path]');
    const formatted = formatErrorResponse(error, sanitize);

    expect(formatted).toContain('[path]');
    expect(formatted).not.toContain('/Users/test/secret');
  });

  it('should be pretty-printed', () => {
    const error = McpErrorFactory.internal('Test');
    const formatted = formatErrorResponse(error);

    // Pretty-printed JSON contains newlines
    expect(formatted).toContain('\n');
  });
});
