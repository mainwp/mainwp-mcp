import { knowledgeScenarios } from './knowledge.js';
import { abilityReadScenarios } from './ability-reads.js';
import { configurationScenarios } from './configuration.js';
import { completionScenarios } from './completions.js';
import { confirmationScenarios } from './confirmation.js';
import { idInputScenarios } from './id-inputs.js';
import { fixtureNullableInputs } from './nullable-inputs.js';
import { policyScenarios } from './policy.js';
import { readScenarios } from './read.js';
import { setupScenarios } from './setup.js';
import type { ScenarioDefinition } from './types.js';
import { transportScenarios } from './transport.js';
import { writeScenarios } from './writes.js';

export const scenarios: ScenarioDefinition[] = [
  ...readScenarios,
  ...knowledgeScenarios,
  ...abilityReadScenarios,
  ...completionScenarios,
  ...policyScenarios,
  ...configurationScenarios,
  ...setupScenarios,
  ...writeScenarios,
  ...confirmationScenarios,
  fixtureNullableInputs,
  ...transportScenarios,
  ...idInputScenarios,
];

const duplicateIds = scenarios
  .map(scenario => scenario.id)
  .filter((id, index, all) => all.indexOf(id) !== index);
if (duplicateIds.length > 0) throw new Error(`Duplicate acceptance scenario IDs: ${duplicateIds}`);
