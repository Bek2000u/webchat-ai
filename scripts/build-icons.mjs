import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

// Optional asset-generation task. Normal builds use the committed assets.
// Point PLAYWRIGHT_BROWSERS_PATH at your checkout's test-browser directory.
const svg = await readFile(new URL("../resources/icon.svg", import.meta.url), "utf8");
const root = new URL("../", import.meta.url);
const browser = await chromium.launch({ headless: true });
const pngs = new Map();
try {
  const page = await browser.newPage();
  await page.route("**/*", route => route.abort());
  for (const size of [16, 24, 32, 48, 64, 128, 180, 256, 512]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
    const png = await page.screenshot({ omitBackground: true });
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    pngs.set(size, png);
  }
} finally { await browser.close(); }

function ico(sizes) {
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (const [i, size] of sizes.entries()) {
    const png = pngs.get(size), at = 6 + 16 * i;
    header[at] = header[at + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  }
  return Buffer.concat([header, ...sizes.map(size => pngs.get(size))]);
}
await writeFile(new URL("resources/icon.png", root), pngs.get(512));
await writeFile(new URL("resources/icon.ico", root), ico([16, 24, 32, 48, 64, 128, 256]));
for (const size of [16, 32, 48, 128])
  await writeFile(new URL(`src/extension/icons/icon-${size}.png`, root), pngs.get(size));
await writeFile(new URL("src/web/public/webchat-ai.svg", root), svg);
await writeFile(new URL("src/web/public/webchat-ai.png", root), pngs.get(128));
await writeFile(new URL("src/web/public/apple-touch-icon.png", root), pngs.get(180));
await writeFile(new URL("src/web/public/favicon.ico", root), ico([16, 32, 48]));
console.log("Generated Desktop/installer, extension and web icons from resources/icon.svg");
