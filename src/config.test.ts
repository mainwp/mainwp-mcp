/**
 * Configuration Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadConfig,
  loadSettingsFile,
  getAbilitiesApiUrl,
  getAuthHeaders,
  type Config,
} from './config.js';
import fs from 'fs';

// Import test fixtures for validation tests
import configFixture from '../tests/fixtures/config.json' with { type: 'json' };

// Mock fs module
vi.mock('fs');

describe('loadSettingsFile', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return null if no file found', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = loadSettingsFile();

    expect(result).toBeNull();
  });

  it('should load from CWD first', () => {
    const settings = { dashboardUrl: 'https://test.com' };

    vi.mocked(fs.existsSync).mockImplementation(path => {
      return String(path).includes(process.cwd());
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(settings));

    const result = loadSettingsFile();

    expect(result?.dashboardUrl).toBe('https://test.com');
  });

  it('should throw on invalid JSON', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('not valid json');

    expect(() => loadSettingsFile()).toThrow(/Invalid JSON/);
  });

  it('should validate field types - string fields', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ dashboardUrl: 123 }));

    expect(() => loadSettingsFile()).toThrow(/must be a string/);
  });

  it('should validate field types - boolean fields', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ skipSslVerify: 'yes' }));

    expect(() => loadSettingsFile()).toThrow(/must be a boolean/);
  });

  it('should validate field types - number fields', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ rateLimit: 'fast' }));

    expect(() => loadSettingsFile()).toThrow(/must be a number/);
  });

  it('should validate field types - array fields', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ allowedTools: 'not-array' }));

    expect(() => loadSettingsFile()).toThrow(/must be an array/);
  });

  it('should detect unknown fields', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ unknownField: 'value' }));

    expect(() => loadSettingsFile()).toThrow(/Unknown field/);
  });

  it('should validate schemaVerbosity enum', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ schemaVerbosity: 'invalid' }));

    expect(() => loadSettingsFile()).toThrow(/schemaVerbosity/);
  });

  it('should load fixture config file successfully', () => {
    // Use the shared fixture to verify it matches the expected schema
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(configFixture));

    const result = loadSettingsFile();

    expect(result).not.toBeNull();
    expect(result?.dashboardUrl).toBe(configFixture.dashboardUrl);
    expect(result?.username).toBe(configFixture.username);
    expect(result?.skipSslVerify).toBe(configFixture.skipSslVerify);
  });
});

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env = { ...originalEnv };
    // Mock fs to return no settings file
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('should require MAINWP_URL', () => {
    process.env = {};

    expect(() => loadConfig()).toThrow(/MAINWP_URL is required/);
  });

  it('should require authentication credentials', () => {
    process.env.MAINWP_URL = 'https://test.com';

    expect(() => loadConfig()).toThrow(/Authentication required/);
  });

  it('should load config with basic auth', () => {
    process.env.MAINWP_URL = 'https://test.com';
    process.env.MAINWP_USER = 'admin';
    process.env.MAINWP_APP_PASSWORD = 'xxxx xxxx';

    const config = loadConfig();

    expect(config.authType).toBe('basic');
    expect(config.username).toBe('admin');
    expect(config.appPassword).toBe('xxxx xxxx');
  });

  it('should load config with bearer auth', () => {
    process.env.MAINWP_URL = 'https://test.com';
    process.env.MAINWP_TOKEN = 'mytoken123';

    const config = loadConfig();

    expect(config.authType).toBe('bearer');
    expect(config.apiToken).toBe('mytoken123');
  });

  it('should prefer basic auth over bearer auth', () => {
    process.env.MAINWP_URL = 'https://test.com';
    process.env.MAINWP_USER = 'admin';
    process.env.MAINWP_APP_PASSWORD = 'xxxx';
    process.env.MAINWP_TOKEN = 'token';

    const config = loadConfig();

    expect(config.authType).toBe('basic');
  });

  it('should validate URL format', () => {
    process.env.MAINWP_URL = 'not-a-valid-url';
    process.env.MAINWP_USER = 'admin';
    process.env.MAINWP_APP_PASSWORD = 'xxxx';

    expect(() => loadConfig()).toThrow(/Invalid dashboardUrl/);
  });

  it('should block HTTP without allowHttp flag', () => {
    process.env.MAINWP_URL = 'http://test.com';
    process.env.MAINWP_USER = 'admin';
    process.env.MAINWP_APP_PASSWORD = 'xxxx';

    expect(() => loadConfig()).toThrow(/HTTP.*plain text/);
  });

  it('should allow HTTP with allowHttp flag', () => {
    process.env.MAINWP_URL = 'http://test.com';
    process.env.MAINWP_USER = 'admin';
    process.env.MAINWP_APP_PASSWORD = 'xxxx';
    process.env.MAINWP_ALLOW_HTTP = 'true';

    const config = loadConfig();

    expect(config.dashboardUrl).toBe('http://test.com');
    expect(config.allowHttp).toBe(true);
  });

  it('should normalize URL by removing trailing slash', () => {
    process.env.MAINWP_URL = 'https://test.com/';
    process.env.MAINWP_USER = 'admin';
    process.env.MAINWP_APP_PASSWORD = 'xxxx';

    const config = loadConfig();

    expect(config.dashboardUrl).toBe('https://test.com');
  });

  it('should use default values for optional settings', () => {
    process.env.MAINWP_URL = 'https://test.com';
    process.env.MAINWP_USER = 'admin';
    process.env.MAINWP_APP_PASSWORD = 'xxxx';

    const config = loadConfig();

    expect(config.rateLimit).toBe(60);
    expect(config.requestTimeout).toBe(30000);
    expect(config.maxResponseSize).toBe(10485760);
    expect(config.abilityNamespace).toBe('mainwp');
    expect(config.schemaVerbosity).toBe('standard');
    expect(config.retryEnabled).toBe(true);
    expect(config.maxRetries).toBe(2);
    expect(config.retryBaseDelay).toBe(1000);
    expect(config.retryMaxDelay).toBe(2000);
  });

  it('should parse rate limit from env', () => {
    process.env.MAINWP_URL = 'https://test.com';
    process.env.MAINWP_USER = 'admin';
    process.env.MAINWP_APP_PASSWORD = 'xxxx';
    process.env.MAINWP_RATE_LIMIT = '120';

    const config = loadConfig();

    expect(config.rateLimit).toBe(120);
  });

  it('should reject negative rate limit', () => {
    process.env.MAINWP_URL = 'https://test.com';
    process.env.MAINWP_USER = 'admin';
    process.env.MAINWP_APP_PASSWORD = 'xxxx';
    process.env.MAINWP_RATE_LIMIT = '-1';

    expect(() => loadConfig()).toThrow(/MAINWP_RATE_LIMIT/);
  });

  it('should reject maxRetries exceeding upper bound', () => {
    process.env.MAINWP_URL = 'https://test.com';
    process.env.MAINWP_USER = 'admin';
    process.env.MAINWP_APP_PASSWORD = 'xxxx';
    process.env.MAINWP_MAX_RETRIES = '10';

    expect(() => loadConfig()).toThrow(/MAINWP_MAX_RETRIES must be between 1 and 5/);
  });

  it('should reject retryBaseDelay below minimum bound', () => {
    process.env.MAINWP_URL = 'https://test.com';
    process.env.MAINWP_USER = 'admin';
    process.env.MAINWP_APP_PASSWORD = 'xxxx';
    process.env.MAINWP_RETRY_BASE_DELAY = '100';

    expect(() => loadConfig()).toThrow(/MAINWP_RETRY_BASE_DELAY must be between 500ms and 10000ms/);
  });

  it('should reject retryBaseDelay exceeding upper bound', () => {
    process.env.MAINWP_URL = 'https://test.com';
    process.env.MAINWP_USER = 'admin';
    process.env.MAINWP_APP_PASSWORD = 'xxxx';
    process.env.MAINWP_RETRY_BASE_DELAY = '20000';

    expect(() => loadConfig()).toThrow(/MAINWP_RETRY_BASE_DELAY must be between 500ms and 10000ms/);
  });

  it('should reject retryMaxDelay exceeding upper bound', () => {
    process.env.MAINWP_URL = 'https://test.com';
    process.env.MAINWP_USER = 'admin';
    process.env.MAINWP_APP_PASSWORD = 'xxxx';
    process.env.MAINWP_RETRY_MAX_DELAY = '60000';

    expect(() => loadConfig()).toThrow(/MAINWP_RETRY_MAX_DELAY must be between.*and 30000ms/);
  });

  it('should accept valid retry configuration at boundaries', () => {
    process.env.MAINWP_URL = 'https://test.com';
    process.env.MAINWP_USER = 'admin';
    process.env.MAINWP_APP_PASSWORD = 'xxxx';
    process.env.MAINWP_MAX_RETRIES = '5';
    process.env.MAINWP_RETRY_BASE_DELAY = '500';
    process.env.MAINWP_RETRY_MAX_DELAY = '30000';

    const config = loadConfig();

    expect(config.maxRetries).toBe(5);
    expect(config.retryBaseDelay).toBe(500);
    expect(config.retryMaxDelay).toBe(30000);
  });

  it('should parse allowed/blocked tools from env', () => {
    process.env.MAINWP_URL = 'https://test.com';
    process.env.MAINWP_USER = 'admin';
    process.env.MAINWP_APP_PASSWORD = 'xxxx';
    process.env.MAINWP_ALLOWED_TOOLS = 'list_sites_v1, get_site_v1';

    const config = loadConfig();

    expect(config.allowedTools).toEqual(['list_sites_v1', 'get_site_v1']);
  });

  it('should detect tool allow/block conflicts', () => {
    process.env.MAINWP_URL = 'https://test.com';
    process.env.MAINWP_USER = 'admin';
    process.env.MAINWP_APP_PASSWORD = 'xxxx';
    process.env.MAINWP_ALLOWED_TOOLS = 'list_sites_v1';
    process.env.MAINWP_BLOCKED_TOOLS = 'list_sites_v1';

    expect(() => loadConfig()).toThrow(/conflict/);
  });

  it('should prioritize env vars over settings file', () => {
    const settings = { dashboardUrl: 'https://from-file.com' };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(settings));

    process.env.MAINWP_URL = 'https://from-env.com';
    process.env.MAINWP_USER = 'admin';
    process.env.MAINWP_APP_PASSWORD = 'xxxx';

    const config = loadConfig();

    expect(config.dashboardUrl).toBe('https://from-env.com');
  });
});

describe('getAbilitiesApiUrl', () => {
  it('should construct proper URL', () => {
    const config: Config = {
      dashboardUrl: 'https://example.com',
      authType: 'basic',
      skipSslVerify: false,
      allowHttp: false,
      rateLimit: 60,
      abilityNamespace: 'mainwp',
      requestTimeout: 30000,
      maxResponseSize: 10485760,
      safeMode: false,
      requireUserConfirmation: true,
      maxSessionData: 52428800,
      schemaVerbosity: 'standard',
      retryEnabled: true,
      maxRetries: 2,
      retryBaseDelay: 1000,
      retryMaxDelay: 2000,
      configSource: 'environment',
    };

    const url = getAbilitiesApiUrl(config);

    expect(url).toBe('https://example.com/wp-json/wp-abilities/v1');
  });
});

describe('getAuthHeaders', () => {
  it('should return Basic auth header', () => {
    const config: Config = {
      dashboardUrl: 'https://example.com',
      authType: 'basic',
      username: 'admin',
      appPassword: 'secret',
      skipSslVerify: false,
      allowHttp: false,
      rateLimit: 60,
      abilityNamespace: 'mainwp',
      requestTimeout: 30000,
      maxResponseSize: 10485760,
      safeMode: false,
      requireUserConfirmation: true,
      maxSessionData: 52428800,
      schemaVerbosity: 'standard',
      retryEnabled: true,
      maxRetries: 2,
      retryBaseDelay: 1000,
      retryMaxDelay: 2000,
      configSource: 'environment',
    };

    const headers = getAuthHeaders(config);

    expect(headers['Authorization']).toContain('Basic');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('should return Bearer auth header', () => {
    const config: Config = {
      dashboardUrl: 'https://example.com',
      authType: 'bearer',
      apiToken: 'mytoken',
      skipSslVerify: false,
      allowHttp: false,
      rateLimit: 60,
      abilityNamespace: 'mainwp',
      requestTimeout: 30000,
      maxResponseSize: 10485760,
      safeMode: false,
      requireUserConfirmation: true,
      maxSessionData: 52428800,
      schemaVerbosity: 'standard',
      retryEnabled: true,
      maxRetries: 2,
      retryBaseDelay: 1000,
      retryMaxDelay: 2000,
      configSource: 'environment',
    };

    const headers = getAuthHeaders(config);

    expect(headers['Authorization']).toBe('Bearer mytoken');
  });

  it('should always include Content-Type', () => {
    const config: Config = {
      dashboardUrl: 'https://example.com',
      authType: 'basic',
      skipSslVerify: false,
      allowHttp: false,
      rateLimit: 60,
      abilityNamespace: 'mainwp',
      requestTimeout: 30000,
      maxResponseSize: 10485760,
      safeMode: false,
      requireUserConfirmation: true,
      maxSessionData: 52428800,
      schemaVerbosity: 'standard',
      retryEnabled: true,
      maxRetries: 2,
      retryBaseDelay: 1000,
      retryMaxDelay: 2000,
      configSource: 'environment',
    };

    const headers = getAuthHeaders(config);

    expect(headers['Content-Type']).toBe('application/json');
  });

  it('should encode Basic auth credentials correctly', () => {
    const config: Config = {
      dashboardUrl: 'https://example.com',
      authType: 'basic',
      username: 'user',
      appPassword: 'pass',
      skipSslVerify: false,
      allowHttp: false,
      rateLimit: 60,
      abilityNamespace: 'mainwp',
      requestTimeout: 30000,
      maxResponseSize: 10485760,
      safeMode: false,
      requireUserConfirmation: true,
      maxSessionData: 52428800,
      schemaVerbosity: 'standard',
      retryEnabled: true,
      maxRetries: 2,
      retryBaseDelay: 1000,
      retryMaxDelay: 2000,
      configSource: 'environment',
    };

    const headers = getAuthHeaders(config);
    const encoded = headers['Authorization'].replace('Basic ', '');
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');

    expect(decoded).toBe('user:pass');
  });
});
