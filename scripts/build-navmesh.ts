/**
 * Build a solo navmesh from the Spark collider GLB.
 *
 * Reads the collider .glb, extracts world-space walkable geometry via
 * gltf-transform, generates a solo navmesh with navcat, and writes the tile
 * (+ origin / tile size) to public/navmesh.json. The browser rebuilds the
 * NavMesh from that JSON in src/navigation.ts.
 *
 * Usage:
 *   pnpm build:navmesh [input.glb] [output.json]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import {
    addTile,
    buildTile,
    createFindNearestPolyResult,
    createNavMesh,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
    getNodeByTileAndPoly,
    type NavMesh,
    type NavMeshPoly,
    type NavMeshPolyDetail,
    type NavMeshTile,
    type NavMeshTileParams,
    type NodeRef,
    POLY_NEIS_FLAG_EXT_LINK,
    type Vec3,
} from 'navcat';
import { floodFillNavMesh, generateSoloNavMesh, type SoloNavMeshOptions } from 'navcat/blocks';

// --- Pruning: keep only polys reachable from a seed point AND within a radius ---
// Seed sits at the intersection the player/crowd use; everything not connected to
// it (or too far away) is dropped so the navmesh is a tidy bubble around the area.
// Seed sits on the connected ground plaza (Y≈0, footprint X[-24,13] Z[-14,17])
// that the op0.3 + filter-floaters collider produces. Flood-fill from here keeps
// the walkable plaza and drops the disconnected rooftop + far pockets.
const PRUNE_SEED: Vec3 = [-5, 0, 1];
const PRUNE_RADIUS = 90; // metres — flood-fill keeps only connected walkable street within this
const SEED_FIND_HALF_EXTENTS: Vec3 = [4, 8, 4]; // search box for locating the seed poly

const INPUT = process.argv[2] ?? 'assets/anime-city.collision.glb';
const OUTPUT = process.argv[3] ?? 'public/navmesh.json';

/* -------------------------------------------------------------------------- */
/*  Navmesh pruning (flood-fill + radius)                                      */
/*                                                                            */
/*  Ported from navcat's example-flood-fill-pruning. sanitizeTilePolys /       */
/*  pruneNavMesh use only the public navcat API, so they stay valid if navcat  */
/*  later lifts them into navcat/blocks.                                       */
/* -------------------------------------------------------------------------- */

/**
 * Produces sanitized params for `tile` containing only the polys whose
 * `keep[polyIndex]` is true. Removed polys are physically dropped: vertices,
 * detail meshes and adjacency are compacted and made internally consistent.
 * Returns `null` if no polys survive, signalling the caller to drop the tile.
 */
function sanitizeTilePolys(tile: NavMeshTile, keep: boolean[]): NavMeshTileParams | null {
    // old poly index -> new poly index (-1 == removed)
    const polyRemap = new Array<number>(tile.polys.length).fill(-1);
    const survivors: number[] = [];
    for (let i = 0; i < tile.polys.length; i++) {
        if (keep[i]) {
            polyRemap[i] = survivors.length;
            survivors.push(i);
        }
    }

    if (survivors.length === 0) return null;

    // compact the vertices referenced by surviving polys
    const vertexRemap = new Map<number, number>();
    const vertices: number[] = [];
    const remapVertex = (oldVert: number): number => {
        let newVert = vertexRemap.get(oldVert);
        if (newVert === undefined) {
            newVert = vertices.length / 3;
            vertexRemap.set(oldVert, newVert);
            vertices.push(tile.vertices[oldVert * 3], tile.vertices[oldVert * 3 + 1], tile.vertices[oldVert * 3 + 2]);
        }
        return newVert;
    };

    const polys: NavMeshPoly[] = [];
    const detailMeshes: NavMeshPolyDetail[] = [];
    const detailVertices: number[] = [];
    const detailTriangles: number[] = [];

    for (const oldPoly of survivors) {
        const poly = tile.polys[oldPoly];

        polys.push({
            vertices: poly.vertices.map(remapVertex),
            neis: poly.neis.map((nei) => {
                if (nei === 0) return 0; // boundary edge
                if (nei & POLY_NEIS_FLAG_EXT_LINK) return nei; // portal to adjacent tile
                const newNeighbour = polyRemap[nei - 1]; // internal edge (1-based)
                return newNeighbour === -1 ? 0 : newNeighbour + 1; // removed neighbour -> boundary
            }),
            flags: poly.flags,
            area: poly.area,
        });

        // copy this poly's detail block. detail triangle indices are poly-local
        // (they reference the poly's own verts + its detail-vert block), so the
        // indices stay valid and only the base offsets change.
        const detail = tile.detailMeshes[oldPoly];
        const verticesBase = detailVertices.length / 3;
        const trianglesBase = detailTriangles.length / 4;

        for (let v = 0; v < detail.verticesCount; v++) {
            const src = (detail.verticesBase + v) * 3;
            detailVertices.push(tile.detailVertices[src], tile.detailVertices[src + 1], tile.detailVertices[src + 2]);
        }
        for (let t = 0; t < detail.trianglesCount; t++) {
            const src = (detail.trianglesBase + t) * 4;
            detailTriangles.push(
                tile.detailTriangles[src],
                tile.detailTriangles[src + 1],
                tile.detailTriangles[src + 2],
                tile.detailTriangles[src + 3],
            );
        }

        detailMeshes.push({
            verticesBase,
            verticesCount: detail.verticesCount,
            trianglesBase,
            trianglesCount: detail.trianglesCount,
        });
    }

    // reuse the original tile bounds: the BV tree quantizes relative to the
    // tile's min corner and queries dequantize against the same stored bounds.
    return {
        tileX: tile.tileX,
        tileY: tile.tileY,
        tileLayer: tile.tileLayer,
        bounds: [...tile.bounds] as NavMeshTileParams['bounds'],
        vertices,
        polys,
        detailMeshes,
        detailVertices,
        detailTriangles,
        cellSize: tile.cellSize,
        cellHeight: tile.cellHeight,
        walkableHeight: tile.walkableHeight,
        walkableRadius: tile.walkableRadius,
        walkableClimb: tile.walkableClimb,
    };
}

