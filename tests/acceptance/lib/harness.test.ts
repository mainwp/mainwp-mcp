import { describe, expect, it } from 'vitest';
import { parseAcceptanceEnv } from './env.js';
import { getWriteGuardReason, isWriteHostAllowed } from './guards.js';
import { Redactor } from './redact.js';
import { serializeToPhpQueryString } from './verify.js';

describe('acceptance harness primitives', () => {
  it('redacts credentials, compact application passwords, authorization, and dashboard origins', () => {
    const redactor = new Redactor({
      username: 'fixture-user',
      appPassword: 'abcd efgh ijkl',
      dashboardUrl: 'http://127.0.0.1:9123/path',
      authorization: 'Basic Zml4dHVyZS11c2VyOmFiY2QgZWZnaCBpamts',
    });

    const output = redactor.redact(
      'fixture-user abcd efgh ijkl abcdefghijkl ' +
        'Basic Zml4dHVyZS11c2VyOmFiY2QgZWZnaCBpamts http://127.0.0.1:9123/elsewhere'
    );

    expect(output).not.toContain('fixture-user');
    expect(output).not.toContain('abcd efgh ijkl');
    expect(output).not.toContain('abcdefghijkl');
    expect(output).not.toContain('Zml4dHVyZS11c2VyOmFiY2QgZWZnaCBpamts');
    expect(output).not.toContain('127.0.0.1:9123');
    expect(output).toContain('<redacted:username>');
    expect(output).toContain('<redacted:app-password>');
    expect(output).toContain('<dashboard>');
  });

  it('parses testbed environment files without expanding or persisting values', () => {
    const parsed = parseAcceptanceEnv(`
# Network testbed
export LLM_DASH_URL="https://dashboard.example.test/base" # dashboard
MAINWP_USER='acceptance-user' # principal
MAINWP_APP_PASSWORD=abcd efgh ijkl # application password
`);

    expect(parsed).toEqual({
      dashboardUrl: 'https://dashboard.example.test/base',
      username: 'acceptance-user',
      appPassword: 'abcd efgh ijkl',
    });
  });

  it.each([
    ['localhost', true],
    ['127.0.0.1', true],
    ['dashboard.local', true],
    ['approved.example', true],
    ['production.example', false],
  ])('evaluates write host %s against the built-in and explicit allowlists', (host, expected) => {
    expect(isWriteHostAllowed(host, ['approved.example'])).toBe(expected);
  });

  it('allows fixture-only write scenarios without --writes', () => {
    expect(getWriteGuardReason('http://127.0.0.1:9123', false, undefined, 'fixture')).toBeNull();
  });

  it('serializes scalar, array, and one-level object input using WordPress PHP notation', () => {
    expect(
      serializeToPhpQueryString({
        site_id_or_domain: 7,
        plugins: ['hello.php', 'akismet/akismet.php'],
        options: { force: true },
      })
    ).toBe(
      '?input[site_id_or_domain]=7&input[plugins][]=hello.php&' +
        'input[plugins][]=akismet%2Fakismet.php&input[options][force]=true'
    );
  });

  it('rejects unsupported deeper query input', () => {
    expect(() => serializeToPhpQueryString({ nested: { value: ['too-deep'] } })).toThrow(
      /one level deep/
    );
  });
});
