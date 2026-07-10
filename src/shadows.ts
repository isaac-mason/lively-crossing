import * as THREE from 'three';

/**
 * Sun shadows for the crowd. Gaussian splats can't cast or receive shadows (Spark
 * renders them outside the standard material pipeline), so this module works around
 * that with a classic shadow-map trick:
 *
 *   - the directional sun casts; the pedestrians (src/character-visuals.ts) are the
 *     only shadow casters,
 *   - the collision mesh (src/collider.ts), which lines up exactly with the world,
 *     is reused as an invisible ShadowMaterial "catcher" so the crowd's shadows
 *     appear to land on the splat floor.
 *
 * The orthographic shadow frustum follows the orbit target each frame (updateShadows)
 * so a modest map stays high-res wherever the user is looking, rather than trying to
 * cover the whole city at once.
 */

const SHADOW_MAP_SIZE = 2048;
const SHADOW_HALF_EXTENT = 40; // world metres the shadow frustum spans around the target
const SUN_OFFSET = new THREE.Vector3(13, 30, 15); // sun position relative to the followed point

// Catcher tuning. depthWrite:false so it doesn't punch holes in the splats drawn
// behind it; the render order puts it in the transparent pass *after* the splats,
// while its depthTest still lets opaque geometry (characters) occlude it.
const SHADOW_CATCHER_OPACITY = 0.3;
const SHADOW_CATCHER_RENDER_ORDER = 1000;

export type Shadows = {
    /** The shadow-casting key light; also the scene's main directional light. */
    sun: THREE.DirectionalLight;
};

// Enable shadow mapping and create the shadow-casting sun. The catcher is attached
// later (attachShadowCatcher) once the collider GLB has loaded.
export function initShadows(scene: THREE.Scene, renderer: THREE.WebGLRenderer): Shadows {
    // PCF soft shadows. Cheap here: only the pedestrians cast; the splats and the
    // collider catcher never enter the shadow pass.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const sun = new THREE.DirectionalLight(0xfff2e0, 2.6);
    sun.position.copy(SUN_OFFSET); // overwritten each frame by updateShadows (target + offset)
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    sun.shadow.bias = -0.0005; // pull shadows back to kill acne on near-flat ground
    sun.shadow.normalBias = 0.02;
    const cam = sun.shadow.camera; // OrthographicCamera
    cam.near = 1;
    cam.far = 160;
    cam.left = cam.bottom = -SHADOW_HALF_EXTENT;
    cam.right = cam.top = SHADOW_HALF_EXTENT;
    cam.updateProjectionMatrix();
    scene.add(sun);
    scene.add(sun.target); // DirectionalLight aims at its target; follow the view

    return { sun };
}

// Turn the loaded collider mesh into the invisible shadow catcher and add it to the
// scene. One shared ShadowMaterial across every mesh (they only ever show a shadow).
export function attachShadowCatcher(scene: THREE.Scene, catcher: THREE.Object3D): void {
    const mat = new THREE.ShadowMaterial({ opacity: SHADOW_CATCHER_OPACITY });
    mat.depthWrite = false;

    catcher.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        // The GLB's own materials are unused — the mesh is invisible except for
        // received shadows.
        const prev = mesh.material;
        for (const m of Array.isArray(prev) ? prev : [prev]) m?.dispose();
        mesh.material = mat;
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.renderOrder = SHADOW_CATCHER_RENDER_ORDER;
    });

    scene.add(catcher);
}

// Re-centre the sun (and thus its shadow frustum) on the point the camera orbits,
// keeping the shadow map tight and high-res near the action while the light
// direction stays fixed (so shadows always fall the same way).
export function updateShadows(shadows: Shadows, target: THREE.Vector3): void {
    shadows.sun.position.copy(target).add(SUN_OFFSET);
    shadows.sun.target.position.copy(target);
    shadows.sun.target.updateMatrixWorld();
}
