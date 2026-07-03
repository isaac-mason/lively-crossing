import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import type { Vec3 } from 'mathcat';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { EYE_HEIGHT, initCharacter, updateCharacter } from './character';
import { type Collider, unpackCollider } from './collider-schema';
import { getMoveDirection, initFirstPersonControls, releaseFirstPersonControls, updateFirstPersonCamera } from './controls';
import { initCrowd, spawnCrowd, updateCrowdMeshes } from './crowd';
import { attachDebugRaycast, createDebugOverlay, updateDebugOverlay, updatePhysicsDebug } from './debug';
import { initNavigation, loadNavigation, updateCrowd, updateNavigation } from './navigation';
import { applyPerformance, getSparkQualityOptions, initPerformance } from './performance';
import { createSplatCollider, initPhysics, updatePhysics } from './physics';
import { CAMERA_POSITION, CAMERA_TARGET, COLLIDER_URL, SPLAT_URL } from './scene';
import { WORLD_SCALE } from './world-scale';
import './style.css';

function init() {
    const scene = new THREE.Scene();

    // Fill light for any standard-material meshes added later. Spark splats are
    // self-lit and ignore three lights, so this only affects non-splat meshes.
    scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x202028, 0.8);
    scene.add(hemi);

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]);

    // antialias: false is recommended for Spark — MSAA doesn't help splats and costs perf.
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    const app = document.querySelector<HTMLDivElement>('#app') ?? document.body;
    app.appendChild(renderer.domElement);

    // SparkRenderer drives splat sorting and LOD streaming/updates for the .rad file.
    // Widen the LOD foveation cone so splats near the screen corners stay full-res
    // (defaults: coneFov0 90, coneFov 120, coneFoveate 0.4).
    const spark = new SparkRenderer({
        renderer,
        coneFov0: 120,
        coneFov: 160,
        coneFoveate: 0.5,
        // Per-platform LOD paging + spread budget (iOS < other mobile < desktop).
        ...getSparkQualityOptions(),
    });
    scene.add(spark);

    const splat = new SplatMesh({ url: encodeURI(SPLAT_URL) });
    // Shrink the splat to human scale; collider + navmesh are baked at the same
    // scale (see src/world-scale.ts) so everything lines up.
    splat.scale.setScalar(WORLD_SCALE);
    scene.add(splat);

    // Orbit camera — used only in the debug "orbit camera" mode; starts disabled
    // so the first-person controller drives the camera by default.
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);
    controls.enabled = false;
    controls.update();

    // Runtime perf/quality settings (LOD budget, …); the debug panel tweaks these.
    const perf = initPerformance();

    // Debug panel: toggle with the backtick (`) key. Orbit/character mode toggle,
    // physics/navmesh wireframes, LOD slider, click-to-raycast, and a readout.
    const debug = createDebugOverlay(perf);
    scene.add(debug.physicsLines);
    scene.add(debug.raycastMarker);
    attachDebugRaycast(debug, camera, scene, renderer.domElement);

    const physics = initPhysics();

    const navigation = initNavigation();

    // Stand-in pedestrian crowd (navcat agents + capsule meshes); populated in
    // load() once the navmesh is ready.
    const crowd = initCrowd();

    // First-person character: a KCC capsule the player walks around the ship with,
    // plus pointer-lock mouse look + WASD. Click the canvas to capture the mouse.
    const character = initCharacter(physics);
    const fp = initFirstPersonControls(camera, renderer.domElement);

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return {
        scene,
        camera,
        renderer,
        spark,
        splat,
        controls,
        perf,
        debug,
        physics,
        navigation,
        crowd,
        character,
        fp,
        orbitActive: false, // tracks debug.orbitMode to detect mode switches
        collider: null as Collider | null,
    };
}

type State = ReturnType<typeof init>;

async function loadCollider(url: string): Promise<Collider> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to load collider (${res.status}): ${url}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return unpackCollider(bytes);
}

async function load(state: State) {
    // Wait for the splat to finish downloading/decoding before the first frame.
    await state.splat.initialized;

    state.collider = await loadCollider(COLLIDER_URL);
    console.log(`collider loaded: ${state.collider.positions.length / 3} verts, ${state.collider.indices.length / 3} tris`);

    // Add the scene geometry to the physics world as a static triangle mesh.
    createSplatCollider(state.physics, state.collider);

    await loadNavigation(state.navigation);

    // Now that the navmesh exists, drop the stand-in pedestrians onto it.
    spawnCrowd(state.crowd, state.navigation, state.scene);
}

