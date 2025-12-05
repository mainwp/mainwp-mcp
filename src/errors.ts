/**
 * MCP Error Handling
 *
 * Standardized error codes following JSON-RPC 2.0 specification
 * and MCP conventions for consistent error reporting.
 */

/**
 * JSON-RPC 2.0 standard error codes
 * @see https://www.jsonrpc.org/specification#error_object
 */
export const MCP_ERROR_CODES = {
  // Standard JSON-RPC errors (-32700 to -32600)
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // Server errors (reserved range: -32000 to -32099)
  SERVER_ERROR: -32000,
  TIMEOUT: -32001,
  RESOURCE_NOT_FOUND: -32002,
  TOOL_NOT_FOUND: -32003,
  PROMPT_NOT_FOUND: -32004,
  ABILITY_NOT_FOUND: -32005,
  PERMISSION_DENIED: -32008,
  UNAUTHORIZED: -32010,
  RATE_LIMITED: -32029,
  CANCELLED: -32099,
} as const;

export type McpErrorCode = typeof MCP_ERROR_CODES[keyof typeof MCP_ERROR_CODES];

/**
 * Structured error response matching MCP/JSON-RPC specification
 */
export interface McpErrorResponse {
  error: {
    code: McpErrorCode;
    message: string;
    data?: Record<string, unknown>;
  };
}

/**
 * Custom error class for MCP errors with code support
 */
export class McpError extends Error {
  readonly code: McpErrorCode;
  readonly data?: Record<string, unknown>;

  constructor(code: McpErrorCode, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
  }

  /**
   * Convert to MCP error response format
   */
  toResponse(): McpErrorResponse {
    const response: McpErrorResponse = {
      error: {
        code: this.code,
        message: this.message,
      },
    };
    if (this.data) {
      response.error.data = this.data;
    }
    return response;
  }
}

/**
 * Factory for creating common MCP errors
 */
export const McpErrorFactory = {
  /**
   * Invalid parameters error (validation failures)
   */
  invalidParams(message: string, data?: Record<string, unknown>): McpError {
    return new McpError(MCP_ERROR_CODES.INVALID_PARAMS, message, data);
  },

  /**
   * Tool not found error
   */
  toolNotFound(toolName: string): McpError {
    return new McpError(
      MCP_ERROR_CODES.TOOL_NOT_FOUND,
      `Tool not found: ${toolName}`,
      { tool: toolName }
    );
  },

  /**
   * Resource not found error
   */
  resourceNotFound(uri: string): McpError {
    return new McpError(
      MCP_ERROR_CODES.RESOURCE_NOT_FOUND,
      `Resource not found: ${uri}`,
      { uri }
    );
  },

  /**
   * Prompt not found error
   */
  promptNotFound(promptName: string): McpError {
    return new McpError(
      MCP_ERROR_CODES.PROMPT_NOT_FOUND,
      `Prompt not found: ${promptName}`,
      { prompt: promptName }
    );
  },

  /**
   * Ability not found error
   */
  abilityNotFound(abilityName: string): McpError {
    return new McpError(
      MCP_ERROR_CODES.ABILITY_NOT_FOUND,
      `Ability not found: ${abilityName}`,
      { ability: abilityName }
    );
  },

  /**
   * Internal server error
   */
  internal(message: string, data?: Record<string, unknown>): McpError {
    return new McpError(MCP_ERROR_CODES.INTERNAL_ERROR, message, data);
  },

  /**
   * Operation cancelled error
   */
  cancelled(): McpError {
    return new McpError(MCP_ERROR_CODES.CANCELLED, 'Operation cancelled');
  },

  /**
   * Permission denied error
   */
  permissionDenied(message = 'Permission denied'): McpError {
    return new McpError(MCP_ERROR_CODES.PERMISSION_DENIED, message);
  },

  /**
   * Unauthorized error
   */
  unauthorized(message = 'Unauthorized'): McpError {
    return new McpError(MCP_ERROR_CODES.UNAUTHORIZED, message);
  },

  /**
   * Rate limited error
   */
  rateLimited(): McpError {
    return new McpError(MCP_ERROR_CODES.RATE_LIMITED, 'Rate limit exceeded');
  },

  /**
   * Timeout error
   */
  timeout(message = 'Request timed out'): McpError {
    return new McpError(MCP_ERROR_CODES.TIMEOUT, message);
  },

  /**
   * Server error (generic)
   */
  server(message: string, data?: Record<string, unknown>): McpError {
    return new McpError(MCP_ERROR_CODES.SERVER_ERROR, message, data);
  },
};

/**
 * Convert any error to an MCP error response
 */
export function toMcpErrorResponse(error: unknown, sanitize?: (msg: string) => string): McpErrorResponse {
  if (error instanceof McpError) {
    // If sanitize function provided, apply it to the message
    if (sanitize) {
      return {
        error: {
          code: error.code,
          message: sanitize(error.message),
          ...(error.data && { data: error.data }),
        },
      };
    }
    return error.toResponse();
  }

  const message = error instanceof Error ? error.message : String(error);
  const sanitizedMessage = sanitize ? sanitize(message) : message;

  // Try to infer error code from message
  let code: McpErrorCode = MCP_ERROR_CODES.INTERNAL_ERROR;

  if (message.includes('cancelled') || message.includes('aborted')) {
    code = MCP_ERROR_CODES.CANCELLED;
  } else if (message.includes('not found') || message.includes('Unknown')) {
    code = MCP_ERROR_CODES.RESOURCE_NOT_FOUND;
  } else if (message.includes('invalid') || message.includes('must be') || message.includes('exceeds')) {
    code = MCP_ERROR_CODES.INVALID_PARAMS;
  } else if (message.includes('unauthorized') || message.includes('authentication')) {
    code = MCP_ERROR_CODES.UNAUTHORIZED;
  } else if (message.includes('permission') || message.includes('forbidden')) {
    code = MCP_ERROR_CODES.PERMISSION_DENIED;
  } else if (message.includes('timeout')) {
    code = MCP_ERROR_CODES.TIMEOUT;
  }

  return {
    error: {
      code,
      message: sanitizedMessage,
    },
  };
}

/**
 * Format an MCP error response as JSON string for tool responses
 */
export function formatErrorResponse(error: unknown, sanitize?: (msg: string) => string): string {
  return JSON.stringify(toMcpErrorResponse(error, sanitize), null, 2);
}
