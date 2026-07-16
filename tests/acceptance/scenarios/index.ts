import { configurationScenarios } from './configuration.js';
import { completionScenarios } from './completions.js';
import { confirmationScenarios } from './confirmation.js';
import { policyScenarios } from './policy.js';
import { readScenarios } from './read.js';
import type { ScenarioDefinition } from './types.js';
import { transportScenarios } from './transport.js';
import { writeScenarios } from './writes.js';

export const scenarios: ScenarioDefinition[] = [
  ...readScenarios,
  ...completionScenarios,
  ...policyScenarios,
  ...configurationScenarios,
  ...writeScenarios,
  ...confirmationScenarios,
  ...transportScenarios,
];

const duplicateIds = scenarios
  .map(scenario => scenario.id)
  .filter((id, index, all) => all.indexOf(id) !== index);
if (duplicateIds.length > 0) throw new Error(`Duplicate acceptance scenario IDs: ${duplicateIds}`);
