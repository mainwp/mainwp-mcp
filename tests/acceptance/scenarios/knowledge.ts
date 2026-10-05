import type { ScenarioDefinition, ScenarioContext } from './types.js';
import { initialKnowledge, KNOWLEDGE_NOTICE, type KnowledgeRecord } from '../fixture-knowledge.js';

const createInput = {
  scope_type: 'site',
  scope_id: 1,
  type: 'memory',
  title: 'Acceptance record',
  body: 'Checked the bakery menu after the update.',
  caller_note: 'Acceptance check',
};
async function list(ctx: ScenarioContext) {
  return ctx.verifier.execute('mainwp/list-knowledge-v1', {});
}
async function confirm(ctx: ScenarioContext, name: string, args: Record<string, unknown>) {
  const before = await list(ctx);
  const { result, data } = await ctx.client.callToolJson(name, { ...args, confirm: true });
  const preview = data as {
    status: string;
    confirmation_token: string;
    preview: Record<string, unknown>;
  };
  ctx.assert.equal('preview succeeds', result.isError, undefined);
  ctx.assert.equal('preview requires confirmation', preview.status, 'CONFIRMATION_REQUIRED');
  ctx.assert.equal('upstream preview is a dry run', preview.preview.dry_run, true);
  ctx.assert.truthy('preview issues a token', preview.confirmation_token);
  ctx.assert.deepEqual('preview leaves records unchanged', await list(ctx), before);
  const saved = await ctx.client.callToolJson(name, {
    ...args,
    user_confirmed: true,
    confirmation_token: preview.confirmation_token,
  });
  ctx.assert.equal('confirmed write succeeds', saved.result.isError, undefined);
  return saved.data as KnowledgeRecord;
}

async function cleanupRecord(ctx: ScenarioContext) {
  if (typeof ctx.state.recordId !== 'number') return;
  const current = (await ctx.verifier.execute('mainwp/get-knowledge-record-v1', {
    record_id: ctx.state.recordId,
  })) as KnowledgeRecord;
  await ctx.verifier.execute('mainwp/delete-knowledge-record-v1', {
    record_id: current.id,
    expected_revision: current.revision,
    confirm: true,
  });
}

