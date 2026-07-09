/**
 * Decoder-free glTF optimization pass for the character GLBs.
 *
 * dedup + weld + prune trim redundant data, resample() compresses the animation
 * sampling (the big win — 11 clips per file), and quantize() shrinks the geometry
 * via KHR_mesh_quantization, which three.js loads natively (no runtime decoder).
 * Rewrites each GLB in place.
 *
 * Usage: pnpm assets:optimize [dir]   (default: public/characters)
 */
import { statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, quantize, resample, weld } from '@gltf-transform/functions';

const dir = process.argv[2] ?? 'public/characters';
// Register extensions so quantize()'s KHR_mesh_quantization (three.js-native, no
// runtime decoder) and any source material extensions are actually written.
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

const files = (await readdir(dir)).filter((f) => f.endsWith('.glb'));
let before = 0;
let after = 0;

for (const file of files) {
    const path = join(dir, file);
    const b = statSync(path).size;
    const doc = await io.read(path);
    await doc.transform(
        dedup(),
        weld(),
        resample(), // compress animation keyframes (lossless within tolerance)
        prune(),
        quantize(), // KHR_mesh_quantization — halves geometry, native in three.js
    );
    await io.write(path, doc);
    const a = statSync(path).size;
    before += b;
    after += a;
    console.log(`  ${file.padEnd(28)} ${(b / 1024) | 0}KB -> ${(a / 1024) | 0}KB`);
}

console.log(
    `total ${(before / 1048576).toFixed(2)}MB -> ${(after / 1048576).toFixed(2)}MB` +
        `  (${(100 * (1 - after / before)) | 0}% smaller)`,
);
