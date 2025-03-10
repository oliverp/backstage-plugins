/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { NotFoundError } from '@backstage/errors';
import {
  setupRequestMockHandlers,
  withLogCollector,
} from '@backstage/test-utils';

import { Command } from 'commander';
import fs from 'fs-extra';
import mockFs from 'mock-fs';
import { rest } from 'msw';
import { setupServer } from 'msw/node';

import { resolve as resolvePath } from 'path';

import { paths } from '../../lib/paths';
import * as runObj from '../../lib/run';
import { Lockfile } from '../../lib/versioning/Lockfile';
import { YarnInfoInspectData } from '../../lib/versioning/packages';
import bump, { bumpBackstageJsonVersion, createVersionFinder } from './bump';

// Remove log coloring to simplify log matching
jest.mock('chalk', () => ({
  red: (str: string) => str,
  blue: (str: string) => str,
  cyan: (str: string) => str,
  green: (str: string) => str,
  magenta: (str: string) => str,
  yellow: (str: string) => str,
}));

jest.mock('ora', () => ({
  __esModule: true,
  default({ prefixText }: any) {
    console.log(prefixText);
    return {
      start: () => ({
        succeed: () => {},
      }),
    };
  },
}));

jest.mock('../../lib/run', () => {
  return {
    run: jest.fn(),
  };
});

const mockFetchPackageInfo = jest.fn();
jest.mock('../../lib/versioning/packages', () => {
  const actual = jest.requireActual('../../lib/versioning/packages');
  return {
    ...actual,
    fetchPackageInfo: (name: string) => mockFetchPackageInfo(name),
  };
});

const REGISTRY_VERSIONS: { [name: string]: string } = {
  '@backstage/core': '1.0.6',
  '@backstage/core-api': '1.0.7',
  '@backstage/theme': '2.0.0',
  '@backstage-extra/custom': '1.1.0',
  '@backstage-extra/custom-two': '2.0.0',
  '@backstage/create-app': '1.0.0',
};

const HEADER = `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1

`;

const lockfileMock = `${HEADER}
"@backstage/core@^1.0.5":
  version "1.0.6"
  dependencies:
    "@backstage/core-api" "^1.0.6"

"@backstage/core@^1.0.3":
  version "1.0.3"
  dependencies:
    "@backstage/core-api" "^1.0.3"

"@backstage/theme@^1.0.0":
  version "1.0.0"

"@backstage/core-api@^1.0.6":
  version "1.0.6"

"@backstage/core-api@^1.0.3":
  version "1.0.3"
`;

// This is the lockfile that we produce to unlock versions before we run yarn install
const lockfileMockResult = `${HEADER}
"@backstage/core@^1.0.5":
  version "1.0.6"
  dependencies:
    "@backstage/core-api" "^1.0.6"

"@backstage/theme@^1.0.0":
  version "1.0.0"
`;

