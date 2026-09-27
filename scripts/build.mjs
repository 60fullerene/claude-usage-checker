// Builds the downloadable files in dist/:
//   claude-usage.mcpb              Claude Desktop extension (packed and validated by the official mcpb tool)
//   usage-bridge-for-claude.zip    browser extension (unzip, then "Load unpacked")
//   claude-usage-skill.zip         optional skill for Claude
// Usage: node scripts/build.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { listFiles, writeZip } from './zip.mjs';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const DIST = path.join(ROOT, 'dist');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const versions = {
  'desktop-extension/manifest.json': JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop-extension/manifest.json'))).version,
  'desktop-extension/package.json': JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop-extension/package.json'))).version,
  'browser-extension/manifest.json': JSON.parse(fs.readFileSync(path.join(ROOT, 'browser-extension/manifest.json'))).version,
};
if (new Set(Object.values(versions)).size !== 1) throw new Error(`version mismatch: ${JSON.stringify(versions)}`);

fs.mkdirSync(DIST, { recursive: true });

const mcpb = path.join(DIST, 'claude-usage.mcpb');
fs.rmSync(mcpb, { force: true });
execFileSync(npx, ['-y', '@anthropic-ai/mcpb@2', 'pack', path.join(ROOT, 'desktop-extension'), mcpb], { stdio: 'inherit' });

const zip = (source, target, exclude) => {
  const dir = path.join(ROOT, source);
  const files = listFiles(dir, exclude).map((rel) => [`${path.basename(source)}/${rel}`, path.join(dir, rel)]);
  writeZip(path.join(DIST, target), files);
  console.log(`wrote dist/${target} (${files.length} files)`);
};
zip('browser-extension', 'usage-bridge-for-claude.zip', (rel) => rel.startsWith('.'));
zip('skills/claude-usage', 'claude-usage-skill.zip', (rel) => rel.startsWith('.'));
