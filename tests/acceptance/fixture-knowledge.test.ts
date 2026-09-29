import { describe, expect, it } from 'vitest';
import { FixtureKnowledge } from './fixture-knowledge.js';

const sites = [
  { id: 1, client_id: 101 },
  { id: 2, client_id: null },
];
const create = {
  scope_type: 'site',
  scope_id: 1,
  type: 'skill',
  title: 'Cache procedure',
  body: 'Clear the page cache.',
  caller_note: 'Initial note',
};

describe('fixture knowledge store', () => {
  it('previews and confirms create, update and delete with revision checks', () => {
    const store = new FixtureKnowledge();
    const run = (operation: string, input: Record<string, unknown>) =>
      store.run(`mainwp/${operation}-knowledge-record-v1`, input, sites);
    const before = structuredClone(store.records);
    expect(run('create', { ...create, dry_run: true })).toMatchObject({
      status: 200,
      body: { dry_run: true, would_save: { ...create, source: 'ability', verified: false } },
    });
    expect(store.records).toEqual(before);
    expect(run('create', { ...create, confirm: true })).toMatchObject({
      status: 200,
      body: { id: 4, revision: 1, ...create },
    });
    const saved = structuredClone(store.records);
    const update = { record_id: 4, expected_revision: 1, body: 'Clear and check the page cache.' };
    expect(run('update', { ...update, dry_run: true })).toMatchObject({
      status: 200,
      body: {
        dry_run: true,
        current: { revision: 1 },
        proposed: { revision: 2, body: update.body, caller_note: '' },
      },
    });
    expect(store.records).toEqual(saved);
    expect(run('update', { ...update, confirm: true })).toMatchObject({
      status: 200,
      body: { revision: 2, body: update.body, caller_note: '' },
    });
    const updated = structuredClone(store.records);
    for (const operation of ['update', 'delete']) {
      for (const mode of ['dry_run', 'confirm']) {
        expect(run(operation, { ...update, [mode]: true })).toMatchObject({
          status: 409,
          body: { code: 'mainwp_knowledge_conflict', data: { revision: 2 } },
        });
        expect(store.records).toEqual(updated);
        expect(
          run(operation, { record_id: 999, expected_revision: 1, [mode]: true })
        ).toMatchObject({ status: 404, body: { code: 'mainwp_knowledge_not_found' } });
      }
    }
    const deletion = { record_id: 4, expected_revision: 2 };
    expect(run('delete', { ...deletion, dry_run: true })).toMatchObject({
      body: { dry_run: true, would_delete: { id: 4, revision: 2 } },
    });
    expect(store.records).toEqual(updated);
    expect(run('delete', { ...deletion, confirm: true })).toEqual({
      status: 200,
      body: { deleted: true, id: 4, revision: 2 },
    });
    expect(store.records).toEqual(before);
    expect(run('get', { record_id: 4 })).toMatchObject({
      status: 404,
      body: { code: 'mainwp_knowledge_not_found' },
    });
  });
  it('rejects absent and conflicting write modes without mutating', () => {
    const store = new FixtureKnowledge();
    const before = structuredClone(store.records);
    expect(store.run('mainwp/create-knowledge-record-v1', create, sites)).toMatchObject({
      status: 400,
      body: { code: 'mainwp_confirmation_required' },
    });
    expect(
      store.run(
        'mainwp/create-knowledge-record-v1',
        { ...create, confirm: true, dry_run: true },
        sites
      )
    ).toMatchObject({ status: 400, body: { code: 'mainwp_invalid_input' } });
    expect(store.records).toEqual(before);
  });
  it('returns full context, bodyless items, separate client context and null for no client', () => {
    const store = new FixtureKnowledge();
    const result = store.run('mainwp/get-site-knowledge-v1', { site_id: 1 }, sites);
    expect(result).toMatchObject({
      status: 200,
      body: {
        context: [store.records[0]],
        items: [expect.objectContaining({ id: 2 })],
        client: { client_id: 101, context: [store.records[2]] },
      },
    });
    expect((result.body as { items: unknown[] }).items[0]).not.toHaveProperty('body');
    expect(store.run('mainwp/get-site-knowledge-v1', { site_id: 2 }, sites)).toMatchObject({
      body: { client: null },
    });
  });
});