describe('bump', () => {
  beforeEach(() => {
    mockFetchPackageInfo.mockImplementation(async name => ({
      name: name,
      'dist-tags': {
        latest: REGISTRY_VERSIONS[name],
      },
    }));
  });

  afterEach(() => {
    mockFs.restore();
    jest.resetAllMocks();
  });

  const worker = setupServer();
  setupRequestMockHandlers(worker);

  it('should bump backstage dependencies', async () => {
    mockFs({
      '/yarn.lock': lockfileMock,
      '/package.json': JSON.stringify({
        workspaces: {
          packages: ['packages/*'],
        },
      }),
      '/packages/a/package.json': JSON.stringify({
        name: 'a',
        dependencies: {
          '@backstage/core': '^1.0.5',
        },
      }),
      '/packages/b/package.json': JSON.stringify({
        name: 'b',
        dependencies: {
          '@backstage/core': '^1.0.3',
          '@backstage/theme': '^1.0.0',
        },
      }),
    });

    jest
      .spyOn(paths, 'resolveTargetRoot')
      .mockImplementation((...path) => resolvePath('/', ...path));
    jest.spyOn(runObj, 'run').mockResolvedValue(undefined);
    worker.use(
      rest.get(
        'https://versions.backstage.io/v1/tags/main/manifest.json',
        (_, res, ctx) =>
          res(
            ctx.status(200),
            ctx.json({
              packages: [],
            }),
          ),
      ),
    );
    const { log: logs } = await withLogCollector(['log'], async () => {
      await bump({ pattern: null, release: 'main' } as unknown as Command);
    });
    expect(logs.filter(Boolean)).toEqual([
      'Using default pattern glob @backstage/*',
      'Checking for updates of @backstage/core',
      'Checking for updates of @backstage/theme',
      'Checking for updates of @backstage/core-api',
      'Some packages are outdated, updating',
      'unlocking @backstage/core@^1.0.3 ~> 1.0.6',
      'unlocking @backstage/core-api@^1.0.6 ~> 1.0.7',
      'unlocking @backstage/core-api@^1.0.3 ~> 1.0.7',
      'bumping @backstage/core in a to ^1.0.6',
      'bumping @backstage/core in b to ^1.0.6',
      'bumping @backstage/theme in b to ^2.0.0',
      'Running yarn install to install new versions',
      '⚠️  The following packages may have breaking changes:',
      '  @backstage/theme : 1.0.0 ~> 2.0.0',
      '    https://github.com/backstage/backstage/blob/master/packages/theme/CHANGELOG.md',
      'Version bump complete!',
    ]);

    expect(mockFetchPackageInfo).toHaveBeenCalledTimes(3);
    expect(mockFetchPackageInfo).toHaveBeenCalledWith('@backstage/core');
    expect(mockFetchPackageInfo).toHaveBeenCalledWith('@backstage/core-api');
    expect(mockFetchPackageInfo).toHaveBeenCalledWith('@backstage/theme');

    expect(runObj.run).toHaveBeenCalledTimes(1);
    expect(runObj.run).toHaveBeenCalledWith(
      'yarn',
      ['install'],
      expect.any(Object),
    );

    const lockfileContents = await fs.readFile('/yarn.lock', 'utf8');
    expect(lockfileContents).toBe(lockfileMockResult);

    const packageA = await fs.readJson('/packages/a/package.json');
    expect(packageA).toEqual({
      name: 'a',
      dependencies: {
        '@backstage/core': '^1.0.6',
      },
    });
    const packageB = await fs.readJson('/packages/b/package.json');
    expect(packageB).toEqual({
      name: 'b',
      dependencies: {
        '@backstage/core': '^1.0.6',
        '@backstage/theme': '^2.0.0',
      },
    });
  });

  it('should bump backstage dependencies but not install them', async () => {
    mockFs({
      '/yarn.lock': lockfileMock,
      '/package.json': JSON.stringify({
        workspaces: {
          packages: ['packages/*'],
        },
      }),
      '/packages/a/package.json': JSON.stringify({
        name: 'a',
        dependencies: {
          '@backstage/core': '^1.0.5',
        },
      }),
      '/packages/b/package.json': JSON.stringify({
        name: 'b',
        dependencies: {
          '@backstage/core': '^1.0.3',
          '@backstage/theme': '^1.0.0',
        },
      }),
    });

    jest
      .spyOn(paths, 'resolveTargetRoot')
      .mockImplementation((...path) => resolvePath('/', ...path));
    jest.spyOn(runObj, 'run').mockResolvedValue(undefined);
    worker.use(
      rest.get(
        'https://versions.backstage.io/v1/tags/main/manifest.json',
        (_, res, ctx) =>
          res(
            ctx.status(200),
            ctx.json({
              packages: [],
            }),
          ),
      ),
    );
    const { log: logs } = await withLogCollector(['log'], async () => {
      await bump({
        pattern: null,
        release: 'main',
        skipInstall: true,
      } as unknown as Command);
    });
    expect(logs.filter(Boolean)).toEqual([
      'Using default pattern glob @backstage/*',
      'Checking for updates of @backstage/core',
      'Checking for updates of @backstage/theme',
      'Checking for updates of @backstage/core-api',
      'Some packages are outdated, updating',
      'unlocking @backstage/core@^1.0.3 ~> 1.0.6',
      'unlocking @backstage/core-api@^1.0.6 ~> 1.0.7',
      'unlocking @backstage/core-api@^1.0.3 ~> 1.0.7',
      'bumping @backstage/core in a to ^1.0.6',
      'bumping @backstage/core in b to ^1.0.6',
      'bumping @backstage/theme in b to ^2.0.0',
      'Skipping yarn install',
      '⚠️  The following packages may have breaking changes:',
      '  @backstage/theme : 1.0.0 ~> 2.0.0',
      '    https://github.com/backstage/backstage/blob/master/packages/theme/CHANGELOG.md',
      'Version bump complete!',
    ]);

    expect(mockFetchPackageInfo).toHaveBeenCalledTimes(3);
    expect(mockFetchPackageInfo).toHaveBeenCalledWith('@backstage/core');
    expect(mockFetchPackageInfo).toHaveBeenCalledWith('@backstage/core-api');
    expect(mockFetchPackageInfo).toHaveBeenCalledWith('@backstage/theme');

    expect(runObj.run).not.toHaveBeenCalledWith(
      'yarn',
      ['install'],
      expect.any(Object),
    );

    const lockfileContents = await fs.readFile('/yarn.lock', 'utf8');
    expect(lockfileContents).toBe(lockfileMockResult);

    const packageA = await fs.readJson('/packages/a/package.json');
    expect(packageA).toEqual({
      name: 'a',
      dependencies: {
        '@backstage/core': '^1.0.6',
      },
    });
    const packageB = await fs.readJson('/packages/b/package.json');
    expect(packageB).toEqual({
      name: 'b',
      dependencies: {
        '@backstage/core': '^1.0.6',
        '@backstage/theme': '^2.0.0',
      },
    });
  });

  it('should prefer dependency versions from release manifest', async () => {
    mockFs({
      '/yarn.lock': lockfileMock,
      '/package.json': JSON.stringify({
        workspaces: {
          packages: ['packages/*'],
        },
      }),
      '/packages/a/package.json': JSON.stringify({
        name: 'a',
        dependencies: {
          '@backstage/core': '^1.0.5',
        },
      }),
      '/packages/b/package.json': JSON.stringify({
        name: 'b',
        dependencies: {
          '@backstage/core': '^1.0.3',
          '@backstage/theme': '^1.0.0',
        },
      }),
    });

    jest
      .spyOn(paths, 'resolveTargetRoot')
      .mockImplementation((...path) => resolvePath('/', ...path));
    jest.spyOn(runObj, 'run').mockResolvedValue(undefined);
    worker.use(
      rest.get(
        'https://versions.backstage.io/v1/tags/main/manifest.json',
        (_, res, ctx) =>
          res(
            ctx.status(200),
            ctx.json({
              releaseVersion: '0.0.1',
              packages: [
                {
                  name: '@backstage/theme',
                  version: '5.0.0',
                },
                {
                  name: '@backstage/create-app',
                  version: '3.0.0',
                },
              ],
            }),
          ),
      ),
    );
    const { log: logs } = await withLogCollector(['log'], async () => {
      await bump({ pattern: null, release: 'main' } as unknown as Command);
    });
    expect(logs.filter(Boolean)).toEqual([
      'Using default pattern glob @backstage/*',
      'Checking for updates of @backstage/core',
      'Checking for updates of @backstage/theme',
      'Checking for updates of @backstage/theme',
      'Checking for updates of @backstage/core-api',
      'Some packages are outdated, updating',
      'unlocking @backstage/core@^1.0.3 ~> 1.0.6',
      'unlocking @backstage/core-api@^1.0.6 ~> 1.0.7',
      'unlocking @backstage/core-api@^1.0.3 ~> 1.0.7',
      'bumping @backstage/theme in b to ^5.0.0',
      'bumping @backstage/core in b to ^1.0.6',
      'bumping @backstage/core in a to ^1.0.6',
      'Your project is now at version 0.0.1, which has been written to backstage.json',
      'Running yarn install to install new versions',
      '⚠️  The following packages may have breaking changes:',
      '  @backstage/theme : 1.0.0 ~> 5.0.0',
      '    https://github.com/backstage/backstage/blob/master/packages/theme/CHANGELOG.md',
      'Version bump complete!',
    ]);

    expect(mockFetchPackageInfo).toHaveBeenCalledTimes(2);
    expect(mockFetchPackageInfo).toHaveBeenCalledWith('@backstage/core');
    expect(mockFetchPackageInfo).not.toHaveBeenCalledWith('@backstage/theme');

    expect(runObj.run).toHaveBeenCalledTimes(1);
    expect(runObj.run).toHaveBeenCalledWith(
      'yarn',
      ['install'],
      expect.any(Object),
    );

    const lockfileContents = await fs.readFile('/yarn.lock', 'utf8');
    expect(lockfileContents).toBe(lockfileMockResult);

    const packageA = await fs.readJson('/packages/a/package.json');
    expect(packageA).toEqual({
      name: 'a',
      dependencies: {
        '@backstage/core': '^1.0.6',
      },
    });
    const packageB = await fs.readJson('/packages/b/package.json');
    expect(packageB).toEqual({
      name: 'b',
      dependencies: {
        '@backstage/core': '^1.0.6',
        '@backstage/theme': '^5.0.0',
      },
    });
  });

  it('should only bump packages in the manifest when a specific release is specified', async () => {
    mockFs({
      '/yarn.lock': lockfileMock,
      '/package.json': JSON.stringify({
        workspaces: {
          packages: ['packages/*'],
        },
      }),
      '/packages/a/package.json': JSON.stringify({
        name: 'a',
        dependencies: {
          '@backstage/core': '^1.0.5',
        },
      }),
      '/packages/b/package.json': JSON.stringify({
        name: 'b',
        dependencies: {
          '@backstage/core': '^1.0.3',
          '@backstage/theme': '^1.0.0',
        },
      }),
    });
    jest
      .spyOn(paths, 'resolveTargetRoot')
      .mockImplementation((...path) => resolvePath('/', ...path));

    jest.spyOn(runObj, 'run').mockResolvedValue(undefined);
    worker.use(
      rest.get(
        'https://versions.backstage.io/v1/releases/999.0.1/manifest.json',
        (_, res, ctx) => res(ctx.status(404), ctx.json({})),
      ),
    );
    const { log: logs } = await withLogCollector(['log'], async () => {
      await expect(
        bump({ pattern: null, release: '999.0.1' } as unknown as Command),
      ).rejects.toThrow('No release found for 999.0.1 version');
    });
    expect(logs.filter(Boolean)).toEqual([
      'Using default pattern glob @backstage/*',
    ]);

    expect(runObj.run).toHaveBeenCalledTimes(0);

    const packageA = await fs.readJson('/packages/a/package.json');
    expect(packageA).toEqual({
      name: 'a',
      dependencies: {
        '@backstage/core': '^1.0.5',
      },
    });
    const packageB = await fs.readJson('/packages/b/package.json');
    expect(packageB).toEqual({
      name: 'b',
      dependencies: {
        '@backstage/core': '^1.0.3',
        '@backstage/theme': '^1.0.0',
      },
    });
  });

  it('should prefer versions from the highest manifest version when main is not specified', async () => {
    mockFs({
      '/yarn.lock': lockfileMock,
      '/package.json': JSON.stringify({
        workspaces: {
          packages: ['packages/*'],
        },
      }),
      '/packages/a/package.json': JSON.stringify({
        name: 'a',
        dependencies: {
          '@backstage/core': '^1.0.5',
        },
      }),
      '/packages/b/package.json': JSON.stringify({
        name: 'b',
        dependencies: {
          '@backstage/core': '^1.0.3',
          '@backstage/theme': '^1.0.0',
        },
      }),
    });

    jest
      .spyOn(paths, 'resolveTargetRoot')
      .mockImplementation((...path) => resolvePath('/', ...path));
    jest.spyOn(runObj, 'run').mockResolvedValue(undefined);
    worker.use(
      rest.get(
        'https://versions.backstage.io/v1/tags/main/manifest.json',
        (_, res, ctx) =>
          res(
            ctx.status(200),
            ctx.json({
              releaseVersion: '1.0.0',
              packages: [
                {
                  name: '@backstage/theme',
                  version: '5.0.0',
                },
                {
                  name: '@backstage/create-app',
                  version: '3.0.0',
                },
              ],
            }),
          ),
      ),
      rest.get(
        'https://versions.backstage.io/v1/tags/next/manifest.json',
        (_, res, ctx) =>
          res(
            ctx.status(200),
            ctx.json({
              releaseVersion: '1.0.0-next.1',
              packages: [
                {
                  name: '@backstage/theme',
                  version: '4.0.0',
                },
                {
                  name: '@backstage/create-app',
                  version: '2.0.0',
                },
              ],
            }),
          ),
      ),
    );
    const { log: logs } = await withLogCollector(['log'], async () => {
      await bump({ pattern: null, release: 'next' } as unknown as Command);
    });
    expect(logs.filter(Boolean)).toEqual([
      'Using default pattern glob @backstage/*',
      'Checking for updates of @backstage/core',
      'Checking for updates of @backstage/theme',
      'Checking for updates of @backstage/theme',
      'Checking for updates of @backstage/core-api',
      'Some packages are outdated, updating',
      'unlocking @backstage/core@^1.0.3 ~> 1.0.6',
      'unlocking @backstage/core-api@^1.0.6 ~> 1.0.7',
      'unlocking @backstage/core-api@^1.0.3 ~> 1.0.7',
      'bumping @backstage/theme in b to ^5.0.0',
      'bumping @backstage/core in b to ^1.0.6',
      'bumping @backstage/core in a to ^1.0.6',
      'Your project is now at version 1.0.0, which has been written to backstage.json',
      'Running yarn install to install new versions',
      '⚠️  The following packages may have breaking changes:',
      '  @backstage/theme : 1.0.0 ~> 5.0.0',
      '    https://github.com/backstage/backstage/blob/master/packages/theme/CHANGELOG.md',
      'Version bump complete!',
    ]);
  });

  it('should bump backstage dependencies and dependencies matching pattern glob', async () => {
    const customLockfileMock = `${lockfileMock}
"@backstage-extra/custom@^1.1.0":
  version "1.1.0"

"@backstage-extra/custom@^1.0.1":
  version "1.0.1"

"@backstage-extra/custom-two@^1.0.0":
  version "1.0.0"
`;
    const customLockfileMockResult = `${HEADER}
"@backstage-extra/custom-two@^1.0.0":
  version "1.0.0"

"@backstage-extra/custom@^1.1.0":
  version "1.1.0"

"@backstage/core@^1.0.5":
  version "1.0.6"
  dependencies:
    "@backstage/core-api" "^1.0.6"

"@backstage/theme@^1.0.0":
  version "1.0.0"
`;
    mockFs({
      '/yarn.lock': customLockfileMock,
      '/package.json': JSON.stringify({
        workspaces: {
          packages: ['packages/*'],
        },
      }),
      '/packages/a/package.json': JSON.stringify({
        name: 'a',
        dependencies: {
          '@backstage/core': '^1.0.5',
          '@backstage-extra/custom': '^1.0.1',
          '@backstage-extra/custom-two': '^1.0.0',
        },
      }),
      '/packages/b/package.json': JSON.stringify({
        name: 'b',
        dependencies: {
          '@backstage/core': '^1.0.3',
          '@backstage/theme': '^1.0.0',
          '@backstage-extra/custom': '^1.1.0',
          '@backstage-extra/custom-two': '^1.0.0',
        },
      }),
    });

    jest
      .spyOn(paths, 'resolveTargetRoot')
      .mockImplementation((...path) => resolvePath('/', ...path));
    jest.spyOn(runObj, 'run').mockResolvedValue(undefined);
    worker.use(
      rest.get(
        'https://versions.backstage.io/v1/tags/main/manifest.json',
        (_, res, ctx) =>
          res(
            ctx.status(200),
            ctx.json({
              packages: [],
            }),
          ),
      ),
    );
    const { log: logs } = await withLogCollector(['log'], async () => {
      await bump({
        pattern: '@{backstage,backstage-extra}/*',
        release: 'main',
      } as any);
    });
    expect(logs.filter(Boolean)).toEqual([
      'Using custom pattern glob @{backstage,backstage-extra}/*',
      'Checking for updates of @backstage/core',
      'Checking for updates of @backstage-extra/custom',
      'Checking for updates of @backstage-extra/custom-two',
      'Checking for updates of @backstage/theme',
      'Checking for updates of @backstage/core-api',
      'Some packages are outdated, updating',
      'unlocking @backstage/core@^1.0.3 ~> 1.0.6',
      'unlocking @backstage-extra/custom@^1.0.1 ~> 1.1.0',
      'unlocking @backstage/core-api@^1.0.6 ~> 1.0.7',
      'unlocking @backstage/core-api@^1.0.3 ~> 1.0.7',
      'bumping @backstage/core in a to ^1.0.6',
      'bumping @backstage-extra/custom in a to ^1.1.0',
      'bumping @backstage-extra/custom-two in a to ^2.0.0',
      'bumping @backstage/core in b to ^1.0.6',
      'bumping @backstage-extra/custom in b to ^1.1.0',
      'bumping @backstage-extra/custom-two in b to ^2.0.0',
      'bumping @backstage/theme in b to ^2.0.0',
      'Skipping backstage.json update as custom pattern is used',
      'Running yarn install to install new versions',
      '⚠️  The following packages may have breaking changes:',
      '  @backstage-extra/custom-two : 1.0.0 ~> 2.0.0',
      '  @backstage/theme : 1.0.0 ~> 2.0.0',
      '    https://github.com/backstage/backstage/blob/master/packages/theme/CHANGELOG.md',
      'Version bump complete!',
    ]);

    expect(mockFetchPackageInfo).toHaveBeenCalledTimes(5);
    expect(mockFetchPackageInfo).toHaveBeenCalledWith('@backstage/core');
    expect(mockFetchPackageInfo).toHaveBeenCalledWith('@backstage/theme');

    expect(runObj.run).toHaveBeenCalledTimes(1);
    expect(runObj.run).toHaveBeenCalledWith(
      'yarn',
      ['install'],
      expect.any(Object),
    );

    const lockfileContents = await fs.readFile('/yarn.lock', 'utf8');
    expect(lockfileContents).toEqual(customLockfileMockResult);

    const packageA = await fs.readJson('/packages/a/package.json');
    expect(packageA).toEqual({
      name: 'a',
      dependencies: {
        '@backstage-extra/custom': '^1.1.0',
        '@backstage-extra/custom-two': '^2.0.0',
        '@backstage/core': '^1.0.6',
      },
    });
    const packageB = await fs.readJson('/packages/b/package.json');
    expect(packageB).toEqual({
      name: 'b',
      dependencies: {
        '@backstage-extra/custom': '^1.1.0',
        '@backstage-extra/custom-two': '^2.0.0',
        '@backstage/core': '^1.0.6',
        '@backstage/theme': '^2.0.0',
      },
    });
  });

  it('should ignore not found packages', async () => {
    mockFs({
      '/yarn.lock': lockfileMockResult,
      '/package.json': JSON.stringify({
        workspaces: {
          packages: ['packages/*'],
        },
      }),
      '/packages/a/package.json': JSON.stringify({
        name: 'a',
        dependencies: {
          '@backstage/core': '^1.0.5',
        },
      }),
      '/packages/b/package.json': JSON.stringify({
        name: 'b',
        dependencies: {
          '@backstage/core': '^1.0.3',
          '@backstage/theme': '^2.0.0',
        },
      }),
    });

    jest
      .spyOn(paths, 'resolveTargetRoot')
      .mockImplementation((...path) => resolvePath('/', ...path));
    mockFetchPackageInfo.mockRejectedValue(new NotFoundError('Nope'));
    jest.spyOn(runObj, 'run').mockResolvedValue(undefined);
    worker.use(
      rest.get(
        'https://versions.backstage.io/v1/tags/main/manifest.json',
        (_, res, ctx) =>
          res(
            ctx.status(200),
            ctx.json({
              packages: [],
            }),
          ),
      ),
    );
    const { log: logs } = await withLogCollector(['log'], async () => {
      await bump({ pattern: null, release: 'main' } as unknown as Command);
    });
    expect(logs.filter(Boolean)).toEqual([
      'Using default pattern glob @backstage/*',
      'Checking for updates of @backstage/core',
      'Checking for updates of @backstage/theme',
      'Package info not found, ignoring package @backstage/core',
      'Package info not found, ignoring package @backstage/theme',
      'Checking for updates of @backstage/core',
      'Checking for updates of @backstage/theme',
      'Package info not found, ignoring package @backstage/core',
      'Package info not found, ignoring package @backstage/theme',
      'All Backstage packages are up to date!',
    ]);

    expect(runObj.run).toHaveBeenCalledTimes(0);

    const lockfileContents = await fs.readFile('/yarn.lock', 'utf8');
    expect(lockfileContents).toBe(lockfileMockResult);

    const packageA = await fs.readJson('/packages/a/package.json');
    expect(packageA).toEqual({
      name: 'a',
      dependencies: {
        '@backstage/core': '^1.0.5', // not bumped
      },
    });
    const packageB = await fs.readJson('/packages/b/package.json');
    expect(packageB).toEqual({
      name: 'b',
      dependencies: {
        '@backstage/core': '^1.0.3', // not bumped
        '@backstage/theme': '^2.0.0', // not bumped
      },
    });
  });

  it('should log duplicates', async () => {
    jest.spyOn(Lockfile.prototype, 'analyze').mockReturnValue({
      invalidRanges: [],
      newVersions: [],
      newRanges: [
        {
          name: 'first-duplicate',
          oldRange: 'first-duplicate',
          newRange: 'first-duplicate',
          oldVersion: '1.0.0',
          newVersion: '2.0.0',
        },
        {
          name: 'second-duplicate',
          oldRange: 'second-duplicate',
          newRange: 'second-duplicate',
          oldVersion: '1.0.0',
          newVersion: '2.0.0',
        },
        {
          name: 'third-duplicate',
          oldRange: 'third-duplicate',
          newRange: 'third-duplicate',
          oldVersion: '1.0.0',
          newVersion: '2.0.0',
        },
      ],
    });
    mockFs({
      '/yarn.lock': lockfileMock,
      '/package.json': JSON.stringify({
        workspaces: {
          packages: ['packages/*'],
        },
      }),
      '/packages/a/package.json': JSON.stringify({
        name: 'a',
        dependencies: {
          '@backstage/core': '^1.0.5',
        },
      }),
      '/packages/b/package.json': JSON.stringify({
        name: 'b',
        dependencies: {
          '@backstage/core': '^1.0.3',
          '@backstage/theme': '^1.0.0',
        },
      }),
    });

    jest
      .spyOn(paths, 'resolveTargetRoot')
      .mockImplementation((...path) => resolvePath('/', ...path));
    jest.spyOn(runObj, 'run').mockResolvedValue(undefined);
    worker.use(
      rest.get(
        'https://versions.backstage.io/v1/tags/main/manifest.json',
        (_, res, ctx) =>
          res(
            ctx.status(200),
            ctx.json({
              packages: [],
            }),
          ),
      ),
    );
    const { log: logs } = await withLogCollector(['log'], async () => {
      await bump({ pattern: null, release: 'main' } as unknown as Command);
    });
    expect(logs.filter(Boolean)).toEqual([
      'Using default pattern glob @backstage/*',
      'Checking for updates of @backstage/core',
      'Checking for updates of @backstage/theme',
      'Checking for updates of @backstage/core-api',
      'Some packages are outdated, updating',
      'unlocking @backstage/core@^1.0.3 ~> 1.0.6',
      'unlocking @backstage/core-api@^1.0.6 ~> 1.0.7',
      'unlocking @backstage/core-api@^1.0.3 ~> 1.0.7',
      'bumping @backstage/core in a to ^1.0.6',
      'bumping @backstage/core in b to ^1.0.6',
      'bumping @backstage/theme in b to ^2.0.0',
      'Running yarn install to install new versions',
      '⚠️  The following packages may have breaking changes:',
      '  @backstage/theme : 1.0.0 ~> 2.0.0',
      '    https://github.com/backstage/backstage/blob/master/packages/theme/CHANGELOG.md',
      'Version bump complete!',
      'The following packages have duplicates but have been allowed:',
      'first-duplicate, second-duplicate, third-duplicate',
    ]);
  });
});

