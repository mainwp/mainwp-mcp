import { isIP } from 'node:net';

export function parseWriteHosts(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);
}

export function isWriteHostAllowed(
  hostname: string,
  additionalHosts: string[],
  autoApprovedHost?: string
): boolean {
  const host = hostname.toLowerCase();
  const unwrappedHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const isLoopbackAddress =
    (isIP(unwrappedHost) === 4 && unwrappedHost.split('.')[0] === '127') ||
    (isIP(unwrappedHost) === 6 && unwrappedHost === '::1');
  return (
    host === 'localhost' ||
    isLoopbackAddress ||
    autoApprovedHost?.toLowerCase() === host ||
    additionalHosts.some(candidate => candidate.toLowerCase() === host)
  );
}

export function getWriteGuardReason(
  dashboardUrl: string,
  writesEnabled: boolean,
  configuredHosts: string | undefined,
  target: 'live' | 'fixture',
  autoApprovedHost?: string
): string | null {
  if (target === 'fixture') return null;
  if (!writesEnabled) return 'Write scenarios require --writes.';
  const hostname = new URL(dashboardUrl).hostname;
  if (!isWriteHostAllowed(hostname, parseWriteHosts(configuredHosts), autoApprovedHost)) {
    return (
      `Dashboard host ${hostname} is not write-allowed. ` +
      'Use a loopback host, the auto-resolved testbed host, or ' +
      'MAINWP_MCP_ACCEPTANCE_WRITE_HOSTS.'
    );
  }
  return null;
}
