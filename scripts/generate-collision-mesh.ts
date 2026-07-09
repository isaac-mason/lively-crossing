/**
 * Generate the collision mesh: splat -> crop -> voxel density -> smooth iso-surface.
 *
 * Read the .spz directly (positions + opacity), bin splat centres into a density
 * grid, blur it, then extract a SMOOTH iso-surface with Surface Nets (a marching-
 * cubes-family dual method): vertices are interpolated onto the density crossing,
 * so slopes/hills come out sloped (not blocky 90° voxel steps) and the floor sits
 * at the actual splat surface rather than the top of a voxel. No fabricated walls,
 * no classification — the mesh is exactly the surface of the splat.
 *
 * The .spz native coords are Spark's render/world frame (verified: Spark's splat
 * bounds equal the raw .spz bounds), so no rotation — output is world-frame.
 *
 * Output (assets/anime-city.collision.glb) is the shared collision mesh, consumed
 * by build-collision-mesh-glb.ts (runtime collider) and build-navmesh.ts (navmesh).
 *
 * Usage: pnpm generate:collision-mesh [in.spz] [out.glb] [voxel] [alpha] [iso]
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Document, NodeIO } from '@gltf-transform/core';
import { CROP } from './collider-crop.ts';

const INPUT = process.argv[2] ?? 'assets/anime-city.spz';
const OUTPUT = process.argv[3] ?? 'assets/anime-city.collision.glb';
// Recast-style anisotropic grid: coarse horizontal cell size (CS), FINE vertical
// cell height (CH). Fine CH resolves the ground's vertical density gradient
// sharply, so the iso-surface lands precisely on the floor and follows curbs/
// slopes in Y instead of snapping to a coarse voxel.
const CS = Number(process.argv[4] ?? 0.5); // horizontal cell size (XZ)
const CH = Number(process.argv[8] ?? 0.15); // vertical cell height (Y)
const ALPHA_MIN = Number(process.argv[5] ?? 90); // min opacity byte (0..255)
const ISO = Number(process.argv[6] ?? 5); // density iso-level (higher = onto the dense road core / less reach; lower = more street reach + noise)
const BLUR = 1; // horizontal (XZ) box-blur radius on the density field (smooths streets)
// Final vertical trim after ISO places the surface (m). Slightly negative to
// offset the small upward creep from Taubin smoothing.
const GROUND_OFFSET = Number(process.argv[7] ?? -0.1);

if (!CROP) throw new Error('generate-collision-mesh: CROP box is required');
const { min, max } = CROP;
const nx = Math.ceil((max[0] - min[0]) / CS);
const ny = Math.ceil((max[1] - min[1]) / CH);
const nz = Math.ceil((max[2] - min[2]) / CS);

// --- 1. Parse .spz (positions int24/2^frac, then scales, rotations, alphas). ---
const buf = gunzipSync(readFileSync(INPUT));
if (buf.readUInt32LE(0) !== 0x5053474e) throw new Error('not an SPZ (bad magic)');
const num = buf.readUInt32LE(8);
const frac = buf.readUInt8(13);
const posScale = 1 / (1 << frac);
const posOff = 16;
const alphaOff = 16 + num * 9 + num * 3 + num * 3;
const rd = (o: number): number => {
    let v = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
    if (v & 0x800000) v -= 0x1000000;
    return v * posScale;
};

// --- 2. Density grid (splat counts), laid out x + y*nx + z*nx*ny for Surface Nets. ---
const NXY = nx * ny;
const fidx = (ix: number, iy: number, iz: number) => ix + iy * nx + iz * NXY;
const counts = new Float32Array(nx * ny * nz);
let kept = 0;
for (let i = 0; i < num; i++) {
    if (buf[alphaOff + i] < ALPHA_MIN) continue;
    const o = posOff + i * 9;
    const x = rd(o),
        y = rd(o + 3),
        z = rd(o + 6);
    if (x < min[0] || x >= max[0] || y < min[1] || y >= max[1] || z < min[2] || z >= max[2]) continue;
    const ix = ((x - min[0]) / CS) | 0;
    const iy = ((y - min[1]) / CH) | 0;
    const iz = ((z - min[2]) / CS) | 0;
    counts[fidx(ix, iy, iz)]++;
    kept++;
}
// Horizontal (XZ-only) box blur -> smooths street jaggedness WITHOUT smearing the
// dense street band upward in Y (which would lift the floor above the surface).
let field = counts;
if (BLUR > 0) {
    const out = new Float32Array(counts.length);
    for (let iz = 0; iz < nz; iz++) {
        for (let iy = 0; iy < ny; iy++) {
            for (let ix = 0; ix < nx; ix++) {
                let s = 0,
                    c = 0;
                for (let dz = -BLUR; dz <= BLUR; dz++) {
                    for (let dx = -BLUR; dx <= BLUR; dx++) {
                        const jx = ix + dx,
                            jz = iz + dz;
                        if (jx < 0 || jx >= nx || jz < 0 || jz >= nz) continue;
                        s += counts[fidx(jx, iy, jz)];
                        c++;
                    }
                }
                out[fidx(ix, iy, iz)] = s / c;
            }
        }
    }
    field = out;
}

// --- 2b. Per-column height cutoff: keep density only from the ground up to
//         CUTOFF_M above it, zero everything higher. This is the robust way to
//         drop overhead foliage/haze/floaters (they're above the walkable ground)
//         while keeping the ground + low walls. Columns with no ground are cleared
//         entirely (no floating junk in the void). CUTOFF_M <= 0 disables. ---
const CUTOFF_M = Number(process.argv[9] ?? 2.5);
if (CUTOFF_M > 0) {
    const cutoffVox = Math.round(CUTOFF_M / CH);
    for (let iz = 0; iz < nz; iz++) {
        for (let ix = 0; ix < nx; ix++) {
            let g = -1;
            for (let iy = 0; iy < ny; iy++) {
                if (field[fidx(ix, iy, iz)] >= ISO) {
                    g = iy;
                    break;
                }
            }
            const top = g >= 0 ? g + cutoffVox : -1;
            for (let iy = top + 1; iy < ny; iy++) field[fidx(ix, iy, iz)] = 0;
        }
    }
}

// --- 2c. Morphological opening (grayscale erode -> dilate). Off by default: the
//         ground is a thin surface too, so erosion damages the street. ---
const OPEN = 0; // morphological opening disabled (erodes the thin ground surface)
if (OPEN > 0) {
    const morph = (src: Float32Array, pick: (a: number, b: number) => number) => {
        const out = new Float32Array(src.length);
        for (let iz = 0; iz < nz; iz++) {
            for (let iy = 0; iy < ny; iy++) {
                for (let ix = 0; ix < nx; ix++) {
                    let acc = src[fidx(ix, iy, iz)];
                    for (let dz = -OPEN; dz <= OPEN; dz++) {
                        for (let dy = -OPEN; dy <= OPEN; dy++) {
                            for (let dx = -OPEN; dx <= OPEN; dx++) {
                                const jx = ix + dx,
                                    jy = iy + dy,
                                    jz = iz + dz;
                                const s =
                                    jx < 0 || jx >= nx || jy < 0 || jy >= ny || jz < 0 || jz >= nz ? 0 : src[fidx(jx, jy, jz)];
                                acc = pick(acc, s);
                            }
                        }
                    }
                    out[fidx(ix, iy, iz)] = acc;
                }
            }
        }
        return out;
    };
    field = morph(field, Math.min); // erode
    field = morph(field, Math.max); // dilate
}

// --- 2d. Recast-style span fill: the ground density is a SLAB, and an iso-surface
//         of a slab is a hollow shell (top skin + bottom skin) -> two ground
//         layers. Solidify each column from the bottom up to its highest solid
//         (the ground top), collapsing the slab into a solid half-space so surface
//         nets yields exactly ONE top surface; the underside just becomes the base
//         of the block, not a second walkable layer. SPAN_FILL <= 0 disables. ---
const SPAN_FILL = Number(process.argv[10] ?? 1);
// SOLID/ISO ratio for the solidified field controls WHERE in the top cell the
// surface-nets crossing lands: high ratio -> ~top of the cell, ~1 -> cell bottom.
// Bias it low so the floor sits at the bottom of the ground cell (slightly lower).
const FLOOR_CELL_BIAS = Number(process.argv[11] ?? 1.3);
if (SPAN_FILL > 0) {
    const SOLID = ISO * FLOOR_CELL_BIAS;
    for (let iz = 0; iz < nz; iz++) {
        for (let ix = 0; ix < nx; ix++) {
            let top = -1;
            for (let iy = ny - 1; iy >= 0; iy--) {
                if (field[fidx(ix, iy, iz)] >= ISO) {
                    top = iy;
                    break;
                }
            }
            for (let iy = 0; iy < ny; iy++) field[fidx(ix, iy, iz)] = iy <= top ? SOLID : 0;
        }
    }
}

// --- 3. Surface Nets: smooth iso-surface of `field` at level ISO. ---
// (Naive Surface Nets, after Mikola Lysenko / S.F. Gibson.)
const cubeEdges = new Int32Array(24);
const edgeTable = new Int32Array(256);
{
    let k = 0;
    for (let i = 0; i < 8; i++) {
        for (let j = 1; j <= 4; j <<= 1) {
            const p = i ^ j;
            if (i <= p) {
                cubeEdges[k++] = i;
                cubeEdges[k++] = p;
            }
        }
    }
    for (let i = 0; i < 256; i++) {
        let em = 0;
        for (let j = 0; j < 24; j += 2) {
            const a = !!(i & (1 << cubeEdges[j]));
            const b = !!(i & (1 << cubeEdges[j + 1]));
            em |= a !== b ? 1 << (j >> 1) : 0;
        }
        edgeTable[i] = em;
    }
}
const positions: number[] = [];
const indices: number[] = [];
const dims = [nx, ny, nz];
const R = [1, nx + 1, (nx + 1) * (ny + 1)];
const grid = new Float32Array(8);
const buffer = new Int32Array(R[2] * 2);
let bufNo = 1;
let n = 0;
const x = [0, 0, 0];
for (x[2] = 0; x[2] < dims[2] - 1; x[2]++, n += dims[0], bufNo ^= 1, R[2] = -R[2]) {
    let m = 1 + (dims[0] + 1) * (1 + bufNo * (dims[1] + 1));
    for (x[1] = 0; x[1] < dims[1] - 1; x[1]++, n++, m += 2) {
        for (x[0] = 0; x[0] < dims[0] - 1; x[0]++, n++, m++) {
            let mask = 0,
                g = 0,
                idx = n;
            for (let k = 0; k < 2; k++, idx += dims[0] * (dims[1] - 2)) {
                for (let j = 0; j < 2; j++, idx += dims[0] - 2) {
                    for (let i = 0; i < 2; i++, g++, idx++) {
                        const p = field[idx] - ISO;
                        grid[g] = p;
                        mask |= p < 0 ? 1 << g : 0;
                    }
                }
            }
            if (mask === 0 || mask === 0xff) continue;
            const edgeMask = edgeTable[mask];
            const vv = [0, 0, 0];
            let eCount = 0;
            for (let i = 0; i < 12; i++) {
                if (!(edgeMask & (1 << i))) continue;
                eCount++;
                const e0 = cubeEdges[i << 1];
                const e1 = cubeEdges[(i << 1) + 1];
                const g0 = grid[e0],
                    g1 = grid[e1];
                let t = g0 - g1;
                if (Math.abs(t) > 1e-6) t = g0 / t;
                else continue;
                for (let j = 0, k = 1; j < 3; j++, k <<= 1) {
                    const a = e0 & k,
                        b = e1 & k;
                    if (a !== b) vv[j] += a ? 1.0 - t : t;
                    else vv[j] += a ? 1.0 : 0.0;
                }
            }
            const s = 1.0 / eCount;
            for (let i = 0; i < 3; i++) vv[i] = x[i] + s * vv[i];
            buffer[m] = positions.length / 3;
            positions.push(min[0] + (vv[0] + 0.5) * CS, min[1] + (vv[1] + 0.5) * CH + GROUND_OFFSET, min[2] + (vv[2] + 0.5) * CS);
            for (let i = 0; i < 3; i++) {
                if (!(edgeMask & (1 << i))) continue;
                const iu = (i + 1) % 3,
                    iv = (i + 2) % 3;
                if (x[iu] === 0 || x[iv] === 0) continue;
                const du = R[iu],
                    dv = R[iv];
                const a = buffer[m],
                    b = buffer[m - du],
                    c = buffer[m - du - dv],
                    e = buffer[m - dv];
                if (mask & 1) indices.push(a, e, c, a, c, b);
                else indices.push(a, b, c, a, c, e);
            }
        }
    }
}

// --- 3b. Feature-preserving Taubin smoothing of the ground. Relaxes each vertex
//         toward its neighbours (λ then μ passes, so it de-noises without
//         shrinking), but FREEZES any vertex touching a steep face (|ny| < 0.5)
//         so walls/curbs stay crisp — no ramps for the agent to climb. ---
const SMOOTH_ITERS = Number(process.argv[12] ?? 3);
if (SMOOTH_ITERS > 0 && indices.length > 0) {
    const nV = positions.length / 3;
    const frozen = new Uint8Array(nV);
    const nbr: Set<number>[] = Array.from({ length: nV }, () => new Set<number>());
    for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t],
            b = indices[t + 1],
            c = indices[t + 2];
        nbr[a].add(b);
        nbr[a].add(c);
        nbr[b].add(a);
        nbr[b].add(c);
        nbr[c].add(a);
        nbr[c].add(b);
        // face normal.y -> freeze steep (wall) vertices
        const pa = a * 3,
            pb = b * 3,
            pc = c * 3;
        const ux = positions[pb] - positions[pa],
            uy = positions[pb + 1] - positions[pa + 1],
            uz = positions[pb + 2] - positions[pa + 2];
        const vx = positions[pc] - positions[pa],
            vy = positions[pc + 1] - positions[pa + 1],
            vz = positions[pc + 2] - positions[pa + 2];
        const ny = uz * vx - ux * vz;
        const L = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx) || 1;
        if (Math.abs(ny / L) < 0.5) {
            frozen[a] = 1;
            frozen[b] = 1;
            frozen[c] = 1;
        }
    }
    const nbrArr = nbr.map((s) => [...s]);
    const pass = (factor: number) => {
        const out = Float32Array.from(positions);
        for (let v = 0; v < nV; v++) {
            if (frozen[v]) continue;
            const ns = nbrArr[v];
            if (ns.length === 0) continue;
            let sx = 0,
                sy = 0,
                sz = 0;
            for (const w of ns) {
                sx += positions[w * 3];
                sy += positions[w * 3 + 1];
                sz += positions[w * 3 + 2];
            }
            const n = ns.length;
            out[v * 3] = positions[v * 3] + factor * (sx / n - positions[v * 3]);
            out[v * 3 + 1] = positions[v * 3 + 1] + factor * (sy / n - positions[v * 3 + 1]);
            out[v * 3 + 2] = positions[v * 3 + 2] + factor * (sz / n - positions[v * 3 + 2]);
        }
        for (let i = 0; i < positions.length; i++) positions[i] = out[i];
    };
    for (let i = 0; i < SMOOTH_ITERS; i++) {
        pass(0.5);
        pass(-0.53);
    }
}

// --- 4. Write GLB (world frame). ---
const doc = new Document();
const bufAcc = doc.createBuffer();
const pAcc = doc.createAccessor().setType('VEC3').setArray(Float32Array.from(positions)).setBuffer(bufAcc);
const iAcc = doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from(indices)).setBuffer(bufAcc);
const prim = doc.createPrimitive().setAttribute('POSITION', pAcc).setIndices(iAcc);
doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)));
await new NodeIO().write(OUTPUT, doc);

console.log(`Wrote ${OUTPUT}`);
console.log(
    `  grid ${nx}x${ny}x${nz}  cs ${CS}m ch ${CH}m iso ${ISO}  (kept ${kept.toLocaleString()} / ${num.toLocaleString()} splats)`,
);
console.log(`  verts ${positions.length / 3}  tris ${indices.length / 3}`);
