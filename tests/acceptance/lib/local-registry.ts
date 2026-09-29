import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { CommandRunner } from './commands.js';
import { parseNpmPackJson, type NpmPackRecord } from './npm-pack-json.js';

export interface LocalRegistry {
  url: string;
  close(): Promise<void>;
}

// Installs always carry explicit ranges from the packed manifests, so
// dist-tags.latest is advisory; a prerelease-blind numeric compare is enough
// and avoids pulling a semver dependency into the harness.
function compareVersions(a: string, b: string): number {
  const parse = (version: string) =>
    version
      .split(/[-+]/)[0]
      .split('.')
      .map(part => Number(part) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

// npm 12 reports one pack record per package name, so a hoisted copy and a
// nested copy of the same name must go to separate `npm pack` calls.
export function batchByUniqueName<T>(items: T[], nameOf: (item: T) => string): T[][] {
  const batches: T[][] = [];
  const seen = new Map<string, number>();
  for (const item of items) {
    const name = nameOf(item);
    const round = seen.get(name) ?? 0;
    seen.set(name, round + 1);
    (batches[round] ??= []).push(item);
  }
  return batches;
}

function json(response: http.ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

export async function startLocalDependencyRegistry(
  repoRoot: string,
  tempRoot: string,
  runner: CommandRunner
): Promise<LocalRegistry> {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { dev?: boolean }>;
  };
  const packagePaths = Object.entries(lock.packages)
    .filter(([packagePath, metadata]) => packagePath.startsWith('node_modules/') && !metadata.dev)
    .map(([packagePath]) => path.join(repoRoot, packagePath))
    .filter(packagePath => fs.existsSync(path.join(packagePath, 'package.json')));
  const tarballDir = path.join(tempRoot, 'dependency-tarballs');
  fs.mkdirSync(tarballDir, { recursive: true });
  // npm 10 runs a dependency's prepare/prepack scripts during `npm pack`
  // despite --ignore-scripts (fixed in npm 11), and installed copies lack the
  // dev tooling those scripts expect. Pack staged copies with the pack-time
  // scripts stripped so the behavior does not depend on the npm version.
  const stagingDir = path.join(tempRoot, 'dependency-staging');
  const stagedManifests = new Map<string, Record<string, unknown>>();
  const staged = packagePaths.map((packagePath, index) => {
    const stagedPath = path.join(stagingDir, String(index));
    fs.cpSync(packagePath, stagedPath, { recursive: true });
    const manifestPath = path.join(stagedPath, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<
      string,
      unknown
    > & {
      name?: string;
      version?: string;
      scripts?: Record<string, string>;
    };
    if (manifest.scripts) {
      delete manifest.scripts.prepare;
      delete manifest.scripts.prepack;
      delete manifest.scripts.postpack;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }
    stagedManifests.set(`${manifest.name}@${manifest.version}`, manifest);
    return { stagedPath, name: String(manifest.name) };
  });
  const packed: NpmPackRecord[] = [];
  for (const batch of batchByUniqueName(staged, entry => entry.name)) {
    const packedResult = await runner.run(
      [
        'npm',
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        tarballDir,
        ...batch.map(entry => entry.stagedPath),
      ],
      repoRoot
    );
    packed.push(...parseNpmPackJson(packedResult.stdout, batch.length));
  }
  // A name can appear at several versions at once (hoisted plus nested copies
  // with disjoint semver ranges), so the metadata must carry every version or
  // npm fails the unsatisfied range with ETARGET.
  const byName = new Map<string, Map<string, NpmPackRecord>>();
  for (const dependency of packed) {
    let versions = byName.get(dependency.name);
    if (!versions) byName.set(dependency.name, (versions = new Map()));
    versions.set(dependency.version, dependency);
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/tarballs/')) {
      let filename: string;
      try {
        filename = path.basename(decodeURIComponent(url.pathname.slice('/tarballs/'.length)));
      } catch {
        return json(response, 404, { error: 'tarball not found' });
      }
      if (!filename || filename === '.' || filename === '..') {
        return json(response, 404, { error: 'tarball not found' });
      }
      const filePath = path.join(tarballDir, filename);
      let stat: fs.Stats | undefined;
      try {
        stat = fs.statSync(filePath, { throwIfNoEntry: false });
      } catch {
        return json(response, 404, { error: 'tarball not found' });
      }
      if (!stat?.isFile()) return json(response, 404, { error: 'tarball not found' });
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': stat.size,
      });
      fs.createReadStream(filePath)
        .on('error', () => {
          if (!response.headersSent) {
            json(response, 500, { error: 'failed to stream tarball' });
          } else {
            response.end();
          }
        })
        .pipe(response);
      return;
    }

    let name: string;
    try {
      name = decodeURIComponent(url.pathname.slice(1));
    } catch {
      // Malformed percent-encoding must not take the registry down.
      return json(response, 400, { error: 'malformed package name encoding' });
    }
    const dependencyVersions = byName.get(name);
    if (!dependencyVersions) return json(response, 404, { error: `package ${name} not found` });
    const address = server.address();
    if (!address || typeof address === 'string') {
      return json(response, 500, { error: 'registry is not bound' });
    }
    const versions: Record<string, unknown> = {};
    let latest = '';
    for (const [version, dependency] of dependencyVersions) {
      // The staged manifest is what actually got packed; node_modules/<name>
      // only holds the hoisted copy, the wrong manifest for nested versions.
      const manifest = stagedManifests.get(`${name}@${version}`) ?? {};
      versions[version] = {
        ...manifest,
        dist: {
          tarball: `http://127.0.0.1:${address.port}/tarballs/${encodeURIComponent(
            dependency.filename
          )}`,
          shasum: dependency.shasum,
          integrity:
            dependency.integrity ||
            `sha512-${crypto
              .createHash('sha512')
              .update(fs.readFileSync(path.join(tarballDir, dependency.filename)))
              .digest('base64')}`,
        },
      };
      if (!latest || compareVersions(version, latest) > 0) latest = version;
    }
    json(response, 200, {
      _id: name,
      name,
      'dist-tags': { latest },
      versions,
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local registry failed to bind');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      }),
  };
}
