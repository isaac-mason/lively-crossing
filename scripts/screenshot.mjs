/**
 * Drive the running dev app in real Chrome and screenshot it.
 *
 * Spark renders Gaussian splats through WebGL2, so we drive the *system* Chrome
 * headed (playwright-core, channel 'chrome') rather than headless Chromium /
 * SwiftShader — those don't render splats faithfully.
 *
 * Opens the debug panel (backtick) and ticks the wireframe checkboxes so the
 * physics collider + navmesh overlay the splat, which is how we eyeball whether
 * the voxel-baked collider lines up with the rendered scene.
 *
 * Usage (dev server must already be running):
 *   pnpm dev &                      # or in another terminal
 *   node scripts/screenshot.mjs [url] [out.png]
 *
 * Env:
 *   URL   dev server URL   (default http://localhost:5173)
 *   OUT   output png path  (default screenshot.png)
 *   WIRE  '0' to skip the debug wireframes and just shoot the splat
 */
import { chromium } from 'playwright-core';

const URL = process.argv[2] ?? process.env.URL ?? 'http://localhost:5173';
const OUT = process.argv[3] ?? process.env.OUT ?? 'screenshot.png';
const WIRE = process.env.WIRE !== '0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
    channel: 'chrome', // use the installed Google Chrome, not bundled Chromium
    headless: false, // real GPU/WebGL2 for Spark
    args: [
        // Playwright's fresh profile otherwise tends to fall back to software GL
        // and OOM-crash the GPU process under the full 4.3M-splat load.
        '--ignore-gpu-blocklist',
        '--enable-gpu-rasterization',
        // Give the GPU process a big memory budget so it doesn't evict/crash
        // under the full 4.3M-splat residency.
        '--force-gpu-mem-available-mb=8192',
        '--disable-gpu-process-crash-limit',
    ],
});

// Screenshot helper that never throws (the GPU process can crash under a 4M+
// splat load, closing the page). We grab a shot as early as possible so a later
// crash still leaves us something to look at.
const shoot = async (page, path) => {
    if (page.isClosed()) {
        console.log(`page closed — cannot shoot ${path}`);
        return false;
    }
    try {
        await page.screenshot({ path });
        console.log(`wrote ${path}`);
        return true;
    } catch (e) {
        console.log(`screenshot ${path} failed: ${e.message}`);
        return false;
    }
};

try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('console', (m) => console.log(`[page:${m.type()}]`, m.text()));
    page.on('pageerror', (e) => console.log('[page:error]', e.message));
    page.on('crash', () => console.log('[page:crash] render process crashed'));
    page.on('close', () => console.log('[page:close] page closed'));
    browser.on('disconnected', () => console.log('[browser:disconnected]'));

    console.log(`opening ${URL}`);
    await page.goto(URL, { waitUntil: 'load', timeout: 60_000 }).catch((e) => console.log(`goto: ${e.message}`));

    // The loading overlay covers the canvas until ~80% of splats are resident —
    // the same moment the GPU process tends to crash. Force it away now so the
    // splat (as it streams) is visible underneath.
    await page.evaluate(() => document.getElementById('loading')?.remove()).catch(() => {});

    if (WIRE) {
        // The debug panel + collider/navmesh wireframes are built synchronously
        // on load, so toggle them early (well before the full-load crash).
        await page.keyboard.press('Backquote').catch(() => {});
        await sleep(200);
        // Drop the LOD slider to its minimum so far fewer splats stay resident —
        // keeps the GPU process under the load that crashes it at full res.
        await page
            .evaluate(() => {
                const r = document.querySelector('input[type=range]');
                if (r) {
                    r.value = r.min;
                    r.dispatchEvent(new Event('input', { bubbles: true }));
                }
            })
            .catch(() => {});
        // Skip 'orbit camera' (its early toggle sends the camera to NaN); the
        // first-person view already frames the scene around the spawn point.
        for (const label of ['physics debug', 'navmesh debug']) {
            await page
                .getByText(label, { exact: true })
                .click({ timeout: 4000 })
                .catch(() => console.log(`could not click "${label}"`));
        }
    }

    // Poll-screenshot and keep the most recent good frame; if the GPU crashes at
    // full load, the last pre-crash frame still shows splat + wireframes.
    let shot = false;
    for (let i = 0; i < 16 && !page.isClosed(); i++) {
        await sleep(700);
        if (await shoot(page, OUT)) shot = true;
    }
    if (!shot) console.log('never captured a frame before the page closed');
} finally {
    await browser.close();
}
