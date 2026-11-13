// Rasterizes icon.svg into the PNG sizes Chrome needs, using Playwright's Chromium.
// Run from this folder after editing icon.svg: npm i --no-save playwright && node icons/generate-icons.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(dir, 'icon.svg'), 'utf8');
const browser = await chromium.launch();
for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<!doctype html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`);
    await page.screenshot({ path: join(dir, `icon-${size}.png`), omitBackground: true });
    await page.close();
}
await browser.close();
console.log('Generated icon-16/32/48/128.png');
