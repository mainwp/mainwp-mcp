import {
  FIXTURE_APP_PASSWORD,
  FIXTURE_USERNAME,
  FIXTURE_NULLABLE_DELETE_ABILITY,
  FIXTURE_NULLABLE_DELETE_TOOL,
} from '../fixture-dashboard.js';
import { parseToolJson } from '../lib/client.js';
import type { ScenarioDefinition } from './types.js';

interface WireTransport {
  method: string;
  body: string;
  contentType: string;
  query: string;
}

export const fixtureNullableInputs: ScenarioDefinition = {
  id: 'fixture-nullable-inputs',
  purpose:
    'Deliver a required nullable preview token over DELETE JSON, then confirm with the issued token.',
  kind: 'write',
  targets: ['fixture'],
  async run(ctx) {
    const before = await ctx.verifier.listSites();
    const site = before.find(
      candidate => typeof candidate.notes === 'string' && candidate.notes.length > 0
    );
    if (!site) throw new Error('No fixture site with a note was available.');
    const args = { site_id_or_domain: site.id, request_id: 'nullable-inputs', preview_token: null };
    const preview = await ctx.client.callTool(FIXTURE_NULLABLE_DELETE_TOOL, {
      ...args,
      confirm: true,
    });
    const data = parseToolJson(preview) as {
      status?: string;
      confirmation_token?: string;
      preview?: { preview_token?: string; transport?: WireTransport };
    };
    ctx.assert.equal('nullable DELETE preview succeeds', preview.isError, undefined);
    ctx.assert.equal('nullable DELETE requires confirmation', data.status, 'CONFIRMATION_REQUIRED');
    ctx.assert.deepEqual('preview wire format', data.preview?.transport, {
      method: 'DELETE',
      body: JSON.stringify({ input: { ...args, dry_run: true, confirm: false } }),
      contentType: 'application/json',
      query: '',
    });
    ctx.assert.deepEqual('preview preserves fixture state', await ctx.verifier.listSites(), before);
    if (!data.confirmation_token || !data.preview?.preview_token)
      throw new Error('Nullable DELETE preview did not issue its tokens.');
    const confirmed = await ctx.client.callTool(FIXTURE_NULLABLE_DELETE_TOOL, {
      ...args,
      user_confirmed: true,
      confirmation_token: data.confirmation_token,
    });
    const confirmedData = parseToolJson(confirmed) as {
      updated?: boolean;
      transport?: WireTransport;
    };
    ctx.assert.equal('nullable DELETE confirmation succeeds', confirmed.isError, undefined);
    ctx.assert.equal('nullable DELETE confirmation updates the note', confirmedData.updated, true);
    ctx.assert.deepEqual('confirmed wire format', confirmedData.transport, {
      method: 'DELETE',
      body: JSON.stringify({
        input: {
          ...args,
          preview_token: data.preview.preview_token,
          dry_run: false,
          confirm: true,
        },
      }),
      contentType: 'application/json',
      query: '',
    });
    ctx.assert.equal(
      'confirmed note is cleared',
      (await ctx.verifier.listSites()).find(candidate => candidate.id === site.id)?.notes,
      ''
    );

    const runUrl = `${ctx.config.dashboardUrl}/wp-json/wp-abilities/v1/abilities/${FIXTURE_NULLABLE_DELETE_ABILITY}/run`;
    const readUrl = `${ctx.config.dashboardUrl}/wp-json/wp-abilities/v1/abilities/mainwp/list-sites-v1/run`;
    const headers = {
      Authorization: `Basic ${Buffer.from(`${FIXTURE_USERNAME}:${FIXTURE_APP_PASSWORD}`).toString('base64')}`,
      'Content-Type': 'application/json',
    };
    const previewInput = { ...args, confirm: false, dry_run: true };
    const jsonInput = JSON.stringify(previewInput);
    const body = JSON.stringify({ input: previewInput });
    const cases: Array<{
      label: string;
      query?: string;
      method: string;
      body?: string;
      contentType?: string;
    }> = [
      {
        label: 'input and input_json',
        method: 'GET',
        query: `?input=&input_json=${encodeURIComponent(jsonInput)}`,
      },
      {
        label: 'bracket input and input_json',
        method: 'GET',
        query: `?input[x]=1&input_json=${encodeURIComponent(jsonInput)}`,
      },
      ...['input=', 'input[x]=1', 'input_json=%7B%7D'].map(query => ({
        label: `DELETE body with ${query}`,
        method: 'DELETE',
        body,
        query: `?${query}`,
      })),
      ...[
        '{}',
        '{"other":{}}',
        '{"input":{},"extra":true}',
        '{"input":[]}',
        '{"input":null}',
        '[]',
        'invalid',
      ].map(body => ({ label: `invalid DELETE envelope ${body}`, method: 'DELETE', body })),
      { label: 'wrong DELETE content type', method: 'DELETE', body, contentType: 'text/plain' },
      // The over-size case stays ASCII: percent-encoded multi-byte text would pass Node's
      // 16 KB request-line limit and be refused before the fixture could answer.
      ...['[]', 'null', '5', 'invalid', JSON.stringify({ extra: 'x'.repeat(8192) })].map(
        (input, index) => ({
          label: `invalid GET JSON ${index}`,
          method: 'GET',
          query: `?input_json=${encodeURIComponent(input)}`,
        })
      ),
      {
        label: 'oversized DELETE body',
        method: 'DELETE',
        body: JSON.stringify({ input: { extra: 'x'.repeat(1048576) } }),
      },
    ];
    for (const test of cases) {
      const response = await fetch(
        (test.method === 'GET' ? readUrl : runUrl) + (test.query ?? ''),
        {
          method: test.method,
          body: test.body,
          headers: { ...headers, 'Content-Type': test.contentType ?? 'application/json' },
        }
      );
      const error = (await response.json()) as { code?: string };
      ctx.assert.equal(`${test.label} status`, response.status, 400);
      ctx.assert.equal(
        `${test.label} code`,
        error.code,
        'mainwp_abilities_invalid_input_transport'
      );
    }
    const missingToken = { ...previewInput } as Record<string, unknown>;
    delete missingToken.preview_token;
    for (const input of [missingToken, { ...previewInput, confirm: null }]) {
      const response = await fetch(runUrl, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ input }),
      });
      ctx.assert.equal('fixture enforces required nullable schema status', response.status, 400);
      ctx.assert.equal(
        'fixture enforces required nullable schema code',
        ((await response.json()) as { code?: string }).code,
        'ability_invalid_input'
      );
    }
    const getCarrier = await fetch(
      `${readUrl}?input_json=${encodeURIComponent(JSON.stringify({ page: 1, per_page: 1 }))}`,
      { headers }
    );
    ctx.assert.equal('fixture accepts GET JSON object', getCarrier.status, 200);
    ctx.assert.equal(
      'fixture applies GET JSON input',
      ((await getCarrier.json()) as { items: unknown[] }).items.length,
      1
    );
  },
};
