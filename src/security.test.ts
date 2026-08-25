/**
 * Security Utilities Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateInput,
  sanitizeError,
  appPasswordSecret,
  canRegisterKnownSecrets,
  registerKnownSecrets,
  clearKnownSecrets,
  createSecretRedactor,
  redactStringsDeep,
  DEPTH_LIMIT_MARKER,
  RateLimiter,
  isValidId,
} from './security.js';

describe('validateInput', () => {
  it('should accept valid input', () => {
    expect(() => validateInput({ name: 'test', count: 5 })).not.toThrow();
  });

  it('should reject strings exceeding MAX_STRING_LENGTH', () => {
    const longString = 'a'.repeat(10001);
    expect(() => validateInput({ field: longString })).toThrow(/exceeds maximum length/);
  });

  it('should accept strings at MAX_STRING_LENGTH', () => {
    const maxString = 'a'.repeat(10000);
    expect(() => validateInput({ field: maxString })).not.toThrow();
  });

  it('should honor a larger schema maxLength for a string parameter', () => {
    const schema = {
      type: 'object',
      properties: { plan_json: { type: 'string', maxLength: 1_048_576 } },
    };
    expect(() => validateInput({ plan_json: 'a'.repeat(22_246) }, schema)).not.toThrow();
  });

  it('should reject a string above its declared schema maxLength', () => {
    const schema = {
      type: 'object',
      properties: { plan_json: { type: 'string', maxLength: 20_000 } },
    };
    expect(() => validateInput({ plan_json: 'a'.repeat(20_001) }, schema)).toThrow(
      /maximum length \(20000 characters\)/
    );
  });

  it('should honor schema maxLength values below the connector default', () => {
    const schema = {
      type: 'object',
      properties: { label: { type: 'string', maxLength: 5 } },
    };
    expect(() => validateInput({ label: '123456' }, schema)).toThrow(
      /maximum length \(5 characters\)/
    );
  });

  it('should cap hostile schema maxLength values at the absolute limit', () => {
    const schema = {
      type: 'object',
      properties: { payload: { type: 'string', maxLength: Number.MAX_SAFE_INTEGER } },
    };
    expect(() => validateInput({ payload: 'a'.repeat(100 * 1024 * 1024 + 1) }, schema)).toThrow(
      /maximum length \(104857600 characters\)/
    );
  });

  it('should apply nested object and array item string schemas', () => {
    const schema = {
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: { payload: { type: 'string', maxLength: 20_000 } },
        },
        payloads: {
          type: 'array',
          items: { type: 'string', maxLength: 20_000 },
        },
      },
    };
    const payload = 'a'.repeat(15_000);
    expect(() => validateInput({ nested: { payload }, payloads: [payload] }, schema)).not.toThrow();
  });

  it('should apply string schemas through nested arrays', () => {
    const schema = {
      type: 'object',
      properties: {
        payloads: {
          type: 'array',
          items: {
            type: 'array',
            items: { type: 'string', maxLength: 20_000 },
          },
        },
      },
    };
    expect(() => validateInput({ payloads: [['a'.repeat(15_000)]] }, schema)).not.toThrow();
    expect(() => validateInput({ payloads: [['a'.repeat(20_001)]] }, schema)).toThrow(
      /maximum length \(20000 characters\)/
    );
  });

  it('should enforce the depth limit through nested arrays', () => {
    const nestedArrays = [[[[[[['too deep']]]]]]];
    expect(() => validateInput({ nested: nestedArrays })).toThrow(/maximum nesting depth/);
  });

  it('should reject arrays exceeding MAX_ARRAY_ELEMENTS', () => {
    const largeArray = new Array(1001).fill('item');
    expect(() => validateInput({ items: largeArray })).toThrow(/too many elements/);
  });

  it('should accept arrays at MAX_ARRAY_ELEMENTS', () => {
    const maxArray = new Array(1000).fill('item');
    expect(() => validateInput({ items: maxArray })).not.toThrow();
  });

  it('should reject long strings in array elements', () => {
    const longString = 'a'.repeat(10001);
    expect(() => validateInput({ items: [longString] })).toThrow(/exceeds maximum length/);
  });

  it('should reject objects exceeding MAX_OBJECT_DEPTH', () => {
    // MAX_OBJECT_DEPTH is 5, so we need more than 5 levels
    // The nested parameter itself adds 1 level, so we need 6+ levels in deepObject
    const deepObject = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } };
    expect(() => validateInput({ nested: deepObject })).toThrow(/maximum nesting depth/);
  });

  it('should accept objects at MAX_OBJECT_DEPTH', () => {
    // MAX_OBJECT_DEPTH is 5, nested adds 1 level, so 4 more levels should be ok
    const validDepth = { a: { b: { c: { d: 'valid' } } } };
    expect(() => validateInput({ nested: validDepth })).not.toThrow();
  });

  it('should validate positive integer IDs for *_id fields', () => {
    expect(() => validateInput({ site_id: 123 })).not.toThrow();
    expect(() => validateInput({ site_id: '123' })).not.toThrow();
  });

  it('should honor a string schema for non-numeric *_id identifiers', () => {
    const schema = {
      type: 'object',
      properties: {
        rollout_id: { type: 'string', pattern: '^[A-Za-z0-9._-]+$' },
      },
    };
    expect(() =>
      validateInput({ rollout_id: 'mrnwebdesigns-canary-2026-08-23-r1' }, schema)
    ).not.toThrow();
  });

  it('should keep numeric ID validation when the schema declares an integer', () => {
    const schema = {
      type: 'object',
      properties: {
        site_id: { type: 'integer', minimum: 1 },
        site_ids: { type: 'array', items: { type: 'integer', minimum: 1 } },
      },
    };
    expect(() => validateInput({ site_id: 85, site_ids: [85] }, schema)).not.toThrow();
    expect(() => validateInput({ site_id: 'not-numeric' }, schema)).toThrow(
      /must be a positive integer/
    );
    expect(() => validateInput({ site_ids: ['not-numeric'] }, schema)).toThrow(
      /must be a positive integer/
    );
  });

  it('should reject non-positive IDs', () => {
    expect(() => validateInput({ site_id: 0 })).toThrow(/must be a positive integer/);
    expect(() => validateInput({ site_id: -1 })).toThrow(/must be a positive integer/);
  });

  it('should reject non-integer IDs', () => {
    expect(() => validateInput({ site_id: 1.5 })).toThrow(/must be a positive integer/);
  });

  it('should reject non-string/non-number _id values', () => {
    expect(() => validateInput({ site_id: null })).toThrow(/must be a string or number/);
    expect(() => validateInput({ site_id: true })).toThrow(/must be a string or number/);
    expect(() => validateInput({ site_id: {} })).toThrow(/must be a string or number/);
    expect(() => validateInput({ site_id: [1] })).toThrow(/must be a string or number/);
  });

  it('should reject _id strings with trailing non-numeric characters', () => {
    expect(() => validateInput({ site_id: '12abc' })).toThrow(/must be a positive integer/);
  });

  it('should reject _id strings with non-decimal numeric syntax', () => {
    expect(() => validateInput({ site_id: '1e3' })).toThrow(/must be a positive integer/);
    expect(() => validateInput({ site_id: '0x10' })).toThrow(/must be a positive integer/);
  });

  it('should accept valid plural ID arrays', () => {
    expect(() => validateInput({ site_ids: [1, 2, 3] })).not.toThrow();
    expect(() => validateInput({ site_ids: ['1', '2', '3'] })).not.toThrow();
  });

  it('should reject non-array values for plural ID fields', () => {
    expect(() => validateInput({ site_ids: '123' })).toThrow(/must be an array/);
    expect(() => validateInput({ site_ids: 123 })).toThrow(/must be an array/);
    expect(() => validateInput({ site_ids: { id: 1 } })).toThrow(/must be an array/);
  });

  it('should reject non-positive elements in plural ID arrays', () => {
    expect(() => validateInput({ site_ids: [0] })).toThrow(/must be a positive integer/);
    expect(() => validateInput({ site_ids: [-1] })).toThrow(/must be a positive integer/);
    expect(() => validateInput({ site_ids: [1.5] })).toThrow(/must be a positive integer/);
  });

  it('should reject non-string/non-number elements in plural ID arrays', () => {
    expect(() => validateInput({ site_ids: [null] })).toThrow(/must be a string or number/);
    expect(() => validateInput({ site_ids: [undefined] })).toThrow(/must be a string or number/);
    expect(() => validateInput({ site_ids: [true] })).toThrow(/must be a string or number/);
    expect(() => validateInput({ site_ids: [{ id: 1 }] })).toThrow(/must be a string or number/);
  });

  it('should reject non-numeric strings in plural ID arrays', () => {
    expect(() => validateInput({ site_ids: ['abc'] })).toThrow(/must be a positive integer/);
    expect(() => validateInput({ site_ids: ['1abc'] })).toThrow(/must be a positive integer/);
  });

  it('should accept valid nested objects', () => {
    expect(() =>
      validateInput({
        config: {
          settings: {
            enabled: true,
          },
        },
      })
    ).not.toThrow();
  });
});

describe('sanitizeError', () => {
  it('should remove Unix file paths', () => {
    const message = 'Error at /Users/john/project/file.ts';
    expect(sanitizeError(message)).toContain('[path]');
    expect(sanitizeError(message)).not.toContain('/Users');
  });

  it('should remove various Unix paths', () => {
    expect(sanitizeError('File: /home/user/test')).toContain('[path]');
    expect(sanitizeError('File: /var/log/error.log')).toContain('[path]');
    expect(sanitizeError('File: /tmp/temp.txt')).toContain('[path]');
    expect(sanitizeError('File: /opt/app/run')).toContain('[path]');
  });

  it('should remove Windows paths', () => {
    const message = 'Error at C:\\Users\\john\\project\\file.ts';
    expect(sanitizeError(message)).toContain('[path]');
    expect(sanitizeError(message)).not.toContain('C:\\');
  });

  it('should redact credentials in URLs', () => {
    const message = 'Connecting to https://user:password@example.com';
    const sanitized = sanitizeError(message);
    expect(sanitized).toContain('[redacted]@');
    expect(sanitized).not.toContain('password');
  });

  it('should redact Bearer tokens', () => {
    const message = 'Authorization: Bearer abc123xyz456';
    const sanitized = sanitizeError(message);
    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toContain('abc123xyz456');
  });

  it('should redact HTTP Basic credentials in an Authorization header', () => {
    const message = 'Request failed: Authorization: Basic dXNlcjphcHAtcGFzc3dvcmQ=';
    const sanitized = sanitizeError(message);
    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toContain('dXNlcjphcHAtcGFzc3dvcmQ=');
  });

  it('should redact a standalone HTTP Basic credential blob', () => {
    const message = 'Upstream echoed header Basic YWRtaW46c2VjcmV0cGFzc3dvcmQxMjM0';
    const sanitized = sanitizeError(message);
    expect(sanitized).toContain('Basic [redacted]');
    expect(sanitized).not.toContain('YWRtaW46c2VjcmV0cGFzc3dvcmQxMjM0');
  });

  it('should redact a PHP $_SERVER HTTP_AUTHORIZATION dump', () => {
    const message = 'HTTP_AUTHORIZATION => Basic dXNlcjphcHAtcGFzc3dvcmQ=';
    const sanitized = sanitizeError(message);
    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toContain('dXNlcjphcHAtcGFzc3dvcmQ=');
  });

  it('should redact a spaced WordPress app password without leaking past the first space', () => {
    // WordPress application passwords display as six space-separated groups of 4.
    const message = 'app_password: abcd efgh ijkl mnop qrst uvwx';
    const sanitized = sanitizeError(message);
    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toContain('efgh');
    expect(sanitized).not.toContain('uvwx');
  });

  it('should not over-redact ordinary "Basic <word>" prose', () => {
    const message = 'Basic authentication failed for the request';
    const sanitized = sanitizeError(message);
    expect(sanitized).toBe('Basic authentication failed for the request');
  });

  it('should redact sensitive key-value patterns', () => {
    const message = 'MAINWP_TOKEN=secret123';
    const sanitized = sanitizeError(message);
    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toContain('secret123');
  });

  it('should redact quoted values', () => {
    const message = 'password: "mysecret"';
    const sanitized = sanitizeError(message);
    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toContain('mysecret');
  });

  it('should redact an Authorization value inside a JSON error body', () => {
    // Remote error bodies are commonly JSON; the quoted key must not dodge the rule.
    const message = '{"Authorization":"Digest response=SUPERSECRET"}';
    const sanitized = sanitizeError(message);
    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toContain('SUPERSECRET');
  });

  it('should redact a spaced app password inside a JSON error body', () => {
    const message = '{"appPassword":"abcd efgh ijkl mnop qrst uvwx"}';
    const sanitized = sanitizeError(message);
    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toContain('efgh');
    expect(sanitized).not.toContain('uvwx');
  });

  it('should redact a PHP-style arrow dump of a spaced app password', () => {
    const message = "appPassword => 'abcd efgh ijkl mnop qrst uvwx'";
    const sanitized = sanitizeError(message);
    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toContain('efgh');
    expect(sanitized).not.toContain('uvwx');
  });

  it('should redact a spaced app password inside an escaped (nested) JSON body', () => {
    const message = JSON.stringify({
      detail: JSON.stringify({ appPassword: 'abcd efgh ijkl mnop qrst uvwx' }),
    });
    const sanitized = sanitizeError(message);
    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toContain('efgh');
    expect(sanitized).not.toContain('uvwx');
  });

  it('should redact a URL-encoded app password value', () => {
    const message = encodeURIComponent(
      JSON.stringify({ appPassword: 'abcd efgh ijkl mnop qrst uvwx' })
    );
    const sanitized = sanitizeError(message);
    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toContain('efgh');
    expect(sanitized).not.toContain('uvwx');
  });

  it('should preserve short-word diagnostics after a secret-ish key', () => {
    // Partial password groups are only a truncation artifact; on untruncated
    // input only the first value token is redacted, never a run of short words.
    expect(sanitizeError('API key: must be set')).toBe('API key=[redacted] be set');
    expect(sanitizeError('api_key: must be non empty')).toBe('api_key=[redacted] be non empty');
  });

  it('should not leak trailing password groups when the input cap splits the value', () => {
    // Padding pushes the spaced password across the MAX_SANITIZE_INPUT_LENGTH cut,
    // so the exact six-group form never survives truncation intact; the keyed rule
    // must swallow however many groups remain.
    const message = '/tmp/' + 'a'.repeat(1960) + ' app_password: abcd efgh ijkl mnop qrst uvwx';
    const sanitized = sanitizeError(message);
    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toContain('efgh');
    expect(sanitized).not.toContain('ijkl');
    expect(sanitized).not.toContain('mnop');
  });

  it('should redact a twice-nested JSON app password', () => {
    const p = 'abcd efgh ijkl mnop qrst uvwx';
    const message = JSON.stringify({
      detail: JSON.stringify({ detail: JSON.stringify({ appPassword: p }) }),
    });
    const sanitized = sanitizeError(message);
    expect(sanitized).not.toContain('efgh');
    expect(sanitized).not.toContain('uvwx');
  });

  it('should redact a URLSearchParams-serialized app password (spaces become +)', () => {
    const p = 'abcd efgh ijkl mnop qrst uvwx';
    const message = new URLSearchParams({ detail: JSON.stringify({ appPassword: p }) }).toString();
    const sanitized = sanitizeError(message);
    expect(sanitized).not.toContain('efgh');
    expect(sanitized).not.toContain('uvwx');
  });

  it('should redact an encodeURI-serialized app password (colon stays raw)', () => {
    const p = 'abcd efgh ijkl mnop qrst uvwx';
    const message = encodeURI(JSON.stringify({ appPassword: p }));
    const sanitized = sanitizeError(message);
    expect(sanitized).not.toContain('efgh');
    expect(sanitized).not.toContain('uvwx');
  });

  it('should redact a print_r-style bracketed-key dump', () => {
    const message = 'Array\n(\n    [app_password] => abcd efgh ijkl mnop qrst uvwx\n)';
    const sanitized = sanitizeError(message);
    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toContain('efgh');
    expect(sanitized).not.toContain('uvwx');
  });

  it('should redact an escaped (nested-JSON) Authorization value', () => {
    const message = JSON.stringify({
      detail: JSON.stringify({ Authorization: 'Digest response=SUPERSECRET' }),
    });
    expect(sanitizeError(message)).not.toContain('SUPERSECRET');
  });

  it('should redact a URL-encoded Authorization value', () => {
    const message = encodeURIComponent(
      JSON.stringify({ Authorization: 'Digest response=SUPERSECRET' })
    );
    expect(sanitizeError(message)).not.toContain('SUPERSECRET');
  });

  it('should redact a print_r bracketed Authorization header', () => {
    const message = 'Array\n(\n  [Authorization] => Digest response=SUPERSECRET\n)';
    const sanitized = sanitizeError(message);
    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toContain('SUPERSECRET');
  });

  it('should leave bracketed Authorization prose alone', () => {
    // Brackets are dump syntax only when paired with '=>'; bracketed prose with
    // ':' or '=' is documentation, not a header dump.
    expect(sanitizeError('See [Authorization]: required header syntax')).toBe(
      'See [Authorization]: required header syntax'
    );
    expect(sanitizeError('The [Authorization] = permission model is described here')).toBe(
      'The [Authorization] = permission model is described here'
    );
  });

  it('should preserve raw diagnostic text after the first value token', () => {
    // The widened encoded-value class applies only where serializer evidence
    // exists (%-escaped separator or key quote); plain key=value diagnostics
    // keep everything past the first token.
    expect(sanitizeError('api_token=placeholder(must_be_64_chars); retry later')).toContain(
      'must_be_64_chars'
    );
    expect(sanitizeError('api_token=missing!must_be_64_chars; retry later')).toContain(
      'must_be_64_chars'
    );
  });

  it('should redact URL-encoded values past raw token punctuation (JWT shapes)', () => {
    // encodeURIComponent and URLSearchParams leave . - _ ~ raw, so a JWT-style
    // value must not leak everything after its first dot.
    const jwt = 'aaa.BBB-ccc_ddd~EEE';
    const viaAuth = encodeURIComponent(JSON.stringify({ Authorization: `Bearer ${jwt}` }));
    const viaToken = new URLSearchParams({ detail: JSON.stringify({ api_token: jwt }) }).toString();
    for (const message of [viaAuth, viaToken]) {
      const sanitized = sanitizeError(message);
      expect(sanitized).not.toContain('BBB');
      expect(sanitized).not.toContain('EEE');
    }
  });

  it('should remove stack traces', () => {
    const message = 'Error occurred at Function.name (/path/to/file.js:10:5)';
    expect(sanitizeError(message)).not.toContain('at Function.name');
  });

  it('should strip a real V8 stack frame line', () => {
    const message = 'Boom\n    at Object.foo (/path/to/file.js:10:5)';
    const sanitized = sanitizeError(message);
    expect(sanitized).not.toContain('Object.foo');
    expect(sanitized).not.toContain(':10:5');
    expect(sanitized).toContain('Boom');
  });

  it('should not catastrophically backtrack on a pathological error body', () => {
    // Pre-fix, the stack-trace regex had two adjacent greedy `.+` groups and
    // ran on the uncapped (up to 64KB) remote error body: this input drove it
    // into quadratic backtracking that stalled the event loop for seconds. The
    // fix caps the input and makes the pattern linear, so this returns in ~ms.
    const evil = ' at ' + '('.repeat(60000);
    const start = performance.now();
    const sanitized = sanitizeError(evil);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(sanitized.length).toBeLessThanOrEqual(500);
  });

  it('should truncate to 500 characters', () => {
    const longMessage = 'a'.repeat(600);
    expect(sanitizeError(longMessage).length).toBeLessThanOrEqual(500);
  });

  it('should handle empty string', () => {
    expect(sanitizeError('')).toBe('');
  });

  it('should trim whitespace', () => {
    expect(sanitizeError('  message  ')).toBe('message');
  });
});

describe('registered known secrets', () => {
  const p = 'abcd efgh ijkl mnop qrst uvwx';

  afterEach(() => {
    clearKnownSecrets();
  });

  it('should redact a form-encoded registered secret containing punctuation', () => {
    // URLSearchParams keeps '=' raw but percent-escapes '!', '(', ')', '~' -
    // characters encodeURIComponent leaves alone - so the registry needs the
    // exact application/x-www-form-urlencoded variant.
    const token = 'missing!must_be_64_chars';
    registerKnownSecrets([token]);
    const body = new URLSearchParams({ api_token: token }).toString();
    const sanitized = sanitizeError(body);
    expect(sanitized).not.toContain('must_be_64_chars');
  });

  it('should fully redact a secret that another registered secret prefixes', () => {
    // Sequential replacement must run longest-first, or replacing the shorter
    // prefix first breaks the longer match and leaks its suffix.
    const prefix = 'SharedPrefix-1234567890';
    const longer = prefix + '-RemainingCredentialMaterial';
    registerKnownSecrets([prefix]);
    registerKnownSecrets([longer]);
    const sanitized = sanitizeError('echo ' + longer);
    expect(sanitized).not.toContain('RemainingCredentialMaterial');
  });

  it('should keep earlier registrations when registering again', () => {
    // A second server instance in the same process must not strip the first
    // instance's credentials from the registry.
    registerKnownSecrets(['SENTINEL-SERVER-A-SECRET-12345']);
    registerKnownSecrets(['SENTINEL-SERVER-B-SECRET-67890']);
    const sanitized = sanitizeError('echo SENTINEL-SERVER-A-SECRET-12345');
    expect(sanitized).not.toContain('SENTINEL-SERVER-A-SECRET-12345');
    expect(sanitizeError('echo SENTINEL-SERVER-B-SECRET-67890')).not.toContain(
      'SENTINEL-SERVER-B-SECRET-67890'
    );
  });

  it('should redact a registered secret with no key context at all', () => {
    // No secret-ish key anywhere, so every pattern rule skips this; only the
    // value registry can catch it.
    registerKnownSecrets([p]);
    const sanitized = sanitizeError(`The dashboard echoed ${p} back`);
    expect(sanitized).toContain('[redacted]');
    expect(sanitized).not.toContain('efgh');
  });

  it('should redact registered-secret encodings that survive serialization', () => {
    registerKnownSecrets([p]);
    expect(sanitizeError('x=' + encodeURIComponent(p))).not.toContain('efgh');
    expect(sanitizeError(new URLSearchParams({ x: p }).toString())).not.toContain('efgh');
  });

  it('should redact a registered secret that straddles the input cap', () => {
    // Value redaction runs on the full message before the cap, so the secret
    // never reaches the truncation seam in the first place.
    registerKnownSecrets([p]);
    const sanitized = sanitizeError('x'.repeat(1990) + ' echoed ' + p);
    expect(sanitized).not.toContain('efgh');
  });

  it('should ignore registered values too short to redact safely', () => {
    registerKnownSecrets(['abc']);
    expect(sanitizeError('abc def')).toBe('abc def');
  });

  it('should ignore a derived variant that falls under the length floor', () => {
    // The submitted value clears the floor; its space-free form does not, and
    // the registry keeps what it is given for the life of the process.
    registerKnownSecrets(['ab cd ef g']);
    expect(sanitizeError('abcdefg is a word here')).toContain('abcdefg');
  });

  it('should redact the compact form of an Application Password only', () => {
    // WordPress compares an Application Password with every non-alphanumeric
    // removed, so the compact form of a hyphen-separated password is the same
    // credential. A token is not: stripping its punctuation yields a string
    // that never authenticated and could match ordinary text.
    registerKnownSecrets([appPasswordSecret('abcd-efgh-ijkl-mnop-qrst-uvwx')]);
    registerKnownSecrets(['api-token-abcdefghijkl']);

    expect(sanitizeError('echo abcdefghijklmnopqrstuvwx')).not.toContain('abcdefghijkl');
    expect(sanitizeError('echo apitokenabcdefghijkl')).toContain('apitokenabcdefghijkl');
  });

  it('should report saturation instead of dropping a secret silently', () => {
    // The caller has to learn that a credential it is about to use will never
    // be scrubbed; discovering it in a leaked diagnostic is too late.
    const name = (i: number) => `registered-secret-value-${String(i).padStart(4, '0')}`;
    for (let i = 0; i < 64; i++) {
      expect(registerKnownSecrets([name(i)])).toBe(true);
    }

    expect(canRegisterKnownSecrets([name(64)])).toBe(false);
    expect(registerKnownSecrets([name(64)])).toBe(false);
    expect(sanitizeError(`echo ${name(64)}`)).toContain(name(64));
  });

  it('should keep the ceiling while one secret is being added', () => {
    // The old check ran once per secret, so a secret that started under the
    // ceiling added every variant it had and left the registry over it.
    const name = (i: number) => `registered-secret-value-${String(i).padStart(4, '0')}`;
    for (let i = 0; i < 63; i++) {
      registerKnownSecrets([name(i)]);
    }
    // Four distinct variants: the raw value, the plus-joined and
    // percent-escaped encodings of its spaces, and its space-free form. One
    // free slot takes the raw value and the ceiling stops the rest, so the
    // call reports failure with the secret only partly covered.
    expect(registerKnownSecrets(['multi variant secret value'])).toBe(false);
    expect(sanitizeError('echo multivariantsecretvalue')).toContain('multivariantsecretvalue');
  });

  it('should stop growing once the registry is full', () => {
    // The registry lives for the whole process and every entry is scanned by
    // every redaction, so a caller that registers per request must not be able
    // to grow it without limit.
    // Fixed-width names so no value is a prefix of another.
    const name = (i: number) => `registered-secret-value-${String(i).padStart(4, '0')}`;
    for (let i = 0; i < 500; i++) {
      registerKnownSecrets([name(i)]);
    }

    expect(sanitizeError(`echo ${name(0)}`)).not.toContain(name(0));
    expect(sanitizeError(`echo ${name(499)}`)).toContain(name(499));
  });
});

describe('createSecretRedactor', () => {
  afterEach(() => {
    clearKnownSecrets();
  });

  it('redacts a value the global registry refuses, without registering it', () => {
    const redact = createSecretRedactor(['abc']);

    expect(redact('the dashboard echoed abc back')).toBe('the dashboard echoed [redacted] back');
    // Nothing joined the process-wide registry.
    expect(sanitizeError('the dashboard echoed abc back')).toContain('abc');
  });

  it('redacts the JSON-escaped form of a value', () => {
    const secret = 'abcdefgh"ijkl';
    const redact = createSecretRedactor([secret]);

    expect(redact(JSON.stringify({ error: secret }))).not.toContain('ijkl');
  });

  it('is a no-op when there is nothing to redact', () => {
    expect(createSecretRedactor([undefined, ''])('untouched text')).toBe('untouched text');
  });
});

describe('redactStringsDeep', () => {
  it('survives hostile nesting and still redacts above the cap', () => {
    // JSON.parse takes nesting this deep without complaint, and a body that
    // carries it fits well inside maxResponseSize, so an execution result can
    // reach the walk in this shape. Uncapped, one stack frame per level throws
    // RangeError long before this depth.
    const depth = 20000;
    const parsed: unknown = JSON.parse(
      `{"secret":"topsecretvalue","deep":${'['.repeat(depth)}${']'.repeat(depth)}}`
    );

    const redacted = redactStringsDeep(parsed, text =>
      text.split('topsecretvalue').join('[redacted]')
    ) as { secret: string; deep: unknown };

    expect(redacted.secret).toBe('[redacted]');
    let node: unknown = redacted.deep;
    let levels = 0;
    while (Array.isArray(node)) {
      node = node[0];
      levels++;
    }
    expect(node).toBe(DEPTH_LIMIT_MARKER);
    expect(levels).toBeLessThan(depth);
  });
});

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow requests within rate limit', async () => {
    const limiter = new RateLimiter(60);

    // Should allow first request immediately
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });

  it('should be disabled when maxTokens is 0', async () => {
    const limiter = new RateLimiter(0);

    // Multiple rapid calls should complete immediately when disabled
    const start = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(10);
  });

  it('should throttle requests exceeding rate limit', async () => {
    const limiter = new RateLimiter(2); // 2 requests per minute

    // Consume both tokens
    await limiter.acquire();
    await limiter.acquire();

    // Third request should wait
    const acquirePromise = limiter.acquire();

    // Advance time to allow refill
    vi.advanceTimersByTime(30000); // 30 seconds

    await acquirePromise;
  });

  it('should refill tokens over time', async () => {
    const limiter = new RateLimiter(60); // 1 per second

    // Consume all tokens
    for (let i = 0; i < 60; i++) {
      await limiter.acquire();
    }

    // Advance time by 1 second (should refill 1 token)
    vi.advanceTimersByTime(1000);

    // Should be able to acquire another token
    await limiter.acquire();
  });
});

describe('isValidId', () => {
  it('should return true for valid positive integers', () => {
    expect(isValidId(1)).toBe(true);
    expect(isValidId(123)).toBe(true);
    expect(isValidId(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('should return true for numeric strings', () => {
    expect(isValidId('1')).toBe(true);
    expect(isValidId('123')).toBe(true);
  });

  it('should return false for zero', () => {
    expect(isValidId(0)).toBe(false);
    expect(isValidId('0')).toBe(false);
  });

  it('should return false for negative numbers', () => {
    expect(isValidId(-1)).toBe(false);
    expect(isValidId('-5')).toBe(false);
  });

  it('should return false for non-numbers', () => {
    expect(isValidId('abc')).toBe(false);
    expect(isValidId(null)).toBe(false);
    expect(isValidId(undefined)).toBe(false);
    expect(isValidId({})).toBe(false);
    expect(isValidId([])).toBe(false);
  });

  it('should return false for strings with trailing non-numeric characters', () => {
    expect(isValidId('12abc')).toBe(false);
    expect(isValidId('1 2')).toBe(false);
  });

  it('should return false for non-decimal numeric syntax', () => {
    expect(isValidId('1e3')).toBe(false);
    expect(isValidId('0x10')).toBe(false);
    expect(isValidId('0b10')).toBe(false);
    expect(isValidId('+7')).toBe(false);
    expect(isValidId(' 8 ')).toBe(false);
  });

  it('should return false for floats', () => {
    expect(isValidId(1.5)).toBe(false);
  });

  it('should handle edge cases', () => {
    expect(isValidId(NaN)).toBe(false);
    expect(isValidId(Infinity)).toBe(false);
  });
});

describe('validateInput - recursive nested validation', () => {
  it('should reject nested string exceeding MAX_STRING_LENGTH', () => {
    expect(() => validateInput({ nested: { long_string: 'A'.repeat(10001) } })).toThrow(
      /exceeds maximum length/
    );
  });

  it('should reject nested negative ID', () => {
    expect(() => validateInput({ nested: { site_id: -1 } })).toThrow(/must be a positive integer/);
  });

  it('should accept valid nested objects with short strings', () => {
    expect(() => validateInput({ nested: { valid: 'short' } })).not.toThrow();
  });

  it('should reject nested objects inside arrays with invalid IDs', () => {
    expect(() => validateInput({ arr: [{ site_id: 0 }] })).toThrow(/must be a positive integer/);
  });
});

describe('RateLimiter - AbortSignal support', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should abort immediately when signal is already aborted', async () => {
    const limiter = new RateLimiter(2);

    // Exhaust tokens so acquire() must wait
    await limiter.acquire();
    await limiter.acquire();

    const controller = new AbortController();
    controller.abort();

    await expect(limiter.acquire(controller.signal)).rejects.toThrow(
      'Rate limiter acquire aborted'
    );
  });

  it('should abort a pending acquire when signal fires during wait', async () => {
    const limiter = new RateLimiter(2);

    // Exhaust tokens
    await limiter.acquire();
    await limiter.acquire();

    const controller = new AbortController();
    const acquirePromise = limiter.acquire(controller.signal);

    // Abort while waiting for token refill
    controller.abort();

    await expect(acquirePromise).rejects.toThrow('Rate limiter acquire aborted');
  });
});