/**
 * Re-assembles a brand-new navmesh containing only the polys whose node ref is
 * in `keep`; every other poly is pruned. `addTile` rebuilds the internal +
 * cross-tile portal links from scratch.
 */
function pruneNavMesh(navMesh: NavMesh, keep: Set<NodeRef>): NavMesh {
    const result = createNavMesh();
    result.origin = [...navMesh.origin] as Vec3;
    result.tileWidth = navMesh.tileWidth;
    result.tileHeight = navMesh.tileHeight;

    for (const tileId in navMesh.tiles) {
        const tile = navMesh.tiles[tileId];
        const keepPoly = tile.polyNodes.map((nodeIndex) => keep.has(navMesh.nodes[nodeIndex].ref));
        const params = sanitizeTilePolys(tile, keepPoly);
        if (params) addTile(result, buildTile(params));
    }

    return result;
}

function countPolys(navMesh: NavMesh): number {
    let count = 0;
    for (const tileId in navMesh.tiles) count += navMesh.tiles[tileId].polys.length;
    return count;
}

// Average of a poly's vertices (world space) — used for the radius test.
function polyCenter(tile: NavMeshTile, poly: NavMeshPoly, out: Vec3): void {
    out[0] = out[1] = out[2] = 0;
    for (const v of poly.vertices) {
        out[0] += tile.vertices[v * 3];
        out[1] += tile.vertices[v * 3 + 1];
        out[2] += tile.vertices[v * 3 + 2];
    }
    const n = poly.vertices.length || 1;
    out[0] /= n;
    out[1] /= n;
    out[2] /= n;
}

/**
 * The set of poly node refs to keep: those reachable (flood fill) from the poly
 * nearest `seed`, AND whose centre is within `radius` of `seed`.
 */
function keepSetForSeed(navMesh: NavMesh, seed: Vec3, radius: number): Set<NodeRef> {
    const nearest = createFindNearestPolyResult();
    findNearestPoly(nearest, navMesh, seed, SEED_FIND_HALF_EXTENTS, DEFAULT_QUERY_FILTER);
    if (!nearest.success) {
        throw new Error(`prune seed ${seed.join(', ')} is not on the navmesh (widen SEED_FIND_HALF_EXTENTS?)`);
    }

    const reachable = new Set<NodeRef>(floodFillNavMesh(navMesh, [nearest.nodeRef]).reachable);

    const radius2 = radius * radius;
    const center: Vec3 = [0, 0, 0];
    const keep = new Set<NodeRef>();
    for (const tileId in navMesh.tiles) {
        const tile = navMesh.tiles[tileId];
        for (let p = 0; p < tile.polys.length; p++) {
            const ref = getNodeByTileAndPoly(navMesh, tile, p).ref;
            if (!reachable.has(ref)) continue; // not connected to the seed
            polyCenter(tile, tile.polys[p], center);
            const dx = center[0] - seed[0];
            const dy = center[1] - seed[1];
            const dz = center[2] - seed[2];
            if (dx * dx + dy * dy + dz * dz <= radius2) keep.add(ref);
        }
    }
    return keep;
}

