import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { CommandRunner } from './commands.js';

interface PackedDependency {
  name: string;
  version: string;
  filename: string;
  shasum: string;
  integrity: string;
}

export interface LocalRegistry {
  url: string;
  close(): Promise<void>;
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
  const packedResult = await runner.run(
    [
      'npm',
      'pack',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      tarballDir,
      ...packagePaths,
    ],
    repoRoot
  );
  const packed = JSON.parse(packedResult.stdout) as PackedDependency[];
  const byName = new Map<string, PackedDependency>();
  for (const dependency of packed) byName.set(dependency.name, dependency);

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/tarballs/')) {
      const filename = path.basename(decodeURIComponent(url.pathname.slice('/tarballs/'.length)));
      const filePath = path.join(tarballDir, filename);
      if (!fs.existsSync(filePath)) return json(response, 404, { error: 'tarball not found' });
      const stat = fs.statSync(filePath);
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': stat.size,
      });
      fs.createReadStream(filePath).pipe(response);
      return;
    }

    const name = decodeURIComponent(url.pathname.slice(1));
    const dependency = byName.get(name);
    if (!dependency) return json(response, 404, { error: `package ${name} not found` });
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'node_modules', name, 'package.json'), 'utf8')
    ) as Record<string, unknown>;
    const address = server.address();
    if (!address || typeof address === 'string') {
      return json(response, 500, { error: 'registry is not bound' });
    }
    const tarballUrl = `http://127.0.0.1:${address.port}/tarballs/${encodeURIComponent(
      dependency.filename
    )}`;
    json(response, 200, {
      _id: name,
      name,
      'dist-tags': { latest: dependency.version },
      versions: {
        [dependency.version]: {
          ...packageJson,
          dist: {
            tarball: tarballUrl,
            shasum: dependency.shasum,
            integrity:
              dependency.integrity ||
              `sha512-${crypto
                .createHash('sha512')
                .update(fs.readFileSync(path.join(tarballDir, dependency.filename)))
                .digest('base64')}`,
          },
        },
      },
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
