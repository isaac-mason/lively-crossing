/**
 * Generate a collision-mesh GLB straight from a Gaussian splat.
 *
 * Wraps PlayCanvas splat-transform: it GPU-voxelizes the .spz and extracts a
 * triangle collision mesh (marching cubes by default). This is the *upstream*
 * step that produces a .glb — feed that .glb into `pnpm build:collider` to pack
 * it into public/collider.bin when you're ready.
 *
 * Just voxelize -> collider. No exterior/floor fill, no carve, no navmesh.
 *
 * Outputs use a distinct base name so they never clobber the hand-authored
 * assets/colliders.glb or public/collider.bin:
 *
 *   <base>.voxel.json + <base>.voxel.bin   sparse voxel octree (intermediate)
 *   <base>.collision.glb                   the triangle collision mesh
 *
 * Usage:
 *   pnpm splat:collider-glb [input.spz] [output-base] [voxelSize] [smooth|faces]
 *   pnpm splat:collider-glb
 *     # public/anime-city.spz -> assets/anime-city.collision.glb (1.0m voxels)
 *
 * Requires a WebGPU-capable machine (voxelization runs on the GPU via Dawn).
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);

const INPUT = process.argv[2] ?? 'public/anime-city.spz';
// Base path (no extension). splat-transform derives the .voxel.bin and
// .collision.glb names from the .voxel.json output path.
const OUTPUT_BASE = process.argv[3] ?? 'assets/anime-city';
// World units per voxel. Smaller = finer mesh but exponentially more triangles;
// splat-transform's own 0.05 default produces >16.7M blocks on a city-scale
// scene and overflows a JS Set. 1.0 keeps the mesh manageable (~1M tris here);
// drop it for thinner walls/finer detail, raise it for a lighter collider.
const VOXEL_SIZE = process.argv[4] ?? '1.0';
const OPACITY = '0.1'; // opacity threshold for a solid voxel
const SHAPE = process.argv[5] ?? 'smooth'; // 'smooth' (marching cubes) | 'faces' (watertight blocky)

const voxelJson = `${OUTPUT_BASE}.voxel.json`;
const glb = `${OUTPUT_BASE}.collision.glb`;

// Resolve the splat-transform CLI entry (bin/cli.mjs) without depending on PATH.
// The package's `exports` hides package.json, so resolve the main entry
// (<root>/dist/index.*) and walk up to the package root.
function resolveCli(): string {
    const main = require.resolve('@playcanvas/splat-transform');
    const root = resolve(dirname(main), '..');
    return resolve(root, 'bin/cli.mjs');
}

async function main() {
    const args = [
        resolveCli(),
        '--voxel-params',
        `${VOXEL_SIZE},${OPACITY}`,
        '--collision-mesh',
        SHAPE,
        // Only ever overwrites our own generated <base>.* files, never the
        // hand-authored colliders.glb / collider.bin.
        '--overwrite',
        resolve(INPUT),
        resolve(voxelJson),
    ];

    console.log(`splat-transform ${args.slice(1).join(' ')}\n`);

    const code = await new Promise<number>((res, rej) => {
        const child = spawn(process.execPath, args, { stdio: 'inherit' });
        child.on('error', rej);
        child.on('close', (c) => res(c ?? 0));
    });

    if (code !== 0) {
        throw new Error(`splat-transform exited with code ${code}`);
    }

    console.log(`\nWrote ${glb}`);
    console.log(`  (+ ${voxelJson} and .voxel.bin — the intermediate octree)`);
    console.log(`\nTo pack it for the browser when ready:`);
    console.log(`  pnpm build:collider ${glb} public/collider.bin`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
