export function parseWriteHosts(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);
}

export function isWriteHostAllowed(hostname: string, additionalHosts: string[]): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host.endsWith('.local') ||
    additionalHosts.some(candidate => candidate.toLowerCase() === host)
  );
}

export function getWriteGuardReason(
  dashboardUrl: string,
  writesEnabled: boolean,
  configuredHosts: string | undefined
): string | null {
  if (!writesEnabled) return 'Write scenarios require --writes.';
  const hostname = new URL(dashboardUrl).hostname;
  if (!isWriteHostAllowed(hostname, parseWriteHosts(configuredHosts))) {
    return (
      `Dashboard host ${hostname} is not write-allowed. ` +
      'Use localhost, 127.0.0.1, a .local host, or MAINWP_MCP_ACCEPTANCE_WRITE_HOSTS.'
    );
  }
  return null;
}