describe('bumpBackstageJsonVersion', () => {
  afterEach(() => {
    mockFs.restore();
    jest.resetAllMocks();
  });

  it('should bump version in backstage.json', async () => {
    mockFs({
      '/backstage.json': JSON.stringify({ version: '0.0.1' }),
    });
    paths.targetDir = '/';
    jest
      .spyOn(paths, 'resolveTargetRoot')
      .mockImplementation((...path) => resolvePath('/', ...path));

    const { log } = await withLogCollector(async () => {
      await bumpBackstageJsonVersion('1.4.1');
    });
    expect(await fs.readJson('/backstage.json')).toEqual({ version: '1.4.1' });
    expect(log).toEqual([
      'Upgraded from release 0.0.1 to 1.4.1, please review these template changes:',
      undefined,
      '  https://backstage.github.io/upgrade-helper/?from=0.0.1&to=1.4.1',
      undefined,
    ]);
  });

  it("should create backstage.json if doesn't exist", async () => {
    mockFs({});
    paths.targetDir = '/';
    const latest = '1.4.1';
    jest
      .spyOn(paths, 'resolveTargetRoot')
      .mockImplementation((...path) => resolvePath('/', ...path));

    const { log } = await withLogCollector(async () => {
      await bumpBackstageJsonVersion(latest);
    });
    expect(await fs.readJson('/backstage.json')).toEqual({ version: latest });
    expect(log).toEqual([
      'Your project is now at version 1.4.1, which has been written to backstage.json',
    ]);
  });
});

