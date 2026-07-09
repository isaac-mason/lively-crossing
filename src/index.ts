import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { initCharacterVisuals, loadCharacterVisuals, updateCharacterVisuals } from './character-visuals';
import { initCharacters, spawnCharacters, updateCharacters } from './characters';
import { type Collider, loadColliderGLB } from './collider';
import { attachDebugRaycast, createDebugOverlay, updateDebugOverlay, updatePhysicsDebug } from './debug';
import { initNavigation, loadNavigation, updateCrowd, updateNavigation } from './navigation';
import { applyPerformance, initPerformance } from './performance';
import { createSplatCollider, initPhysics, updatePhysics } from './physics';
import { CAMERA_POSITION, CAMERA_TARGET, COLLIDER_URL } from './scene';
import { createSplat } from './splat';
import './style.css';

function init() {
    const scene = new THREE.Scene();
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
    scene.add(ambientLight);

    const hemiLight = new THREE.HemisphereLight(0xbfd4ff, 0x505058, 1.4);
    scene.add(hemiLight);

    const sun = new THREE.DirectionalLight(0xfff2e0, 2.6);
    sun.position.set(6, 12, 4);
    scene.add(sun);

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]);

    // antialias: false is recommended for Spark — MSAA doesn't help splats and costs perf.
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    const app = document.querySelector<HTMLDivElement>('#app') ?? document.body;
    app.appendChild(renderer.domElement);

    // SparkRenderer + the scene's SplatMesh (LOD cone, quality budget, world scale).
    const { spark, mesh: splat } = createSplat(scene, renderer);

    // Orbit camera drives the view (the only camera in this example).
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);
    controls.update();

    // Runtime perf/quality settings (LOD budget, …); the debug panel tweaks these.
    const perf = initPerformance();

    // Debug panel: toggle with the backtick (`) key. Orbit/character mode toggle,
    // physics/navmesh wireframes, LOD slider, click-to-raycast, and a readout.
    const debug = createDebugOverlay(perf);
    scene.add(debug.physicsLines);
    scene.add(debug.raycastMarker);
    scene.add(debug.windSpheres);
    attachDebugRaycast(debug, camera, scene, renderer.domElement);

    const physics = initPhysics();

    const navigation = initNavigation();

    // Pedestrians — data/sim only (navcat agents + Character records),
    // populated in load() once the navmesh is ready.
    const characters = initCharacters();
    // Character visuals — the separate rendering system that reads characters.list.
    const characterVisuals = initCharacterVisuals(scene);

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
        characters,
        characterVisuals,
        collider: null as Collider | null,
    };
}

type State = ReturnType<typeof init>;

async function load(state: State) {
    // Wait for the splat to finish downloading/decoding before the first frame.
    await state.splat.initialized;

    state.collider = await loadColliderGLB(COLLIDER_URL);
    console.log(`collider loaded: ${state.collider.positions.length / 3} verts, ${state.collider.indices.length / 3} tris`);

    // Add the scene geometry to the physics world as a static triangle mesh.
    createSplatCollider(state.physics, state.collider);

    await loadNavigation(state.navigation);

    // Now that the navmesh exists, load the character GLBs and drop pedestrians onto it.
    await loadCharacterVisuals(state.characterVisuals);
    spawnCharacters(state.characters, state.navigation);
}

function update(state: State, dt: number, _time: number) {
    updateCrowd(state.navigation, dt);
    updateCharacters(state.characters, state.navigation, state.physics, dt);
    updateCharacterVisuals(state.characterVisuals, state.characters.list, dt);

    updatePhysics(state.physics, dt);
    state.controls.update();

    // Push runtime perf settings (LOD budget, …) onto the renderer.
    applyPerformance(state.perf, state.spark);
    updateDebugOverlay(state.debug, state.camera, state.controls.target, state.spark);
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
