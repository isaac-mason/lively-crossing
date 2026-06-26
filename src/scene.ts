import type { Vec3 } from 'mathcat';

// Everything specific to THIS scene's geometry and layout lives here, so swapping
// in a new world is a one-file edit. Retune these to your space; per-system "feel"
// constants stay in their own files.

// --- Assets (served from public/; see the README's asset pipeline) ---
// BASE_URL is '/' in dev and '/<repo>/' for the GitHub Pages build (vite.config.ts),
// so these resolve whether served from the domain root or a project subpath.
const BASE = import.meta.env.BASE_URL;
export const SPLAT_URL = `${BASE}anime-city.spz`;
export const COLLIDER_URL = `${BASE}collider.bin`;
export const NAVMESH_URL = `${BASE}navmesh.json`;

// --- Camera framing (world-space) — used by orbit-mode controls ---
// PLACEHOLDER: a 3/4 view of the whole intersection (native bounds ~524x181x131).
export const CAMERA_POSITION: Vec3 = [267, 200, 267];
export const CAMERA_TARGET: Vec3 = [-11, 33, -14];

// --- First-person character ---
// PLACEHOLDER: drop in near the intersection centre (your 0.15-scale pick,
// converted to native). Refine with orbit mode + the debug raycast readout.
export const CHARACTER_SPAWN: Vec3 = [0.33, 2.5, 0.73];
export const CHARACTER_LOOK_TARGET: Vec3 = [251, 3, -14];

// --- Physics ---
export const GRAVITY: Vec3 = [0, -9.81, 0];
export const FLOOR_Y = -12; // floor / kill-plane height (below the lowest geometry at y≈-8.44)
export const FLOOR_HALF_EXTENTS: Vec3 = [300, 0.1, 100]; // catch-plane footprint under the scene
