import { describe, expect, it } from 'vitest';
import {
  describeCredentialRejection,
  isCredentialRejection,
  looksLikeApplicationPassword,
  safeWpErrorCode,
} from './credential-diagnostics.js';
import { sanitizeError } from './security.js';
import { makeBaseConfig } from '../tests/helpers/config.js';

describe('credential rejection diagnostics', () => {
  it.each([
    [401, undefined, true],
    [401, 'invalid_username', true],
    [403, undefined, false],
    [403, 'invalid_username', true],
    [403, 'incorrect_password', true],
    [404, undefined, false],
    [500, 'invalid_username', false],
    [403, 42, false],
    [403, 'INVALID_USERNAME', false],
    [403, 'a'.repeat(200), false],
  ])('classifies status %s and code %s as %s', (status, code, expected) => {
    expect(isCredentialRejection(status, code)).toBe(expected);
  });

  it.each([
    ['invalid_username', 'invalid_username'],
    ['incorrect_password', 'incorrect_password'],
    [42, undefined],
    ['INVALID_USERNAME', undefined],
    ['a'.repeat(200), undefined],
    ['bad-code', undefined],
  ])('accepts only a plain WordPress error slug %s', (code, expected) => {
    expect(safeWpErrorCode(code)).toBe(expected);
  });

  it('omits the application password and keeps source names after sanitization', () => {
    const config = makeBaseConfig({
      username: 'Display Name',
      appPassword: 'private-app-password',
      connectionSources: {
        MAINWP_URL: 'env',
        MAINWP_USER: 'env',
        MAINWP_APP_PASSWORD: 'settings.json',
      },
    });

    const description = describeCredentialRejection(config, 'invalid_username');
    const sanitized = sanitizeError(description);
    expect(description).not.toContain(config.appPassword);
    expect(sanitized).not.toContain(config.appPassword);
    expect(sanitized).toContain('"Display Name"');
    expect(sanitized).toContain('MAINWP_USER from the environment');
    expect(sanitized).toContain('MAINWP_APP_PASSWORD from settings.json');
    expect(sanitized).toContain('login name or email address, not the display name');
  });

  // Every way the same Application Password can be pasted into MAINWP_USER.
  it.each([
    'Qx7zAb12Cd34Ef56Gh78Ij90',
    'Qx7z Ab12 Cd34 Ef56 Gh78 Ij90',
    'Qx7z-Ab12-Cd34-Ef56-Gh78-Ij90',
    ' Qx7z Ab12 Cd34 Ef56 Gh78 Ij90',
    'Qx7z Ab12 Cd34 Ef56 Gh78 Ij90 ',
    'Qx7z Ab12 Cd34 Ef56 Gh78 Ij90\n',
    'Qx7z\u00a0Ab12\u00a0Cd34\u00a0Ef56\u00a0Gh78\u00a0Ij90',
    'Qx7z\tAb12  Cd34 - Ef56 Gh78 Ij90',
  ])('does not disclose a password-shaped username %j', username => {
    expect(looksLikeApplicationPassword(username)).toBe(true);
    const message = describeCredentialRejection(makeBaseConfig({ username }), 'invalid_username');
    for (const group of ['Qx7z', 'Ab12', 'Cd34', 'Ef56', 'Gh78', 'Ij90']) {
      expect(message).not.toContain(group);
    }
    expect(message).toContain('MAINWP_USER value looks like an Application Password');
    expect(message).toContain('MAINWP_USER and MAINWP_APP_PASSWORD may be swapped');
  });

  it.each([
    'admin',
    'Display Name',
    'john.smith@example.com',
    'Qx7z Ab12 Cd34 Ef56 Gh78',
    'Qx7z Ab12 Cd34 Ef56 Gh78 Ij90 Kl12',
  ])('still names an ordinary username %j', username => {
    expect(looksLikeApplicationPassword(username)).toBe(false);
    const message = describeCredentialRejection(makeBaseConfig({ username }), 'invalid_username');
    expect(message).toContain(JSON.stringify(username));
  });

  it('does not repeat an unknown rejection code that could be a short password', () => {
    expect(isCredentialRejection(401, 'abc123')).toBe(true);
    expect(describeCredentialRejection(makeBaseConfig(), 'abc123')).not.toContain('abc123');
  });

  it('quotes a username containing a quote and newline', () => {
    const username = 'name"with\nnewline';
    const description = describeCredentialRejection(
      makeBaseConfig({ username }),
      'invalid_username'
    );

    expect(description).toContain(JSON.stringify(username));
    expect(description).not.toContain(username);
  });

  it('bounds a 500-character username', () => {
    const description = describeCredentialRejection(
      makeBaseConfig({ username: 'u'.repeat(500) }),
      'invalid_username'
    );

    expect(description).toContain(`"${'u'.repeat(100)}..."`);
    expect(description).not.toContain('u'.repeat(101));
  });
});
