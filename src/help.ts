/**
 * Help Documentation Generation
 *
 * Generates structured help documents from MainWP ability metadata.
 * Purely functional — no state, no side effects.
 */

import { abilityNameToToolName } from './naming.js';
import type { Ability } from './abilities.js';

/**
 * Help documentation for a single tool
 */
export interface ToolHelp {
  toolName: string;
  abilityName: string;
  label: string;
  description: string;
  category: string;
  annotations: {
    readonly: boolean;
    destructive: boolean;
    idempotent: boolean;
    instructions?: string;
  };
  safetyFeatures: {
    supportsDryRun: boolean;
    requiresConfirm: boolean;
  };
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    description?: string;
  }>;
}

/**
 * Complete help document structure
 */
export interface HelpDocument {
  version: string;
  generated: string;
  overview: {
    totalTools: number;
    categories: string[];
    safetyConventions: Record<string, string>;
  };
  destructiveTools: string[];
  toolsWithDryRun: string[];
  toolsRequiringConfirm: string[];
  toolsByCategory: Record<string, ToolHelp[]>;
}

/**
 * Generate help documentation for a single ability
 */
export function generateToolHelp(ability: Ability): ToolHelp {
  const toolName = abilityNameToToolName(ability.name);
  const props = (ability.input_schema?.properties || {}) as Record<string, Record<string, unknown>>;
  const required = (ability.input_schema?.required as string[]) || [];

  const parameters = Object.entries(props).map(([name, prop]) => ({
    name,
    type: String(prop.type || 'unknown'),
    required: required.includes(name),
    description: prop.description as string | undefined,
  }));

  return {
    toolName,
    abilityName: ability.name,
    label: ability.label,
    description: ability.description,
    category: ability.category,
    annotations: {
      readonly: ability.meta?.annotations?.readonly ?? false,
      destructive: ability.meta?.annotations?.destructive ?? true,
      idempotent: ability.meta?.annotations?.idempotent ?? false,
      instructions: ability.meta?.annotations?.instructions,
    },
    safetyFeatures: {
      supportsDryRun: 'dry_run' in props,
      requiresConfirm: 'confirm' in props,
    },
    parameters,
  };
}

/**
 * Generate complete help document from all abilities
 */
export function generateHelpDocument(abilities: Ability[]): HelpDocument {
  const toolHelps = abilities.map(generateToolHelp);
  const normalizeCategory = (c: string | undefined) => c?.trim() || 'uncategorized';

  const categories = [...new Set(toolHelps.map(h => normalizeCategory(h.category)))].sort();

  const toolsByCategory: Record<string, ToolHelp[]> = {};
  for (const help of toolHelps) {
    const cat = normalizeCategory(help.category);
    if (!toolsByCategory[cat]) toolsByCategory[cat] = [];
    toolsByCategory[cat].push(help);
  }

  return {
    version: '1.0',
    generated: new Date().toISOString(),
    overview: {
      totalTools: abilities.length,
      categories,
      safetyConventions: {
        dryRun: 'Pass dry_run: true to preview the operation without making changes',
        confirm: 'Pass confirm: true to execute destructive operations',
        destructive: 'These tools can permanently delete or modify data',
        readonly: 'These tools only read data and never modify anything',
      },
    },
    destructiveTools: toolHelps.filter(h => h.annotations.destructive).map(h => h.toolName),
    toolsWithDryRun: toolHelps.filter(h => h.safetyFeatures.supportsDryRun).map(h => h.toolName),
    toolsRequiringConfirm: toolHelps
      .filter(h => h.safetyFeatures.requiresConfirm)
      .map(h => h.toolName),
    toolsByCategory,
  };
}
