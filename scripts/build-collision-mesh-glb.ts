/**
 * Bake the runtime collider from the collision mesh.
 *
 * Reads the collision mesh (assets/anime-city.collision.glb, produced by
 * `pnpm generate:collision-mesh`), flattens it to world-space positions +
 * triangle indices, and writes public/collider.glb: position-quantized
 * (KHR_mesh_quantization) and Meshopt-compressed (EXT_meshopt_compression).
 * Loaded at runtime by src/collider.ts via GLTFLoader + MeshoptDecoder.
 *
 * Usage:
 *   pnpm build:collision-mesh-glb [input.glb] [output.glb]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { WORLD_SCALE } from '../src/world-scale.ts';

const TRIANGLES = 4; // glTF primitive mode

const INPUT = process.argv[2] ?? 'assets/anime-city.collision.glb';
const OUTPUT = process.argv[3] ?? 'public/collider.glb';

async function main() {
    await MeshoptEncoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

    const src = await io.read(resolve(INPUT));

    // Flatten every mesh primitive into one world-space triangle soup, baking each
    // node's world transform and WORLD_SCALE into the positions so the collider
    // lines up with the splat (which the app renders at WORLD_SCALE).
    const positions: number[] = [];
    const indices: number[] = [];
    let vertBase = 0;

    for (const node of src.getRoot().listNodes()) {
        const mesh = node.getMesh();
        if (!mesh) continue;
        const m = node.getWorldMatrix();

        for (const prim of mesh.listPrimitives()) {
            if (prim.getMode() !== TRIANGLES) {
                console.warn(`Skipping non-triangle primitive (mode ${prim.getMode()})`);
                continue;
            }
            const posAcc = prim.getAttribute('POSITION');
            const pos = posAcc?.getArray();
            if (!posAcc || !pos) continue;
            const count = posAcc.getCount();

            for (let i = 0; i < count; i++) {
                const x = pos[i * 3];
                const y = pos[i * 3 + 1];
                const z = pos[i * 3 + 2];
                positions.push(
                    (m[0] * x + m[4] * y + m[8] * z + m[12]) * WORLD_SCALE,
                    (m[1] * x + m[5] * y + m[9] * z + m[13]) * WORLD_SCALE,
                    (m[2] * x + m[6] * y + m[10] * z + m[14]) * WORLD_SCALE,
                );
            }

            // Re-index onto the running vertex base; synthesize indices for a
            // non-indexed primitive.
            const idx = prim.getIndices()?.getArray();
            if (idx) {
                for (let i = 0; i < idx.length; i++) indices.push(idx[i] + vertBase);
            } else {
                for (let i = 0; i < count; i++) indices.push(vertBase + i);
            }
            vertBase += count;
        }
    }

    if (positions.length === 0) throw new Error(`No triangle geometry found in ${INPUT}`);

    // Rebuild a minimal single-mesh document (positions + indices only).
    const doc = new Document();
    const buffer = doc.createBuffer();
    const position = doc.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer);
    const index = doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(indices)).setBuffer(buffer);
    const prim = doc.createPrimitive().setMode(TRIANGLES).setAttribute('POSITION', position).setIndices(index);
    doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)));

    // Quantize positions to 16-bit and Meshopt-compress (entropy coding on top of
    // the quantization). GLTFLoader + MeshoptDecoder undo both at load time.
    await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high', quantizePosition: 16 }));

    const glb = await io.writeBinary(doc);
    await mkdir(dirname(OUTPUT), { recursive: true });
    await writeFile(OUTPUT, glb);

    console.log(`Wrote ${OUTPUT}: ${positions.length / 3} verts, ${indices.length / 3} tris, ${glb.byteLength} bytes`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
