import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBundleLaunch, substituteBundleVariables } from './bundle.js';

const roots: string[] = [];
const credentials = {
  dashboardUrl: 'https://dashboard.example.com/wp',
  username: 'bundle-user',
  appPassword: 'test password ${__dirname} $HOME',
};
const manifest = {
  manifest_version: '0.4',
  name: 'mainwp-mcp',
  version: '1.4.0',
  description: 'MainWP server',
  author: { name: 'MainWP' },
  server: {
    type: 'node',
    entry_point: 'dist/index.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/dist/index.js'],
      env: {
        MAINWP_URL: '${user_config.dashboard_url}',
        MAINWP_USER: '${user_config.username}',
        MAINWP_APP_PASSWORD: '${user_config.app_password}',
      },
    },
  },
};

function extractedRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mainwp-bundle-test-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist/index.js'), '');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('bundle manifest launch', () => {
  it('substitutes placeholders once without interpreting credential content', () => {
    expect(
      substituteBundleVariables('${__dirname}/${user_config.app_password}', '/bundle', {
        app_password: credentials.appPassword,
      })
    ).toBe(`/bundle/${credentials.appPassword}`);
  });

  it('refuses unresolved placeholders', () => {
    expect(() => substituteBundleVariables('${user_config.missing}', '/bundle', {})).toThrow(
      'Unsupported bundle placeholder'
    );
  });

  it('resolves the manifest command, arguments and credential environment', () => {
    const root = extractedRoot();
    expect(resolveBundleLaunch(manifest, root, credentials)).toEqual({
      command: 'node',
      args: [path.join(root, 'dist/index.js')],
      entry: path.join(root, 'dist/index.js'),
      env: {
        MAINWP_URL: credentials.dashboardUrl,
        MAINWP_USER: credentials.username,
        MAINWP_APP_PASSWORD: credentials.appPassword,
      },
    });
  });

  it.each(['../outside.js', '/outside.js', '../bundle-sibling/index.js'])(
    'refuses an entry point outside the extraction directory: %s',
    entry => {
      const root = extractedRoot();
      expect(() =>
        resolveBundleLaunch(
          { ...manifest, server: { ...manifest.server, entry_point: entry } },
          root,
          credentials
        )
      ).toThrow('Bundle entry point escapes the extraction directory');
    }
  );

  it('refuses a missing entry point', () => {
    const root = extractedRoot();
    fs.rmSync(path.join(root, 'dist/index.js'));
    expect(() => resolveBundleLaunch(manifest, root, credentials)).toThrow(
      'Bundle entry point is missing or is not a file'
    );
  });

  it('refuses a symlink that escapes the extraction directory', () => {
    const root = extractedRoot();
    const outside = extractedRoot();
    fs.rmSync(path.join(root, 'dist/index.js'));
    fs.symlinkSync(path.join(outside, 'dist/index.js'), path.join(root, 'dist/index.js'));
    expect(() => resolveBundleLaunch(manifest, root, credentials)).toThrow(
      'Bundle entry point escapes the extraction directory'
    );
  });

  it('refuses arguments that launch a different entry point', () => {
    const root = extractedRoot();
    expect(() =>
      resolveBundleLaunch(
        {
          ...manifest,
          server: {
            ...manifest.server,
            mcp_config: { ...manifest.server.mcp_config, args: ['/repo/dist/index.js'] },
          },
        },
        root,
        credentials
      )
    ).toThrow('Bundle launch arguments do not reference the extracted entry point');
  });
});
