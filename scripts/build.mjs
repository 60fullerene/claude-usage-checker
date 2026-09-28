// Builds what users download, in dist/:
//   claude-usage-checker.zip     everything, in one "claude-usage-checker" folder:
//     取扱説明書.pdf               the manual (docs/manual/manual.html)
//     claude-usage.mcpb           Claude Desktop extension (packed and validated by the official mcpb tool)
//     usage-bridge-for-claude/    browser extension, for "Load unpacked"
//     claude-usage-skill.zip      optional skill for Claude
//   manual.pdf                   the same manual, to read before downloading
// Rendering the manual needs Playwright with Chromium.
// Usage: node scripts/build.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderManual } from './build-manual.mjs';
import { listFiles, writeZip } from './zip.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const FOLDER = 'claude-usage-checker';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const versions = {
  'desktop-extension/manifest.json': JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop-extension/manifest.json'))).version,
  'desktop-extension/package.json': JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop-extension/package.json'))).version,
  'browser-extension/manifest.json': JSON.parse(fs.readFileSync(path.join(ROOT, 'browser-extension/manifest.json'))).version,
};
if (new Set(Object.values(versions)).size !== 1) throw new Error(`version mismatch: ${JSON.stringify(versions)}`);
const version = versions['desktop-extension/manifest.json'];

/** Files under `source` as [archive path under `folder`, file on disk], skipping dotfiles. */
const tree = (source, folder) => {
  const dir = path.join(ROOT, source);
  return listFiles(dir, (rel) => path.posix.basename(rel).startsWith('.')).map((rel) => [`${folder}/${rel}`, path.join(dir, rel)]);
};

// Build everything aside first, so a failed build leaves dist/ as it was.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-build-'));
try {
  const mcpb = path.join(work, 'claude-usage.mcpb');
  execFileSync(npx, ['-y', '@anthropic-ai/mcpb@2', 'pack', path.join(ROOT, 'desktop-extension'), mcpb], { stdio: 'inherit' });

  const manual = path.join(work, 'manual.pdf');
  await renderManual(manual, version);

  // Claude's skill upload takes a zip with the skill's folder inside.
  const skill = path.join(work, 'claude-usage-skill.zip');
  writeZip(skill, tree('skills/claude-usage', 'claude-usage'));

  const files = [
    [`${FOLDER}/取扱説明書.pdf`, manual],
    [`${FOLDER}/claude-usage.mcpb`, mcpb],
    ...tree('browser-extension', `${FOLDER}/usage-bridge-for-claude`),
    [`${FOLDER}/claude-usage-skill.zip`, skill],
  ];
  fs.rmSync(DIST, { recursive: true, force: true });
  writeZip(path.join(DIST, `${FOLDER}.zip`), files);
  fs.copyFileSync(manual, path.join(DIST, 'manual.pdf'));
  console.log(`wrote dist/${FOLDER}.zip (${files.length} files) and dist/manual.pdf for version ${version}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
