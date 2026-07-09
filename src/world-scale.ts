/**
 * Uniform scale applied to the whole scene so its world units match the
 * character controller's human scale (~1.8 m). 1 = the splat's native units
 * (which for Anime City are already roughly metres).
 *
 * The same factor is applied to the SplatMesh (runtime, src/index.ts), the
 * physics collider, and the navmesh (both baked at build time by scripts/), so
 * all three stay aligned.
 *
 * To retune: change this value, then re-run `pnpm build:collision-mesh-glb` and
 * `pnpm build:navmesh` (the splat picks it up automatically on reload).
 */
export const WORLD_SCALE = 1;
