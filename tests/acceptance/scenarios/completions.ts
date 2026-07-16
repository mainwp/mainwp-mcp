import type { ScenarioDefinition } from './types.js';

function errorCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

export const promptCompletions: ScenarioDefinition = {
  id: 'prompt-completions',
  purpose:
    'Verify prompt completions against the direct ability schema and enforce completion policy.',
  kind: 'read',
  targets: ['live', 'fixture'],
  preconditions: () => ({ launch: { env: { MAINWP_BLOCKED_TOOLS: 'list_sites_v1' } } }),
  async run(ctx) {
    const validUpdateTypes = await ctx.verifier.getAbilityInputArrayEnum(
      'mainwp/list-updates-v1',
      'types'
    );
    const result = await ctx.client.complete(
      { type: 'ref/prompt', name: 'update-workflow' },
      'update_type',
      'c'
    );
    const suggestions = result.completion.values;
    ctx.assert.truthy('completion suggestions are non-empty', suggestions.length > 0);
    ctx.assert.equal(
      'every completion is accepted by the direct list-updates schema',
      suggestions.every(value => validUpdateTypes.includes(value)),
      true
    );

    let policyError: unknown;
    try {
      await ctx.client.complete({ type: 'ref/prompt', name: 'performance-check' }, 'site_id', '');
    } catch (error) {
      policyError = error;
    }
    ctx.assert.equal(
      'blocked list-sites denies site-id completions',
      errorCode(policyError),
      -32008
    );
  },
};

export const completionScenarios = [promptCompletions];