async function main() {
    /* read input mesh (world-space positions + indices) */

    console.log('Reading walkable mesh from', INPUT);
    const io = new NodeIO();
    const doc = await io.read(resolve(INPUT));
    const root = doc.getRoot();

    const positions: number[] = [];
    const indices: number[] = [];

    for (const node of root.listNodes()) {
        const mesh = node.getMesh();
        if (!mesh) continue;

        // Bake the node's world transform so the navmesh lines up with the splat
        // and the physics collider (which bakes transforms the same way).
        const m = node.getWorldMatrix();

        for (const prim of mesh.listPrimitives()) {
            const posAccessor = prim.getAttribute('POSITION');
            const indexAccessor = prim.getIndices();
            if (!posAccessor || !indexAccessor) continue;

            const baseVertex = positions.length / 3;

            const src = posAccessor.getArray();
            if (!src) continue;
            for (let i = 0; i < posAccessor.getCount(); i++) {
                const x = src[i * 3];
                const y = src[i * 3 + 1];
                const z = src[i * 3 + 2];
                positions.push((m[0] * x + m[4] * y + m[8] * z + m[12]));
                positions.push((m[1] * x + m[5] * y + m[9] * z + m[13]));
                positions.push((m[2] * x + m[6] * y + m[10] * z + m[14]));
            }

            const idx = indexAccessor.getArray();
            if (!idx) continue;
            for (let i = 0; i < idx.length; i++) {
                indices.push(idx[i] + baseVertex);
            }
        }
    }

    console.log(`  ${positions.length / 3} vertices, ${indices.length / 3} triangles`);

    /* generate solo navmesh */

    // cellSize = horizontal voxel size; cellHeight = vertical. Kept coarse enough
    // that the generator's span arrays don't overflow on a mesh this large (0.05
    // gives a ~1940x1420 heightfield over the ~97x71 collider and triggers V8
    // "invalid table size"). 0.2 -> ~485x355, plenty for a walkable street;
    // ground-hugging is handled by the detail sample params below.
    const cs = 0.2;
    const ch = 0.1;

    const walkableRadiusWorld = 0.1;
    // The floor-fill ground is voxel-stepped, so too small a climb leaves it a
    // field of disconnected bumps. 0.4 (curb height) lets the agent step over the
    // voxel steps so the plaza connects (ground polys ~92 -> ~168); larger
    // plateaus and starts merging onto curbs/low walls, so 0.4 is the sweet spot.
    const walkableClimbWorld = 0.4;
    const walkableHeightWorld = 1;

    const options: SoloNavMeshOptions = {
        cellSize: cs,
        cellHeight: ch,
        walkableRadiusVoxels: Math.ceil(walkableRadiusWorld / cs),
        walkableRadiusWorld,
        walkableClimbVoxels: Math.ceil(walkableClimbWorld / ch),
        walkableClimbWorld,
        walkableHeightVoxels: Math.ceil(walkableHeightWorld / ch),
        walkableHeightWorld,
        walkableSlopeAngleDegrees: 45,
        borderSize: 1,
        minRegionArea: 8,
        mergeRegionArea: 20,
        maxSimplificationError: 1.3,
        maxEdgeLength: 12,
        maxVerticesPerPoly: 6,
        // World-unit knobs that control how closely the nav surface follows the
        // real ground. Distance = how often the true height is sampled within a
        // poly; MaxError = how far the surface may sit off before it's refined.
        // The old 6 / 1 left the mesh floating up to ~1m; tighten for a snug fit.
        detailSampleDistance: 1,
        detailSampleMaxError: 0.15,
    };

    console.log('Generating solo navmesh...');
    const { navMesh } = generateSoloNavMesh({ positions, indices }, options);

    /* prune to the reachable bubble around the seed */

    console.log(`Pruning: flood-fill from ${PRUNE_SEED.join(', ')}, radius ${PRUNE_RADIUS}m...`);
    const keep = keepSetForSeed(navMesh, PRUNE_SEED, PRUNE_RADIUS);
    const prunedNavMesh = pruneNavMesh(navMesh, keep);
    console.log(`  polys: ${countPolys(navMesh)} -> ${countPolys(prunedNavMesh)}`);

    /* write result to file */

    const tiles = Object.values(prunedNavMesh.tiles);
    const result = {
        origin: prunedNavMesh.origin,
        tileWidth: prunedNavMesh.tileWidth,
        tileHeight: prunedNavMesh.tileHeight,
        tiles,
    };

    await mkdir(dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, JSON.stringify(result));

    console.log(`Wrote ${OUTPUT}: ${tiles.length} tiles`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
