import { readFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRequirements, darwinMajor, type Machine, MIN_DARWIN, MIN_MACOS } from '../src/desktop/requirements.js';
import { formatStartupFailure, nativeModuleFailure, sharedTextureFailure } from '../src/desktop/startup-failure.js';

const GOOD: Machine = { platform: 'darwin', arch: 'arm64', release: '25.0.0' };
const on = (changes: Partial<Machine>): Machine => ({ ...GOOD, ...changes });

test('darwinMajor reads the kernel major version', () => {
  assert.equal(darwinMajor('23.6.0'), 23);
  assert.equal(darwinMajor('25.0.0'), 25);
  assert.equal(darwinMajor('nonsense'), undefined);
  assert.equal(darwinMajor(''), undefined);
});

test('macOS 14 is Darwin 23', () => {
  assert.equal(MIN_MACOS, 14);
  assert.equal(MIN_DARWIN, 23);
});

test('an Apple silicon Mac on macOS 14 and later passes', () => {
  for (const release of ['23.0.0', '24.1.0', '25.0.0', '27.2.0']) assert.equal(checkRequirements(on({ release })), undefined, release);
});

test('Intel Macs are refused by architecture', () => {
  const failure = checkRequirements(on({ arch: 'x64' }));
  assert.equal(failure?.kind, 'chip');
  assert.match(failure?.detail ?? '', /x64/);
});

test('macOS before 14 is refused before the chip is looked at', () => {
  const failure = checkRequirements(on({ release: '22.6.0', arch: 'x64' }));
  assert.equal(failure?.kind, 'macos');
  assert.match(failure?.title ?? '', /macOS 14 or later/);
  assert.equal(checkRequirements(on({ release: '' }))?.kind, 'macos');
});

test('another platform is refused', () => {
  assert.equal(checkRequirements(on({ platform: 'linux' }))?.kind, 'platform');
});

test('startup failures for the native module and the shared texture name the cause', () => {
  const module = nativeModuleFailure(new Error('dlopen failed: code signature invalid'));
  assert.equal(module.kind, 'native-module');
  assert.ok(module.detail.includes('dlopen failed: code signature invalid'));
  const texture = sharedTextureFailure('no frame in 5000 ms');
  assert.equal(texture.kind, 'shared-texture');
  assert.ok(texture.detail.includes('no frame in 5000 ms'));
  assert.equal(nativeModuleFailure('plain string').detail.endsWith('plain string'), true);
  assert.match(formatStartupFailure(texture), /^Droid Office couldn't get frames from the GPU\n\n/);
});

test('the presenter is looked for where electron-builder ships it', async () => {
  const { presenterModulePath, PRESENTER_MODULE } = await import('../src/desktop/native.js');
  assert.equal(presenterModulePath('/Applications/Droid Office.app/Contents/Resources/app'), '/Applications/Droid Office.app/Contents/Resources/app/native/presenter/build/Release/presenter.node');
  const builder = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
  assert.ok(builder.includes(`- ${PRESENTER_MODULE.split(path.sep).join('/')}`), 'electron-builder.yml must list the presenter in files');
  assert.match(builder, /minimumSystemVersion: '14\.0'/);
});
