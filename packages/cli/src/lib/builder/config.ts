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

import { BackstagePackageJson } from '@backstage/cli-node';

import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import yaml from '@rollup/plugin-yaml';
import svgr from '@svgr/rollup';
import chalk from 'chalk';
import fs from 'fs-extra';
import { OutputOptions, RollupOptions, RollupWarning } from 'rollup';
import dts from 'rollup-plugin-dts';
import esbuild from 'rollup-plugin-esbuild';
import postcss from 'rollup-plugin-postcss';

import { relative as relativePath, resolve as resolvePath } from 'path';

import { readEntryPoints } from '../entryPoints';
import { paths } from '../paths';
import { svgrTemplate } from '../svgrTemplate';
import { forwardFileImports } from './plugins';
import { BuildOptions, Output } from './types';

const SCRIPT_EXTS = ['.js', '.jsx', '.ts', '.tsx'];

function isFileImport(source: string) {
  if (source.startsWith('.')) {
    return true;
  }
  if (source.startsWith('/')) {
    return true;
  }
  if (source.match(/[a-z]:/i)) {
    return true;
  }
  return false;
}

export async function makeRollupConfigs(
  options: BuildOptions,
): Promise<RollupOptions[]> {
  const configs = new Array<RollupOptions>();
  const targetDir = options.targetDir ?? paths.targetDir;

  let targetPkg = options.packageJson;
  if (!targetPkg) {
    const packagePath = resolvePath(targetDir, 'package.json');
    targetPkg = (await fs.readJson(packagePath)) as BackstagePackageJson;
  }

  const onwarn = ({ code, message }: RollupWarning) => {
    if (code === 'EMPTY_BUNDLE') {
      return; // We don't care about this one
    }
    if (options.logPrefix) {
      console.log(options.logPrefix + message);
    } else {
      console.log(message);
    }
  };

  const distDir = resolvePath(targetDir, 'dist');
  const entryPoints = readEntryPoints(targetPkg);

  const scriptEntryPoints = entryPoints.filter(e =>
    SCRIPT_EXTS.includes(e.ext),
  );

  if (options.outputs.has(Output.cjs) || options.outputs.has(Output.esm)) {
    const output = new Array<OutputOptions>();
    const mainFields = ['module', 'main'];

    if (options.outputs.has(Output.cjs)) {
      output.push({
        dir: distDir,
        entryFileNames: `[name].cjs.js`,
        chunkFileNames: `cjs/[name]-[hash].cjs.js`,
        format: 'commonjs',
        sourcemap: true,
      });
    }
    if (options.outputs.has(Output.esm)) {
      output.push({
        dir: distDir,
        entryFileNames: `[name].esm.js`,
        chunkFileNames: `esm/[name]-[hash].esm.js`,
        format: 'module',
        sourcemap: true,
      });
      // Assume we're building for the browser if ESM output is included
      mainFields.unshift('browser');
    }

    configs.push({
      input: Object.fromEntries(
        scriptEntryPoints.map(e => [e.name, resolvePath(targetDir, e.path)]),
      ),
      output,
      onwarn,
      preserveEntrySignatures: 'strict',
      // All module imports are always marked as external
      external: (source, importer, isResolved) =>
        Boolean(importer && !isResolved && !isFileImport(source)),
      plugins: [
        resolve({ mainFields }),
        commonjs({
          include: /node_modules/,
          exclude: [/\/[^/]+\.(?:stories|test)\.[^/]+$/],
        }),
        postcss(),
        forwardFileImports({
          exclude: /\.icon\.svg$/,
          include: [
            /\.svg$/,
            /\.png$/,
            /\.gif$/,
            /\.jpg$/,
            /\.jpeg$/,
            /\.eot$/,
            /\.woff$/,
            /\.woff2$/,
            /\.ttf$/,
            /\.md$/,
          ],
        }),
        json(),
        yaml(),
        svgr({
          include: /\.icon\.svg$/,
          template: svgrTemplate,
        }),
        esbuild({
          target: 'es2019',
          minify: options.minify,
        }),
      ],
    });
  }

  if (options.outputs.has(Output.types) && !options.useApiExtractor) {
    const input = Object.fromEntries(
      scriptEntryPoints.map(e => [
        e.name,
        paths.resolveTargetRoot(
          'dist-types',
          relativePath(paths.targetRoot, targetDir),
          e.path.replace(/\.(?:ts|tsx)$/, '.d.ts'),
        ),
      ]),
    );

    for (const path of Object.values(input)) {
      const declarationsExist = await fs.pathExists(path);
      if (!declarationsExist) {
        const declarationPath = relativePath(targetDir, path);
        throw new Error(
          `No declaration files found at ${declarationPath}, be sure to run ${chalk.bgRed.white(
            'yarn tsc',
          )} to generate .d.ts files before packaging`,
        );
      }
    }

    configs.push({
      input,
      output: {
        dir: distDir,
        entryFileNames: `[name].d.ts`,
        chunkFileNames: `types/[name]-[hash].d.ts`,
        format: 'es',
      },
      external: [
        /\.css$/,
        /\.scss$/,
        /\.sass$/,
        /\.svg$/,
        /\.eot$/,
        /\.woff$/,
        /\.woff2$/,
        /\.ttf$/,
      ],
      onwarn,
      plugins: [dts()],
    });
  }

  return configs;
}
