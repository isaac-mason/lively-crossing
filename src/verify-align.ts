/**
 * Standalone alignment check (dev only): render the Spark splat together with
 * the baked collider as a single wireframe mesh, under an orbit camera.
 *
 * This is intentionally separate from the main app so we can eyeball whether the
 * voxel-baked collider sits in the same world space as the rendered splat —
 * without crashcat's million-triangle BVH or the physics debug LineSegments,
 * both of which push a headless tab over its memory limit.
 *
 *   pnpm dev  ->  http://localhost:5173/verify-align.html
 *
 * [S] toggle splat   [C] toggle collider
 */
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CROP } from '../scripts/collider-crop';
import { unpackCollider } from './collider-schema';
import { CAMERA_POSITION, CAMERA_TARGET, COLLIDER_URL, SPLAT_URL } from './scene';
import { WORLD_SCALE } from './world-scale';

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 5000);
camera.position.set(CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]);

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const spark = new SparkRenderer({ renderer });
scene.add(spark);

// Splat — rendered at the same WORLD_SCALE the main app uses.
const splat = new SplatMesh({ url: encodeURI(SPLAT_URL) });
splat.scale.setScalar(WORLD_SCALE);
scene.add(splat);

// Log the splat's world-space bounds so we can compare them against the
// collider's (printed below) — a center/size mismatch reveals a coordinate
// flip between splat-transform's output and how Spark renders the splat.
splat.initialized.then(() => {
    // Spark splats aren't standard geometry, so walk the splat centers directly
    // (Spark's coordinate frame) and accumulate a bounding box.
    const box = new THREE.Box3();
    splat.forEachSplat((_i, center) => box.expandByPoint(center));
    const c = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(c);
    box.getSize(size);
    console.log(
        `splat bounds (Spark frame): center ${c.toArray().map((n) => n.toFixed(1))}, size ${size.toArray().map((n) => n.toFixed(1))}`,
    );
    console.log(`splat min ${box.min.toArray().map((n) => n.toFixed(1))} max ${box.max.toArray().map((n) => n.toFixed(1))}`);
});

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);
controls.update();

// Draw the world-space crop box (scripts/collider-crop.ts) so you can see what
// the collider/navmesh bake keeps vs. the full splat. Press [B] to toggle.
let cropBox: THREE.Box3Helper | null = null;
if (CROP) {
    const box = new THREE.Box3(new THREE.Vector3(...CROP.min), new THREE.Vector3(...CROP.max));
    cropBox = new THREE.Box3Helper(box, new THREE.Color(0xffcc00));
    scene.add(cropBox);
}

// Collider — the exact world-space mesh physics uses (WORLD_SCALE already baked
// into collider.bin by scripts/build-collider.ts), drawn as a wireframe so it
// overlays the splat surfaces.
let colliderMesh: THREE.Mesh | null = null;
(async () => {
    const res = await fetch(COLLIDER_URL);
    const collider = unpackCollider(new Uint8Array(await res.arrayBuffer()));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(collider.positions, 3));
    geo.setIndex(new THREE.BufferAttribute(collider.indices, 1));
    colliderMesh = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color: 0x00ff88, wireframe: true, transparent: true, opacity: 0.6 }),
    );
    // collider.bin is already world-frame + cropped (splat-to-collider-glb.ts
    // applies the 180°-about-Y fix and crop), so no transform needed here.
    scene.add(colliderMesh);
    console.log(`collider wireframe: ${collider.positions.length / 3} verts, ${collider.indices.length / 3} tris`);

    // Auto-frame the camera to the collider's bounds so splat + wireframe fill
    // the view (the placeholder CAMERA_POSITION in scene.ts is only a guess).
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (bb) {
        const c = new THREE.Vector3();
        const size = new THREE.Vector3();
        bb.getCenter(c);
        bb.getSize(size);
        const radius = Math.max(size.x, size.y, size.z);
        controls.target.copy(c);
        camera.position.set(c.x + radius * 0.9, c.y + radius * 0.7, c.z + radius * 0.9);
        camera.far = radius * 20;
        camera.updateProjectionMatrix();
        controls.update();
        console.log(
            `collider bounds: center ${c.toArray().map((n) => n.toFixed(1))}, size ${size.toArray().map((n) => n.toFixed(1))}`,
        );
    }
})();

// Live collider Y-nudge so you can eyeball the floor onto the splat and read off
// the offset. The value shown IS the GROUND_OFFSET to bake into build-collider-glb
// (rebuild the collider with GROUND_OFFSET=0 first so this reads directly).
const hud = document.getElementById('hud');
let yNudge = 0;
const showNudge = () => {
    if (hud) {
        hud.textContent =
            `collider Y offset: ${yNudge.toFixed(2)} m   <- bake this as GROUND_OFFSET\n` +
            `[↑/↓] move 5cm   [Shift+↑/↓] 25cm   ·   [S] splat  [C] collider  [B] crop`;
    }
};
showNudge();

window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 's') splat.visible = !splat.visible;
    if (e.key.toLowerCase() === 'c' && colliderMesh) colliderMesh.visible = !colliderMesh.visible;
    if (e.key.toLowerCase() === 'b' && cropBox) cropBox.visible = !cropBox.visible;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const step = (e.shiftKey ? 0.25 : 0.05) * (e.key === 'ArrowUp' ? 1 : -1);
        yNudge += step;
        if (colliderMesh) colliderMesh.position.y = yNudge;
        showNudge();
    }
});

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
});
