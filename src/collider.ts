import * as THREE from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Triangle-mesh collider geometry in world space: flat xyz position triples and
 * triangle indices — the shape crashcat's static collider wants.
 *
 * Loaded from public/collider.glb (built by scripts/build-collision-mesh-glb.ts), which is
 * position-quantized (KHR_mesh_quantization) + Meshopt-compressed
 * (EXT_meshopt_compression). GLTFLoader + MeshoptDecoder undo both, so here we
 * just read the decoded geometry back into flat arrays.
 */
export type Collider = {
    positions: Float32Array; // world-space xyz triples
    indices: Uint32Array;
};

export async function loadColliderGLB(url: string): Promise<Collider> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(url);
    gltf.scene.updateMatrixWorld(true);

    const positions: number[] = [];
    const indices: number[] = [];
    let base = 0;
    const v = new THREE.Vector3();

    gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const pos = mesh.geometry.getAttribute('position');
        // Bake the mesh's world matrix into each vertex. quantize() folds its
        // dequant scale/offset into the node transform, so applying matrixWorld
        // both un-quantizes and world-places the verts (WORLD_SCALE was baked into
        // the coordinates at build time, before quantization).
        for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
            positions.push(v.x, v.y, v.z);
        }
        const idx = mesh.geometry.getIndex();
        if (idx) {
            for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + base);
        } else {
            for (let i = 0; i < pos.count; i++) indices.push(base + i);
        }
        base += pos.count;
    });

    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}