const _moveDir: Vec3 = [0, 0, 0];
const _orbitDir = new THREE.Vector3();
const ORBIT_PULLBACK = 5; // metres to pull the orbit camera back off the character's head

// Apply a switch between first-person and orbit camera modes (driven by the debug
// panel's "orbit camera" checkbox).
function syncCameraMode(state: State) {
    if (state.debug.orbitMode === state.orbitActive) return;
    state.orbitActive = state.debug.orbitMode;

    if (state.orbitActive) {
        // → orbit: release the mouse and orbit around the character's head. Pull the
        // camera back along its current look direction first — otherwise it sits ON
        // the target (zero radius) and OrbitControls has nothing to orbit around.
        state.fp.enabled = false;
        releaseFirstPersonControls(state.fp);
        const f = state.character.kcc.position;
        state.controls.target.set(f[0], f[1] + EYE_HEIGHT, f[2]);
        state.camera.getWorldDirection(_orbitDir);
        state.camera.position.copy(state.controls.target).addScaledVector(_orbitDir, -ORBIT_PULLBACK);
        state.controls.enabled = true;
        state.controls.update();
    } else {
        // → first-person: OrbitControls off, character drives the camera again.
        state.controls.enabled = false;
        state.fp.enabled = true;
    }
}

function update(state: State, dt: number, _time: number) {
    syncCameraMode(state);
    updateCrowd(state.navigation, dt);
    updateCrowdMeshes(state.crowd, state.navigation);

    // Step the character first (sweeps against the world), then the dynamics, then
    // follow with the camera — mirrors crashcat's example ordering.
    if (state.fp.enabled) {
        getMoveDirection(state.fp, _moveDir);
        updateCharacter(state.physics, state.character, _moveDir, state.fp.input.jump, dt);
    }
    updatePhysics(state.physics, dt);

    if (state.fp.enabled) {
        updateFirstPersonCamera(state.fp, state.character.kcc.position);
    } else {
        state.controls.update();
    }

    // Push runtime perf settings (LOD budget, …) onto the renderer.
    applyPerformance(state.perf, state.spark);
    updateDebugOverlay(state.debug, state.camera, state.character, state.spark);
    updatePhysicsDebug(state.debug, state.physics.world);
    updateNavigation(state.navigation, state.scene, state.debug.showNavMesh);
    state.renderer.render(state.scene, state.camera);
}

// Fade out + remove the loading overlay once everything's ready.
function hideLoading() {
    const el = document.getElementById('loading');
    if (!el) return;
    el.classList.add('hidden');
    setTimeout(() => el.remove(), 700); // after the CSS fade
}

// `splat.initialized` only means the file is decoded — the splats aren't on
// screen until Spark has sorted them and streamed in the LOD pages. The render
// loop drives that, and `spark.activeSplats` climbs from 0 as splats become
// renderable. So we run the loop with the overlay still up and lift it once that
// count crosses a fraction of the model's total. Expressed as a fraction (not a
// raw count) so it scales if the asset changes; timeout is a backstop in case
// frustum culling / LOD plateaus the count below the threshold.
const SPLAT_READY_FRACTION = 0.8; // lift once this share of the model's splats are rendered
const SPLAT_WAIT_TIMEOUT_MS = 10000; // ... but never keep the loader up longer than this

async function start() {
    const state = init();
    await load(state);

    let lastTime = performance.now();
    let elapsed = 0;

    let loaderUp = true;
    const startedAt = performance.now();

    function loop() {
        const now = performance.now();
        const dt = (now - lastTime) / 1000;
        lastTime = now;
        elapsed += dt;
        update(state, dt, elapsed); // renders the frame, which drives Spark's sort + LOD streaming

        if (loaderUp) {
            const active = state.spark.activeSplats;
            const total = state.splat.numSplats;
            const ready = total > 0 && active >= total * SPLAT_READY_FRACTION;
            if (ready || now - startedAt >= SPLAT_WAIT_TIMEOUT_MS) {
                loaderUp = false;
                console.log(`splats ready: ${active}/${total} active${ready ? '' : ' (timed out)'}`);
                hideLoading();
            }
        }
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

start();