describe('createVersionFinder', () => {
  async function findVersion(tag: string, data: Partial<YarnInfoInspectData>) {
    const fetcher = () =>
      Promise.resolve({
        name: '@backstage/core',
        'dist-tags': {},
        versions: [],
        time: {},
        ...data,
      });

    const versionFinder = createVersionFinder({
      releaseLine: tag,
      packageInfoFetcher: fetcher,
    });
    let result;
    await withLogCollector(async () => {
      result = await versionFinder('@backstage/core');
    });
    return result;
  }

  it('should create version finder', async () => {
    await expect(
      findVersion('latest', {
        time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
        'dist-tags': { latest: '1.0.0' },
      }),
    ).resolves.toBe('1.0.0');

    await expect(
      findVersion('main', {
        time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
        'dist-tags': { latest: '1.0.0' },
      }),
    ).resolves.toBe('1.0.0');

    await expect(
      findVersion('next', {
        time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
        'dist-tags': { latest: '1.0.0' },
      }),
    ).resolves.toBe('1.0.0');

    await expect(
      findVersion('next', {
        time: {
          '1.0.0': '2020-01-01T00:00:00.000Z',
          '0.9.0': '2010-01-01T00:00:00.000Z',
        },
        'dist-tags': { latest: '1.0.0', next: '0.9.0' },
      }),
    ).resolves.toBe('1.0.0');

    await expect(
      findVersion('next', {
        time: {
          '1.0.0': '2020-01-01T00:00:00.000Z',
          '0.9.0': '2020-02-01T00:00:00.000Z',
        },
        'dist-tags': { latest: '1.0.0', next: '0.9.0' },
      }),
    ).resolves.toBe('0.9.0');

    await expect(findVersion('next', {})).rejects.toThrow(
      "No target 'latest' version found for @backstage/core",
    );

    await expect(
      findVersion('next', {
        time: {
          '0.9.0': '2020-02-01T00:00:00.000Z',
        },
        'dist-tags': { latest: '1.0.0', next: '0.9.0' },
      }),
    ).rejects.toThrow(
      "No time available for version '1.0.0' of @backstage/core",
    );

    await expect(
      findVersion('next', {
        time: {
          '1.0.0': '2020-01-01T00:00:00.000Z',
        },
        'dist-tags': { latest: '1.0.0', next: '0.9.0' },
      }),
    ).rejects.toThrow(
      "No time available for version '0.9.0' of @backstage/core",
    );
  });
});
