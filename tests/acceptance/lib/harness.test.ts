import { describe, expect, it, vi } from 'vitest';
import {
  evaluateConfirmationTranscript,
  type RecordedAgentToolResult,
  type RecordedAgentToolUse,
} from './agent-confirmation.js';
import {
  FIXTURE_DELAY_SEARCH,
  FIXTURE_OVERSIZED_SEARCH,
  getFixtureFaultMode,
} from '../fixture-dashboard.js';
import { parseAcceptanceEnv } from './env.js';
import { getWriteGuardReason, isWriteHostAllowed } from './guards.js';
import { Redactor } from './redact.js';
import { IndependentVerifier, serializeToPhpQueryString } from './verify.js';
import { scenarios } from '../scenarios/index.js';

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

  it('correlates a confirmation-required result with the later token-bound delete call', () => {
    const toolUses: RecordedAgentToolUse[] = [
      {
        id: 'preview-call',
        name: 'mcp__mainwp__delete_site_v1',
        input: { site_id_or_domain: 1 },
      },
      {
        id: 'confirmed-call',
        name: 'mcp__mainwp__delete_site_v1',
        input: {
          site_id_or_domain: 1,
          user_confirmed: true,
          confirmation_token: 'fixture-token',
        },
      },
    ];
    const toolResults: RecordedAgentToolResult[] = [
      {
        toolUseId: 'preview-call',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'CONFIRMATION_REQUIRED',
              confirmation_token: 'fixture-token',
            }),
          },
        ],
      },
      {
        toolUseId: 'confirmed-call',
        content: [{ type: 'text', text: JSON.stringify({ deleted: true }) }],
      },
    ];

    expect(evaluateConfirmationTranscript(toolUses, toolResults, 1)).toMatchObject({
      pass: true,
      confirmationToken: 'fixture-token',
    });
  });

  it('reports a clear failure when the agent stops after the confirmation request', () => {
    const evaluation = evaluateConfirmationTranscript(
      [
        {
          id: 'preview-call',
          name: 'mcp__mainwp__delete_site_v1',
          input: { site_id_or_domain: 1 },
        },
      ],
      [
        {
          toolUseId: 'preview-call',
          content: JSON.stringify({
            status: 'CONFIRMATION_REQUIRED',
            confirmation_token: 'fixture-token',
          }),
        },
      ],
      1
    );

    expect(evaluation.pass).toBe(false);
    expect(evaluation.reason).toMatch(/did not make a confirmed delete_site_v1 call/i);
  });

  it('activates fixture transport faults only for reserved list-sites searches', () => {
    expect(getFixtureFaultMode('mainwp/list-sites-v1', { search: FIXTURE_OVERSIZED_SEARCH })).toBe(
      'oversized'
    );
    expect(getFixtureFaultMode('mainwp/list-sites-v1', { search: FIXTURE_DELAY_SEARCH })).toBe(
      'delay'
    );
    expect(getFixtureFaultMode('mainwp/list-sites-v1', { search: 'ordinary search' })).toBeNull();
    expect(
      getFixtureFaultMode('mainwp/count-sites-v1', { search: FIXTURE_OVERSIZED_SEARCH })
    ).toBeNull();
  });

  it('registers completion and transport-limit acceptance scenarios', () => {
    const ids = scenarios.map(scenario => scenario.id);

    expect(ids).toContain('prompt-completions');
    expect(ids).toContain('oversized-response-recovery');
    expect(ids).toContain('request-timeout-recovery');
  });

  it('reads a string-array enum from the independently fetched ability catalog', async () => {
    const verifier = new IndependentVerifier(
      {
        dashboardUrl: 'https://dashboard.example.test',
        username: 'acceptance-user',
        appPassword: 'fixture password',
      },
      false
    );
    vi.spyOn(verifier, 'fetchCatalog').mockResolvedValue([
      {
        name: 'mainwp/list-updates-v1',
        input_schema: {
          properties: {
            types: { items: { enum: ['core', 'plugins', 'themes'] } },
          },
        },
      },
    ]);

    await expect(
      verifier.getAbilityInputArrayEnum('mainwp/list-updates-v1', 'types')
    ).resolves.toEqual(['core', 'plugins', 'themes']);
  });
});
