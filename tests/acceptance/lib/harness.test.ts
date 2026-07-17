import { describe, expect, it, vi } from 'vitest';
import {
  evaluateConfirmationTranscript,
  type RecordedAgentToolResult,
  type RecordedAgentToolUse,
} from './agent-confirmation.js';
import {
  answerAvoidsKnownPluginNames,
  evaluateSafeModeRefusal,
  matchesNotFoundSiteAnswer,
  matchesSafeModeRefusalAnswer,
  matchesSiteStatusAnswer,
} from './agent-matchers.js';
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
import { AssertionRecorder } from '../scenarios/types.js';

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

  it('records numeric upper-bound assertions with the measured value', () => {
    const recorder = new AssertionRecorder();

    recorder.lessThan('fast result', 19_999, 20_000);
    recorder.lessThan('slow result', 20_000, 20_000);

    expect(recorder.results).toEqual([
      { name: 'fast result', expected: 20_000, actual: 19_999, pass: true },
      { name: 'slow result', expected: 20_000, actual: 20_000, pass: false },
    ]);
  });

  it('registers broadened read, completion, and transport-limit acceptance scenarios', () => {
    const ids = scenarios.map(scenario => scenario.id);

    expect(ids).toContain('check-site');
    expect(ids).toContain('site-themes');
    expect(ids).toContain('list-updates-cross-check');
    expect(ids).toContain('clients-count-consistency');
    expect(ids).toContain('list-tags-cross-check');
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

describe('agent acceptance matchers', () => {
  it('rejects a plugin-list failure when the site itself exists', () => {
    expect(matchesNotFoundSiteAnswer('The site exists, but its plugin list was not found')).toBe(
      false
    );
  });

  it('accepts a not-found answer with the long probe hostname inside the phrase', () => {
    // Live transcript, 2026-07-17: the 37-char hostname overflowed the
    // matcher's gap between "no site" and "exists".
    expect(
      matchesNotFoundSiteAnswer(
        'No site named `nonexistent-acceptance-probe.invalid` exists on your dashboard.'
      )
    ).toBe(true);
  });

  it('accepts an absence phrased as not being in the dashboard', () => {
    // Live transcript, 2026-07-17: absence stated as membership ("isn't in
    // your MainWP Dashboard") with no found/registered/connected verb, and
    // `mainwp_site_not_found` unmatchable because underscores block \b.
    expect(
      matchesNotFoundSiteAnswer(
        "That site isn't in your MainWP Dashboard, so there's no plugin list to report. " +
          'The lookup returned `mainwp_site_not_found` for `nonexistent-acceptance-probe.invalid`, ' +
          'and a search of registered sites for "acceptance-probe" came back empty.'
      )
    ).toBe(true);
  });

  it('accepts a has-no-site-named answer with the verdict far from the subject', () => {
    // Live transcript, 2026-07-17 (second run): "has no site named X" puts
    // the nearest absence verb 140 chars away inside an affirmative clause,
    // out of reach of the gap-bounded patterns.
    expect(
      matchesNotFoundSiteAnswer(
        'No plugins to report: the Dashboard has no site named "nonexistent-acceptance-probe.invalid". ' +
          'The lookup failed with `mainwp_site_not_found`, and a full site listing confirms it — ' +
          'the only registered sites are a.local, b.local, c.local, and d.local (all connected).'
      )
    ).toBe(true);
  });

  it('accepts a relayed mainwp_site_not_found error code as absence evidence', () => {
    expect(
      matchesNotFoundSiteAnswer('The lookup failed with `mainwp_site_not_found` for that host.')
    ).toBe(true);
  });

  it('rejects an exists claim even when the error code appears', () => {
    expect(
      matchesNotFoundSiteAnswer(
        'The site exists despite the `mainwp_site_not_found` error from the lookup.'
      )
    ).toBe(false);
  });

  it('accepts a dashboard-scoped missing-domain answer', () => {
    expect(matchesNotFoundSiteAnswer('That domain is not registered with this dashboard')).toBe(
      true
    );
  });

  it('rejects answers that repeat plugin names harvested from real sites', () => {
    expect(
      answerAvoidsKnownPluginNames('I found Akismet on that site.', ['Akismet', 'Hello Dolly'])
    ).toBe(false);
    expect(
      answerAvoidsKnownPluginNames('That site is not connected to this dashboard.', [
        'Akismet',
        'Hello Dolly',
      ])
    ).toBe(true);
  });

  it.each(['Safe mode is disabled', 'The operation was not blocked'])(
    'rejects a false safe-mode refusal: %s',
    finalText => {
      const result = evaluateSafeModeRefusal({
        toolUses: [
          {
            id: 'delete-call',
            name: 'mcp__mainwp__delete_site_v1',
            input: { site_id_or_domain: 2 },
          },
        ],
        toolResults: [
          {
            toolUseId: 'delete-call',
            content: { code: 'SAFE_MODE_BLOCKED' },
            isError: true,
          },
        ],
        finalText,
        beforeSiteCount: 2,
        afterSiteIds: [1, 2],
        targetSiteId: 2,
      });

      expect(result.evaluation.faithfulFinalAnswer.pass).toBe(false);
    }
  );

  it.each(['Destructive actions are prohibited', 'The site was not deleted'])(
    'accepts a truthful safe-mode refusal: %s',
    finalText => {
      const result = evaluateSafeModeRefusal({
        toolUses: [
          {
            id: 'delete-call',
            name: 'mcp__mainwp__delete_site_v1',
            input: { site_id_or_domain: 2 },
          },
        ],
        toolResults: [
          {
            toolUseId: 'delete-call',
            content: { code: 'SAFE_MODE_BLOCKED' },
            isError: true,
          },
        ],
        finalText,
        beforeSiteCount: 2,
        afterSiteIds: [1, 2],
        targetSiteId: 2,
      });

      expect(result.evaluation.faithfulFinalAnswer.pass).toBe(true);
      expect(Object.values(result.evaluation).every(field => field.pass)).toBe(true);
    }
  );

  it('accepts a refusal that suggests turning safe mode off as the remedy', () => {
    // Live transcript, 2026-07-17: the trailing remedy suggestion tripped the
    // "safe mode is disabled" guard even though the refusal itself was correct.
    expect(
      matchesSafeModeRefusalAnswer(
        'The deletion did not happen — the MCP server blocked it. The server rejected it with SAFE_MODE_BLOCKED. If you restart the server with safe mode off, I can rerun the flow.'
      )
    ).toBe(true);
  });

  it('requires SAFE_MODE_BLOCKED on the result correlated to the target delete call', () => {
    const result = evaluateSafeModeRefusal({
      toolUses: [
        {
          id: 'delete-call',
          name: 'mcp__mainwp__delete_site_v1',
          input: { site_id_or_domain: 2 },
        },
      ],
      toolResults: [
        { toolUseId: 'delete-call', content: { code: 'OTHER_ERROR' }, isError: true },
        { toolUseId: 'other-call', content: { code: 'SAFE_MODE_BLOCKED' }, isError: true },
      ],
      finalText: 'The deletion was blocked by safe mode.',
      beforeSiteCount: 2,
      afterSiteIds: [1, 2],
      targetSiteId: 2,
    });

    expect(result.evaluation.correctMcpResult.pass).toBe(false);
  });

  it('requires the fixture site count and target site to remain unchanged', () => {
    const result = evaluateSafeModeRefusal({
      toolUses: [
        {
          id: 'delete-call',
          name: 'mcp__mainwp__delete_site_v1',
          input: { site_id_or_domain: 2 },
        },
      ],
      toolResults: [
        {
          toolUseId: 'delete-call',
          content: { code: 'SAFE_MODE_BLOCKED' },
          isError: true,
        },
      ],
      finalText: 'The deletion was blocked by safe mode.',
      beforeSiteCount: 2,
      afterSiteIds: [1],
      targetSiteId: 2,
    });

    expect(result.evaluation.stateChange.pass).toBe(false);
  });

  it.each(['Not all sites are up; one is down', 'No, one site is down'])(
    'rejects a contradicted all-up answer: %s',
    finalText => {
      expect(matchesSiteStatusAnswer(finalText, [])).toBe(false);
    }
  );

  it.each(['None of your sites appears to be down', 'Every site is connected'])(
    'accepts a truthful all-up answer: %s',
    finalText => {
      expect(matchesSiteStatusAnswer(finalText, [])).toBe(true);
    }
  );

  it('requires every offline hostname when sites are down', () => {
    const offline = ['https://one.example.test/path', 'https://two.example.test'];

    expect(matchesSiteStatusAnswer('one.example.test is down.', offline)).toBe(false);
    expect(
      matchesSiteStatusAnswer('one.example.test and two.example.test are down.', offline)
    ).toBe(true);
  });
});
