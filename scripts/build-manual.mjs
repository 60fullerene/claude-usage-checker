// Renders the manual (docs/manual/manual.html) to an A4 PDF with Playwright's Chromium.
// Used by build.mjs; on its own: node scripts/build-manual.mjs out.pdf [version]

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MANUAL = path.join(ROOT, 'docs', 'manual', 'manual.html');
const FONTS = "'BIZ UDPGothic', 'Hiragino Sans', 'Yu Gothic', Meiryo, 'Noto Sans JP', sans-serif"; // as in manual.html

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const paths of [undefined, [execSync('npm root -g').toString().trim()]]) {
    try {
      return require(require.resolve('playwright', paths && { paths }));
    } catch {
      // try the next location
    }
  }
  throw new Error('Rendering the manual needs Playwright: npm i --no-save playwright && npx playwright install chromium');
}

const footer = (version) => `
  <div style="box-sizing: border-box; width: 100%; padding: 0 16mm; display: flex; justify-content: space-between;
              font-family: ${FONTS}; font-size: 7.5pt; color: #5b6770;">
    <span>Claude Usage 取扱説明書 ${version}</span>
    <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
  </div>`;

export async function renderManual(target, version) {
  const browser = await loadPlaywright().chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(MANUAL).href);
    await page.evaluate(async (version) => {
      for (const node of document.querySelectorAll('[data-version]')) node.textContent = version;
      await document.fonts.ready;
    }, version);
    await page.pdf({
      path: target,
      format: 'A4',
      margin: { top: '15mm', bottom: '17mm', left: '16mm', right: '16mm' },
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: footer(version),
      outline: true, // bookmarks for the chapters
      tagged: true,
    });
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [target, version = 'dev'] = process.argv.slice(2);
  if (!target) throw new Error('usage: node scripts/build-manual.mjs out.pdf [version]');
  await renderManual(path.resolve(target), version);
  console.log(`wrote ${target}`);
}