export const knowledgeScenarios: ScenarioDefinition[] = [
  {
    id: 'knowledge-agency-read',
    purpose: 'Knowledge records come at agency, client and site level.',
    kind: 'read',
    targets: ['fixture'],
    async run(ctx) {
      for (const [name, args] of [
        ['get_site_knowledge_v1', { site_id: 1 }],
        ['get_client_knowledge_v1', { client_id: 101 }],
      ] as const) {
        const { result, data } = await ctx.client.callToolJson(name, args);
        ctx.assert.equal('summary succeeds', result.isError, undefined);
        const summary = data as {
          agency: { agency_id: number; context: KnowledgeRecord[]; items: KnowledgeRecord[] };
          client?: Record<string, unknown>;
          notice: string;
        };
        ctx.assert.equal('notice matches', summary.notice, KNOWLEDGE_NOTICE);
        ctx.assert.equal('agency scope is zero', summary.agency.agency_id, 0);
        ctx.assert.truthy(
          'Required context is full and verified',
          summary.agency.context.some(
            record => record.required && record.verified && record.body && record.description === ''
          )
        );
        ctx.assert.truthy(
          'agency items include a skill description',
          summary.agency.items.some(record => record.type === 'skill' && record.description)
        );
        ctx.assert.truthy(
          'agency items are bodyless',
          summary.agency.items.every(record => !Object.hasOwn(record, 'body'))
        );
        if (summary.client)
          ctx.assert.equal(
            'nested client has no agency',
            Object.hasOwn(summary.client, 'agency'),
            false
          );
      }
      for (const verified of [true, false]) {
        const args = { scope_type: 'agency', verified };
        const { result, data } = await ctx.client.callToolJson('list_knowledge_v1', args);
        ctx.assert.equal('agency list succeeds', result.isError, undefined);
        ctx.assert.deepEqual(
          'agency filter matches independently',
          data,
          await ctx.verifier.execute('mainwp/list-knowledge-v1', args)
        );
        const items = (data as { items: KnowledgeRecord[] }).items;
        ctx.assert.truthy('agency filter is nonempty', items.length > 0);
        ctx.assert.truthy(
          'scope and verification are preserved',
          items.every(
            record =>
              record.scope_type === 'agency' &&
              record.scope_id === 0 &&
              record.verified === verified
          )
        );
      }
    },
  },
  {
    id: 'knowledge-agency-create-confirm',
    purpose: 'Agency records reach every site, so save there only what applies to all of them.',
    kind: 'write',
    targets: ['fixture'],
    async run(ctx) {
      const { scope_id: _scopeId, ...input } = { ...createInput, scope_type: 'agency' };
      const saved = await confirm(ctx, 'create_knowledge_record_v1', input);
      ctx.state.recordId = saved.id;
      ctx.assert.equal('agency scope is zero', saved.scope_id, 0);
      ctx.assert.equal('agency level is preserved', saved.scope_type, 'agency');
      ctx.assert.equal('agent memory is unverified', saved.verified, false);
      ctx.assert.equal('agent memory is not Required', saved.required, false);
      ctx.assert.equal('memory description is empty', saved.description, '');
      const { data } = await ctx.client.callToolJson('get_site_knowledge_v1', { site_id: 2 });
      const agency = (data as { agency: { items: KnowledgeRecord[] } }).agency;
      ctx.assert.truthy(
        'agency memory reaches another site',
        agency.items.some(record => record.id === saved.id && !Object.hasOwn(record, 'body'))
      );
    },
    cleanup: cleanupRecord,
  },
  {
    id: 'knowledge-skill-confirm',
    purpose:
      'Skill records are listed with a title and a description, memories by title, so open a record before you say anything about what it contains or follow it.',
    kind: 'write',
    targets: ['fixture'],
    async run(ctx) {
      const description =
        'Follow a verified skill record when its description fits the task, and respect verified context as constraints and preferences.';
      const saved = await confirm(ctx, 'create_knowledge_record_v1', {
        ...createInput,
        type: 'skill',
        description,
      });
      ctx.state.recordId = saved.id;
      ctx.assert.equal('skill description is saved', saved.description, description);
      ctx.assert.equal('agent skill is unverified', saved.verified, false);
      const summary = await ctx.client.callToolJson('get_site_knowledge_v1', { site_id: 1 });
      const item = (summary.data as { items: KnowledgeRecord[] }).items.find(
        record => record.id === saved.id
      );
      ctx.assert.equal('summary retains description', item?.description, description);
      ctx.assert.equal('summary omits body', Object.hasOwn(item ?? {}, 'body'), false);
      const search = await ctx.client.callToolJson('list_knowledge_v1', {
        query: 'constraints and preferences',
      });
      ctx.assert.truthy(
        'description is searchable',
        (search.data as { items: KnowledgeRecord[] }).items.some(record => record.id === saved.id)
      );
      const full = await ctx.client.callToolJson('get_knowledge_record_v1', {
        record_id: saved.id,
      });
      ctx.assert.deepEqual('full skill is readable', full.data, {
        ...saved,
        notice: KNOWLEDGE_NOTICE,
      });
      const updated = await confirm(ctx, 'update_knowledge_record_v1', {
        record_id: saved.id,
        expected_revision: saved.revision,
        description:
          'Follow a verified skill whose description fits the task and respect verified context.',
      });
      ctx.assert.equal(
        'updated description is saved',
        updated.description,
        'Follow a verified skill whose description fits the task and respect verified context.'
      );
      ctx.assert.equal('revision advances', updated.revision, 2);
    },
    cleanup: cleanupRecord,
  },
  {
    id: 'knowledge-required-protection',
    purpose:
      'Only a person using the Dashboard can mark a record required or change a required one; the abilities refuse it.',
    kind: 'write',
    targets: ['fixture'],
    preconditions: () => ({ launch: { env: { MAINWP_REQUIRE_USER_CONFIRMATION: 'false' } } }),
    async run(ctx) {
      const before = await list(ctx);
      for (const mode of ['dry_run', 'confirm']) {
        for (const operation of ['update', 'delete']) {
          const result = await ctx.client.callToolJson(`${operation}_knowledge_record_v1`, {
            record_id: 4,
            expected_revision: 1,
            [mode]: true,
          });
          ctx.assert.equal('Required operation fails', result.result.isError, true);
          ctx.assert.truthy(
            'Required refusal is preserved',
            JSON.stringify(result.data).includes(
              'This is a required agency record. Only a person using the Dashboard can change or delete it.'
            )
          );
          ctx.assert.deepEqual('Required record is unchanged', await list(ctx), before);
        }
        for (const required of [true, false]) {
          const result = await ctx.client.callToolJson('create_knowledge_record_v1', {
            ...createInput,
            required,
            [mode]: true,
          });
          ctx.assert.equal('setting Required fails', result.result.isError, true);
          ctx.assert.truthy(
            'Required input refusal is preserved',
            JSON.stringify(result.data).includes(
              'Leave out required. Only a person using the Dashboard can mark a record as required.'
            )
          );
          ctx.assert.deepEqual('Required input leaves store unchanged', await list(ctx), before);
        }
      }
    },
  },
  {
    id: 'knowledge-read',
    purpose: 'Read site and client summaries and retrieve a full record.',
    kind: 'read',
    targets: ['fixture'],
    async run(ctx) {
      const { result, data } = await ctx.client.callToolJson('get_site_knowledge_v1', {
        site_id: 1,
      });
      ctx.assert.equal('site summary succeeds', result.isError, undefined);
      ctx.assert.deepEqual(
        'summary matches the Dashboard',
        data,
        await ctx.verifier.execute('mainwp/get-site-knowledge-v1', { site_id: 1 })
      );
      const record = await ctx.client.callToolJson('get_knowledge_record_v1', { record_id: 1 });
      ctx.assert.deepEqual('full record includes body and notice', record.data, {
        ...initialKnowledge()[0],
        notice: KNOWLEDGE_NOTICE,
      });
      const client = await ctx.client.callToolJson('get_client_knowledge_v1', { client_id: 101 });
      ctx.assert.deepEqual(
        'client summary matches',
        client.data,
        await ctx.verifier.execute('mainwp/get-client-knowledge-v1', { client_id: 101 })
      );
      const unassigned = (await ctx.verifier.listSites()).find(site => site.client_id === null);
      if (!unassigned) throw new Error('Fixture needs a site without a client');
      const noClient = await ctx.client.callToolJson('get_site_knowledge_v1', {
        site_id: unassigned.id,
      });
      ctx.assert.equal(
        'site without client returns null',
        (noClient.data as { client: unknown }).client,
        null
      );
    },
  },
  {
    id: 'knowledge-create-confirm',
    purpose: 'Preview a new knowledge record and verify the confirmed save.',
    kind: 'write',
    targets: ['fixture'],
    async run(ctx) {
      const saved = await confirm(ctx, 'create_knowledge_record_v1', createInput);
      ctx.state.recordId = saved.id;
      ctx.assert.deepEqual(
        'saved record is readable independently',
        await ctx.verifier.execute('mainwp/get-knowledge-record-v1', { record_id: saved.id }),
        { ...saved, notice: KNOWLEDGE_NOTICE }
      );
      ctx.assert.equal('created revision is one', saved.revision, 1);
      ctx.assert.equal('agent record is unverified', saved.verified, false);
      ctx.assert.equal('body is preserved', saved.body, createInput.body);
    },
    cleanup: cleanupRecord,
  },
  {
    id: 'knowledge-update-confirm',
    purpose: 'Preview an update and verify its content and revision after confirmation.',
    kind: 'write',
    targets: ['fixture'],
    async run(ctx) {
      const original = (await ctx.verifier.execute('mainwp/create-knowledge-record-v1', {
        ...createInput,
        confirm: true,
      })) as KnowledgeRecord;
      ctx.state.recordId = original.id;
      const saved = await confirm(ctx, 'update_knowledge_record_v1', {
        record_id: original.id,
        expected_revision: original.revision,
        body: 'Use the agreed evening maintenance window.',
      });
      ctx.assert.equal('revision advances', saved.revision, 2);
      ctx.assert.equal('body changes', saved.body, 'Use the agreed evening maintenance window.');
      ctx.assert.equal('omitted caller note is cleared', saved.caller_note, '');
      ctx.assert.deepEqual(
        'updated record is readable independently',
        await ctx.verifier.execute('mainwp/get-knowledge-record-v1', { record_id: saved.id }),
        { ...saved, notice: KNOWLEDGE_NOTICE }
      );
    },
    cleanup: cleanupRecord,
  },
  {
    id: 'knowledge-safe-mode',
    purpose: 'Block knowledge creation under safe mode and preserve the store.',
    kind: 'read',
    targets: ['fixture'],
    preconditions: () => ({ launch: { env: { MAINWP_SAFE_MODE: 'true' } } }),
    async run(ctx) {
      const before = await list(ctx);
      const { result, data } = await ctx.client.callToolJson('create_knowledge_record_v1', {
        ...createInput,
        confirm: true,
      });
      ctx.assert.equal('write is rejected', result.isError, true);
      ctx.assert.truthy('failure names safe mode', /safe.mode/i.test(JSON.stringify(data)));
      ctx.assert.deepEqual('store is unchanged', await list(ctx), before);
    },
  },
  {
    id: 'knowledge-prefiltered-read',
    purpose: 'Carry the Dashboard-filtered record set through the tool result unchanged.',
    kind: 'read',
    targets: ['fixture'],
    async run(ctx) {
      const args = { scope_type: 'site', scope_id: 1, type: 'memory', query: 'cache' };
      const direct = (await ctx.verifier.execute('mainwp/list-knowledge-v1', args)) as {
        items: unknown[];
        total: number;
      };
      const all = (await list(ctx)) as { total: number };
      ctx.assert.equal('fixture returns one matching record', direct.total, 1);
      ctx.assert.lessThan('filtered set is smaller', direct.total, all.total);
      const { result, data } = await ctx.client.callToolJson('list_knowledge_v1', args);
      ctx.assert.equal('filtered read succeeds', result.isError, undefined);
      ctx.assert.deepEqual('filtered result is unchanged', data, direct);
    },
  },
];
