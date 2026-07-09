import type { Vec3 } from 'mathcat';

// Everything specific to THIS scene's geometry and layout lives here, so swapping
// in a new world is a one-file edit. Retune these to your space; per-system "feel"
// constants stay in their own files.

// --- Assets (served from public/; see the README's asset pi`peline) ---
// BASE_URL is '/' in dev and '/<repo>/' for the GitHub Pages build (vite.config.ts),
// so these resolve whether served from the domain root or a project subpath.
const BASE = import.meta.env.BASE_URL;
// LOD-encoded Spark asset (built by `pnpm build:lod` from assets/anime-city.spz).
// The .rad format is what makes Spark's LOD/paging budget (src/performance.ts)
// actually take effect — a flat .spz renders all splats every frame.
export const SPLAT_URL = `${BASE}anime-city-lod.rad`;
export const COLLIDER_URL = `${BASE}collider.glb`;
export const NAVMESH_URL = `${BASE}navmesh.json`;

// --- Camera framing (world-space) — the orbit camera's start pose ---
export const CAMERA_POSITION: Vec3 = [12, 5, -6];
export const CAMERA_TARGET: Vec3 = [0, 4, -2];

// --- First-person character ---
// PLACEHOLDER: drop in near the intersection centre (your 0.15-scale pick,
// converted to native). Refine with orbit mode + the debug raycast readout.
export const CHARACTER_SPAWN: Vec3 = [0.33, 2.5, 0.73];
export const CHARACTER_LOOK_TARGET: Vec3 = [251, 3, -14];

// --- Physics ---
export const GRAVITY: Vec3 = [0, -9.81, 0];
