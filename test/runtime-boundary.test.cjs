const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const source = readFileSync(join(process.cwd(), 'src', 'utils', 'capture.ts'), 'utf8');
assert.doesNotMatch(source, /desktopcommander\.app|telemetry\.desktopcommander|dc-telemetry-proxy/);
assert.doesNotMatch(readFileSync(join(process.cwd(), 'src', 'utils', 'feature-flags.ts'), 'utf8'), /https?:\/\//);
