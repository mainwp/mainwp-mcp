/**
 * Shared test fixtures for Config and Logger.
 */

import { vi } from 'vitest';
import { type Config } from '../../src/config.js';
import { type Logger } from '../../src/logging.js';

/**
 * Build a Config fixture for tests. Returns a fresh object each call so
 * callers can freely spread/mutate the result without affecting other tests.
 */
export function makeBaseConfig(overrides: Partial<Config> = {}): Config {
  return {
    dashboardUrl: 'https://test.local',
    authType: 'basic',
    username: 'admin',
    appPassword: 'xxxx',
    skipSslVerify: true,
    allowHttp: false,
    rateLimit: 0,
    requestTimeout: 5000,
    maxResponseSize: 10485760,
    safeMode: false,
    requireUserConfirmation: true,
    maxSessionData: 52428800,
    schemaVerbosity: 'standard',
    responseFormat: 'compact',
    retryEnabled: false,
    maxRetries: 2,
    retryBaseDelay: 1000,
    retryMaxDelay: 2000,
    abilityNamespaces: ['mainwp'],
    configSource: 'environment',
    ...overrides,
  };
}

/** Build a Logger mock with all methods as vi.fn(). */
export function makeMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    critical: vi.fn(),
  };
}
