import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

// Import in tests that start an office, worker manager or login-shell probe.
// Each test file runs in its own process, including when invoked directly.
const dir = mkdtempSync(path.join(tmpdir(), 'office-test-zdotdir-'));
process.env.ZDOTDIR = dir;
if (process.platform === 'darwin') process.env.SHELL = '/bin/zsh'; // bash -l ignores ZDOTDIR.
// A closing login shell can still be writing its session files.
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
