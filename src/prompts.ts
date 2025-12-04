/**
 * MCP Prompt Templates
 *
 * Pre-defined workflow prompts for common MainWP operations.
 * These help AI assistants guide users through complex tasks.
 */

import type { Prompt, GetPromptResult, PromptMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * Internal prompt definition with message generator
 */
interface PromptDefinition {
  name: string;
  description: string;
  arguments?: Array<{
    name: string;
    description: string;
    required: boolean;
  }>;
  getMessages: (args?: Record<string, string>) => PromptMessage[];
}

/**
 * All available prompt definitions
 */
const promptDefinitions: PromptDefinition[] = [
  // === Site Troubleshooting ===
  {
    name: 'troubleshoot-site',
    description: 'Diagnose issues with a MainWP child site',
    arguments: [
      { name: 'site_id', description: 'ID of the site to troubleshoot', required: true },
      { name: 'issue_type', description: 'Focus area: connectivity, performance, security, updates (optional)', required: false },
    ],
    getMessages: (args) => [{
      role: 'user',
      content: {
        type: 'text',
        text: `Please diagnose issues with site ID ${args?.site_id || '[site_id]'}.${args?.issue_type ? ` Focus on: ${args.issue_type}.` : ''}

Steps to follow:
1. Use mainwp_get_site_v1 to get site details and check connectivity status
2. Check the last sync time - if stale, there may be connectivity issues
3. Use mainwp_list_updates_v1 to check for pending updates
4. Review any error messages or warnings

Provide a summary of:
- Current site status
- Any issues found
- Recommended actions to resolve problems`,
      },
    }],
  },

  // === Maintenance Check ===
  {
    name: 'maintenance-check',
    description: 'Run a comprehensive maintenance check across all managed sites',
    arguments: [],
    getMessages: () => [{
      role: 'user',
      content: {
        type: 'text',
        text: `Run a comprehensive maintenance check across all managed sites.

Steps to follow:
1. Use mainwp_list_sites_v1 to get all sites
2. Use mainwp_list_updates_v1 to check for pending updates
3. Identify sites that haven't synced recently (check last_sync timestamps)

Generate a maintenance summary including:
- Total sites managed
- Sites with pending plugin updates (list them)
- Sites with pending theme updates (list them)
- Sites with pending WordPress core updates (list them)
- Sites with connectivity issues or stale sync times
- Recommended priority order for maintenance tasks`,
      },
    }],
  },

  // === Update Workflow ===
  {
    name: 'update-workflow',
    description: 'Guide through safely updating WordPress sites',
    arguments: [
      { name: 'update_type', description: 'Type of updates: plugins, themes, core, or all', required: false },
      { name: 'site_ids', description: 'Comma-separated site IDs, or "all" for all sites', required: false },
    ],
    getMessages: (args) => [{
      role: 'user',
      content: {
        type: 'text',
        text: `Help me safely update ${args?.update_type || 'all'} on ${args?.site_ids || 'all sites'}.

Guide me through this update workflow:

1. **Pre-update Assessment**
   - List all pending ${args?.update_type || ''} updates using mainwp_list_updates_v1
   - Identify any updates that might have compatibility issues
   - Check which sites are affected

2. **Update Strategy**
   - Recommend which updates to apply first (security patches > bug fixes > features)
   - Suggest testing on staging/less critical sites first
   - Identify any plugins/themes that should be researched before updating

3. **Safety Recommendations**
   - Remind about backup status
   - Suggest update order (core before plugins/themes)
   - Note any updates that require manual intervention

Please start by checking the current update status.`,
      },
    }],
  },

  // === Site Report ===
  {
    name: 'site-report',
    description: 'Generate a detailed report for a specific site',
    arguments: [
      { name: 'site_id', description: 'ID of the site to report on', required: true },
    ],
    getMessages: (args) => [{
      role: 'user',
      content: {
        type: 'text',
        text: `Generate a detailed report for site ID ${args?.site_id || '[site_id]'}.

Gather information using available tools and create a report covering:

1. **Site Overview**
   - Site name and URL
   - WordPress version
   - Last sync status and time

2. **Update Status**
   - Pending plugin updates (count and list)
   - Pending theme updates (count and list)
   - Core update status

3. **Health Indicators**
   - Connectivity status
   - Any recent errors or warnings
   - Sync reliability

4. **Recommendations**
   - Prioritized action items
   - Any immediate concerns

Format the report in a clear, scannable format.`,
      },
    }],
  },

  // === Network Summary ===
  {
    name: 'network-summary',
    description: 'Generate a summary report of all managed sites',
    arguments: [],
    getMessages: () => [{
      role: 'user',
      content: {
        type: 'text',
        text: `Generate a network-wide summary of all managed WordPress sites.

Steps to follow:
1. Use mainwp_list_sites_v1 to get all sites
2. Aggregate statistics across the network

Create a summary report including:

**Network Overview**
- Total number of sites
- Sites by status (connected, disconnected, issues)

**Update Summary**
- Total pending plugin updates
- Total pending theme updates
- Total pending core updates
- Sites fully up-to-date vs needing updates

**Health Overview**
- Sites synced in last 24 hours
- Sites with stale sync (>24 hours)
- Any sites with errors

**Action Items**
- Most urgent maintenance tasks
- Sites requiring immediate attention

Present the data in a clear, executive-summary format.`,
      },
    }],
  },

  // === Security Audit ===
  {
    name: 'security-audit',
    description: 'Perform a security-focused audit of managed sites',
    arguments: [
      { name: 'site_ids', description: 'Comma-separated site IDs to audit, or "all"', required: false },
    ],
    getMessages: (args) => [{
      role: 'user',
      content: {
        type: 'text',
        text: `Perform a security-focused audit of ${args?.site_ids || 'all managed sites'}.

Security audit checklist:

1. **WordPress Core**
   - Check for outdated WordPress versions
   - Identify any sites running unsupported versions

2. **Plugin Security**
   - List plugins with available security updates
   - Identify any plugins that are abandoned/not updated in 2+ years
   - Flag plugins known to have security issues

3. **Theme Security**
   - Check for outdated themes
   - Identify unused themes that should be removed

4. **General Recommendations**
   - Sites most urgently needing security updates
   - Best practices reminders
   - Priority order for security updates

Start by gathering the site and update information, then provide the security assessment.`,
      },
    }],
  },

  // === Backup Status ===
  {
    name: 'backup-status',
    description: 'Check backup status across managed sites',
    arguments: [
      { name: 'site_ids', description: 'Comma-separated site IDs, or "all" (default)', required: false },
    ],
    getMessages: (args) => [{
      role: 'user',
      content: {
        type: 'text',
        text: `Check the backup status for ${args?.site_ids || 'all managed sites'}.

Please help me understand the backup situation:

1. **Backup Overview**
   - Which sites have backup plugins installed?
   - When was the last backup for each site?
   - Are there any sites without backup solutions?

2. **Backup Health**
   - Sites with recent backups (< 24 hours)
   - Sites with aging backups (> 7 days)
   - Sites with no recent backup data

3. **Recommendations**
   - Sites that need immediate backup attention
   - Suggestions for backup improvements
   - Best practices for backup frequency

Note: This analysis depends on the backup data available through MainWP. If backup information is limited, please indicate what additional data would be helpful.`,
      },
    }],
  },

  // === Performance Check ===
  {
    name: 'performance-check',
    description: 'Analyze site performance indicators',
    arguments: [
      { name: 'site_id', description: 'Site ID to analyze, or "all" for overview', required: false },
    ],
    getMessages: (args) => [{
      role: 'user',
      content: {
        type: 'text',
        text: `Analyze performance indicators for ${args?.site_id ? `site ID ${args.site_id}` : 'all managed sites'}.

Performance analysis:

1. **Site Health**
   - Sync response times (if available)
   - Connection reliability
   - Any timeout or connection errors

2. **Resource Indicators**
   - Number of active plugins (more plugins = potential slowdown)
   - Theme complexity indicators
   - Database or storage concerns (if data available)

3. **Optimization Opportunities**
   - Sites with excessive plugins
   - Outdated components that may impact performance
   - Caching and optimization plugin status

4. **Recommendations**
   - Sites most likely to benefit from optimization
   - Quick wins for performance improvement
   - Further investigation suggestions

Gather available data and provide performance insights based on what can be determined from MainWP.`,
      },
    }],
  },
];

/**
 * Get the list of available prompts for MCP ListPrompts request
 */
export function getPromptList(): Prompt[] {
  return promptDefinitions.map(({ name, description, arguments: args }) => ({
    name,
    description,
    arguments: args,
  }));
}

/**
 * Get a specific prompt with its messages for MCP GetPrompt request
 */
export function getPrompt(name: string, args?: Record<string, string>): GetPromptResult {
  const prompt = promptDefinitions.find(p => p.name === name);

  if (!prompt) {
    throw new Error(`Unknown prompt: ${name}`);
  }

  return {
    messages: prompt.getMessages(args),
  };
}

/**
 * Get prompt argument values for completions
 */
export function getPromptArgumentCompletions(promptName: string, argumentName: string): string[] {
  if (argumentName === 'update_type') {
    return ['plugins', 'themes', 'core', 'all'];
  }

  if (argumentName === 'issue_type') {
    return ['connectivity', 'performance', 'security', 'updates'];
  }

  // site_id and site_ids require dynamic data - return empty for static completions
  return [];
}
