/**
 * Configuration Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadConfig,
  loadSettingsFile,
  getAbilitiesApiUrl,
  getAuthHeaders,
  MissingConfigError,
  type Config,
} from './config.js';
import fs from 'fs';

// Import test fixtures for validation tests
import configFixture from '../tests/fixtures/config.json' with { type: 'json' };
import { makeBaseConfig } from '../tests/helpers/config.js';

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

  it('should reject non-finite numbers (JSON 1e999 parses to Infinity)', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('{"maxResponseSize": 1e999}');

    expect(() => loadSettingsFile()).toThrow(/must be an integer within the safe range/);
  });

  it('should reject decimal numbers in settings file', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ rateLimit: 60.5 }));

    expect(() => loadSettingsFile()).toThrow(/must be an integer within the safe range/);
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

  it('should validate responseFormat enum', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ responseFormat: 'invalid' }));

    expect(() => loadSettingsFile()).toThrow(/responseFormat/);
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

  it('should throw MissingConfigError for missing URL so the CLI can show setup guidance', () => {
    process.env = {};

    try {
      loadConfig();
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingConfigError);
      expect((error as MissingConfigError).missing).toBe('MAINWP_URL');
    }
  });

  it('should require authentication credentials', () => {
    process.env.MAINWP_URL = 'https://test.com';

    expect(() => loadConfig()).toThrow(/Authentication required/);
  });

  it('should throw MissingConfigError for missing credentials so the CLI can show setup guidance', () => {
    process.env.MAINWP_URL = 'https://test.com';

    try {
      loadConfig();
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingConfigError);
      expect((error as MissingConfigError).missing).toBe('credentials');
    }
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
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Application Password'));
  });

  it('should warn when bearer auth is selected with only a partial basic auth pair', () => {
    process.env.MAINWP_URL = 'https://test.com';
    process.env.MAINWP_USER = 'admin';
    process.env.MAINWP_TOKEN = 'mytoken123';

    const config = loadConfig();

    expect(config.authType).toBe('bearer');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Application Password'));
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
    expect(config.schemaVerbosity).toBe('standard');
    expect(config.responseFormat).toBe('compact');
    expect(config.retryEnabled).toBe(true);
    expect(config.maxRetries).toBe(2);
    expect(config.retryBaseDelay).toBe(1000);
    expect(config.retryMaxDelay).toBe(2000);
  });

  it('should parse responseFormat from env', () => {
    process.env.MAINWP_URL = 'https://test.com';
    process.env.MAINWP_USER = 'admin';
    process.env.MAINWP_APP_PASSWORD = 'xxxx';
    process.env.MAINWP_RESPONSE_FORMAT = 'pretty';

    const config = loadConfig();

    expect(config.responseFormat).toBe('pretty');
  });

  it('should reject invalid responseFormat', () => {
    process.env.MAINWP_URL = 'https://test.com';
    process.env.MAINWP_USER = 'admin';
    process.env.MAINWP_APP_PASSWORD = 'xxxx';
    process.env.MAINWP_RESPONSE_FORMAT = 'invalid';

    expect(() => loadConfig()).toThrow(/MAINWP_RESPONSE_FORMAT/);
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

  function baseEnv() {
    process.env.MAINWP_URL = 'https://test.com';
    process.env.MAINWP_USER = 'admin';
    process.env.MAINWP_APP_PASSWORD = 'xxxx';
  }

  describe('boolean env var parsing', () => {
    it.each(['true', 'TRUE', 'True', '1', 'yes', 'on', 'ON'])('parses %s as true', value => {
      baseEnv();
      process.env.MAINWP_SAFE_MODE = value;

      expect(loadConfig().safeMode).toBe(true);
    });

    it.each(['false', 'FALSE', '0', 'no', 'off'])('parses %s as false', value => {
      baseEnv();
      process.env.MAINWP_REQUIRE_USER_CONFIRMATION = value;

      expect(loadConfig().requireUserConfirmation).toBe(false);
    });

    it('throws on an unrecognized value instead of falling back to the default', () => {
      baseEnv();
      process.env.MAINWP_SAFE_MODE = 'maybe';

      expect(() => loadConfig()).toThrow(/MAINWP_SAFE_MODE.*maybe/);
    });

    it('throws when a malformed env value overrides a permissive settings-file value', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ allowHttp: true }));
      baseEnv();
      process.env.MAINWP_ALLOW_HTTP = 'flase';

      expect(() => loadConfig()).toThrow(/MAINWP_ALLOW_HTTP.*flase/);
    });
  });

  describe('numeric env var parsing', () => {
    it('rejects values with trailing non-numeric characters', () => {
      baseEnv();
      process.env.MAINWP_RATE_LIMIT = '60abc';

      expect(() => loadConfig()).toThrow(/MAINWP_RATE_LIMIT.*60abc/);
    });

    it('rejects entirely non-numeric values', () => {
      baseEnv();
      process.env.MAINWP_REQUEST_TIMEOUT = 'abc';

      expect(() => loadConfig()).toThrow(/MAINWP_REQUEST_TIMEOUT.*abc/);
    });

    it('accepts clean integer values', () => {
      baseEnv();
      process.env.MAINWP_RATE_LIMIT = '120';

      expect(loadConfig().rateLimit).toBe(120);
    });

    it('rejects digit-only values that overflow to Infinity', () => {
      baseEnv();
      process.env.MAINWP_REQUEST_TIMEOUT = '9'.repeat(400);

      expect(() => loadConfig()).toThrow(/MAINWP_REQUEST_TIMEOUT.*safe integer/);
    });
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

  describe('abilityNamespaces', () => {
    function envOnlyConfig() {
      process.env.MAINWP_URL = 'https://test.com';
      process.env.MAINWP_USER = 'admin';
      process.env.MAINWP_APP_PASSWORD = 'xxxx';
    }

    it('defaults to ["mainwp"] when nothing is set', () => {
      envOnlyConfig();
      const config = loadConfig();
      expect(config.abilityNamespaces).toEqual(['mainwp']);
    });

    it('parses comma-separated env var', () => {
      envOnlyConfig();
      process.env.MAINWP_ABILITY_NAMESPACES = 'mainwp,acme,beta-test';

      const config = loadConfig();
      expect(config.abilityNamespaces).toEqual(['mainwp', 'acme', 'beta-test']);
    });

    it('uses settings.json value when env var is unset', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          dashboardUrl: 'https://test.com',
          username: 'admin',
          appPassword: 'xxxx',
          abilityNamespaces: ['mainwp', 'acme'],
        })
      );

      const config = loadConfig();
      expect(config.abilityNamespaces).toEqual(['mainwp', 'acme']);
    });

    it('env var beats settings file', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          dashboardUrl: 'https://from-file.com',
          username: 'admin',
          appPassword: 'xxxx',
          abilityNamespaces: ['from-file'],
        })
      );
      process.env.MAINWP_URL = 'https://test.com';
      process.env.MAINWP_ABILITY_NAMESPACES = 'from-env';

      const config = loadConfig();
      expect(config.abilityNamespaces).toEqual(['from-env']);
    });

    it('rejects invalid namespace charset', () => {
      envOnlyConfig();
      process.env.MAINWP_ABILITY_NAMESPACES = 'mainwp,BadCase';

      expect(() => loadConfig()).toThrow(/abilityNamespaces.*BadCase/);
    });

    it('rejects namespaces with leading or trailing hyphens', () => {
      envOnlyConfig();
      process.env.MAINWP_ABILITY_NAMESPACES = 'mainwp,-acme';
      expect(() => loadConfig()).toThrow(/abilityNamespaces.*-acme/);

      process.env.MAINWP_ABILITY_NAMESPACES = 'mainwp,acme-';
      expect(() => loadConfig()).toThrow(/abilityNamespaces.*acme-/);
    });

    it('rejects empty array in settings.json', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          dashboardUrl: 'https://test.com',
          username: 'admin',
          appPassword: 'xxxx',
          abilityNamespaces: [],
        })
      );

      expect(() => loadConfig()).toThrow(/abilityNamespaces.*not be empty/);
    });

    it('deduplicates repeated env-var entries while preserving order', () => {
      envOnlyConfig();
      process.env.MAINWP_ABILITY_NAMESPACES = 'mainwp,mainwp,acme,mainwp';

      const config = loadConfig();
      expect(config.abilityNamespaces).toEqual(['mainwp', 'acme']);
    });

    it('attributes the empty-list error to the env var when the env var was all-blank', () => {
      envOnlyConfig();
      process.env.MAINWP_ABILITY_NAMESPACES = ',,';

      expect(() => loadConfig()).toThrow(/MAINWP_ABILITY_NAMESPACES/);
    });
  });
});

describe('getAbilitiesApiUrl', () => {
  it('should construct proper URL', () => {
    const config: Config = makeBaseConfig({
      dashboardUrl: 'https://example.com',
      skipSslVerify: false,
      rateLimit: 60,
      requestTimeout: 30000,
      retryEnabled: true,
    });

    const url = getAbilitiesApiUrl(config);

    expect(url).toBe('https://example.com/wp-json/wp-abilities/v1');
  });
});

describe('getAuthHeaders', () => {
  it('should return Basic auth header', () => {
    const config: Config = makeBaseConfig({
      dashboardUrl: 'https://example.com',
      appPassword: 'secret',
      skipSslVerify: false,
      rateLimit: 60,
      requestTimeout: 30000,
      retryEnabled: true,
    });

    const headers = getAuthHeaders(config);

    expect(headers['Authorization']).toContain('Basic');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('should return Bearer auth header', () => {
    const config: Config = makeBaseConfig({
      dashboardUrl: 'https://example.com',
      authType: 'bearer',
      apiToken: 'mytoken',
      skipSslVerify: false,
      rateLimit: 60,
      requestTimeout: 30000,
      retryEnabled: true,
    });

    const headers = getAuthHeaders(config);

    expect(headers['Authorization']).toBe('Bearer mytoken');
  });

  it('should always include Content-Type', () => {
    const config: Config = makeBaseConfig({
      dashboardUrl: 'https://example.com',
      skipSslVerify: false,
      rateLimit: 60,
      requestTimeout: 30000,
      retryEnabled: true,
    });

    const headers = getAuthHeaders(config);

    expect(headers['Content-Type']).toBe('application/json');
  });

  it('should encode Basic auth credentials correctly', () => {
    const config: Config = makeBaseConfig({
      dashboardUrl: 'https://example.com',
      username: 'user',
      appPassword: 'pass',
      skipSslVerify: false,
      rateLimit: 60,
      requestTimeout: 30000,
      retryEnabled: true,
    });

    const headers = getAuthHeaders(config);
    const encoded = headers['Authorization'].replace('Basic ', '');
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');

    expect(decoded).toBe('user:pass');
  });
});
