/**
 * World-space crop box for the generated collider + navmesh.
 *
 * The voxel collider baked from the full splat captures far-away buildings and
 * tall sky floaters we never interact with. Cropping to a box around the
 * playable area trims that junk, shrinks collider.glb, and keeps the navmesh
 * heightfield small enough to build.
 *
 * The box is in WORLD space — the same frame as src/scene.ts, public/collider.glb
 * and the rendered splat. generate-collision-mesh.ts applies the 180°-about-Y fix
 * before cropping, so this box is expressed directly in world coordinates. The
 * full splat spans roughly:
 *   X [-288, 300]   Y [-10, 296]   Z [-152, 84]
 * Most of the Y range and the X/Z tails are scenery/floaters. Tighten these six
 * numbers to taste to control what the collider/navmesh bake keeps.
 *
 * Set CROP to null to disable cropping (capture everything).
 */
// A ~30-unit box around the navmesh prune seed (-2.13, 1.29, -2.47 in
// build-navmesh.ts), matching the navmesh's 30-unit prune radius so the collider
// and navmesh cover the same playable bubble. Y is kept a bit taller than wide
// to catch the ground below and walls overhead.
// Box around the actual playable area, taken from the (known-good) navmesh
// footprint — X[-35,27] Z[-18,9] Y[-1,2], centre ≈ (-4, -4) — with ~15 units of
// horizontal margin to catch the walls/buildings lining the street, and Y from
// below the floor up to wall height.
// Y is deliberately shallow: a first-person walker only needs collision from just
// below the ground up to a bit over head height. Capping max.y at ~6 drops all the
// building tops / tree canopies / high floaters — ~60% of the triangles here — at
// BOTH voxelization (the filter-box derives its Y from this) and the crop. Raise
// max.y if you need tall overhangs/awnings or an overhead camera.
export const CROP: { min: [number, number, number]; max: [number, number, number] } | null = {
    min: [-100, -1, -60],
    max: [80, 6, 50],
};

type Vertices = ArrayLike<number>;
type Indices = ArrayLike<number>;

/**
 * Keep only triangles whose centroid falls inside `box`, compacting the
 * referenced vertices. Returns fresh typed arrays. With `box === null` the mesh
 * is returned unchanged (just copied into typed arrays).
 *
 * @param positions - 3 floats per vertex, in world space.
 * @param indices - 3 indices per triangle.
 * @param box - World-space crop box, or null to keep everything.
 */
export function cropMesh(
    positions: Vertices,
    indices: Indices,
    box: typeof CROP,
): { positions: Float32Array; indices: Uint32Array } {
    if (!box) {
        return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
    }

    const { min, max } = box;
    const outPos: number[] = [];
    const outIdx: number[] = [];
    const remap = new Map<number, number>();

    const keepVertex = (v: number): number => {
        let nv = remap.get(v);
        if (nv === undefined) {
            nv = outPos.length / 3;
            remap.set(v, nv);
            outPos.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
        }
        return nv;
    };

    for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t];
        const b = indices[t + 1];
        const c = indices[t + 2];
        // Centroid test: a triangle is kept iff its centre lies in the box. This
        // keeps geometry straddling the boundary on the inside half and avoids a
        // hard vertex-clip seam.
        const cx = (positions[a * 3] + positions[b * 3] + positions[c * 3]) / 3;
        const cy = (positions[a * 3 + 1] + positions[b * 3 + 1] + positions[c * 3 + 1]) / 3;
        const cz = (positions[a * 3 + 2] + positions[b * 3 + 2] + positions[c * 3 + 2]) / 3;
        if (cx < min[0] || cx > max[0] || cy < min[1] || cy > max[1] || cz < min[2] || cz > max[2]) {
            continue;
        }
        outIdx.push(keepVertex(a), keepVertex(b), keepVertex(c));
    }

    return { positions: Float32Array.from(outPos), indices: Uint32Array.from(outIdx) };
}
