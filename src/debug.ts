import type { SparkRenderer } from '@sparkjsdev/spark';
import { debug as ccDebug, kcc, type World } from 'crashcat';
import * as THREE from 'three';

import type { Character } from './character';
import type { Performance } from './performance';

const GROUND_STATE_NAMES: Record<number, string> = {
    [kcc.GroundState.ON_GROUND]: 'on ground',
    [kcc.GroundState.ON_STEEP_GROUND]: 'on steep',
    [kcc.GroundState.NOT_SUPPORTED]: 'not supported',
    [kcc.GroundState.IN_AIR]: 'in air',
};

export type DebugOverlay = {
    element: HTMLDivElement;
    /** Container holding the readout rows. */
    text: HTMLDivElement;
    /** Per-line value spans updated each frame; the coord ones are click-to-copy. */
    fields: {
        mode: HTMLSpanElement;
        cam: HTMLSpanElement;
        feet: HTMLSpanElement;
        ground: HTMLSpanElement;
        hit: HTMLSpanElement;
        splats: HTMLSpanElement;
    };
    /** Whether the text panel is shown (toggled with the backtick key). */
    enabled: boolean;
    /** Whether the physics wireframe is drawn (toggled by the checkbox). */
    showPhysics: boolean;
    /** Whether the navmesh wireframe is drawn (toggled by the checkbox). */
    showNavMesh: boolean;
    /** Camera mode: true = free orbit camera, false = first-person character. */
    orbitMode: boolean;
    /** Line segments rendering the crashcat physics debug wireframe. Add to your scene. */
    physicsLines: THREE.LineSegments;
    /** Raycaster used for click-to-raycast against the scene. */
    raycaster: THREE.Raycaster;
    /** Marker placed at the last raycast hit point. Add to your scene. */
    raycastMarker: THREE.Mesh;
    /** World-space point of the last raycast hit, or null if nothing's been hit. */
    lastHit: THREE.Vector3 | null;
};

function createCheckbox(label: string, onChange: (checked: boolean) => void): HTMLLabelElement {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => onChange(input.checked));
    wrapper.append(input, label);
    return wrapper;
}

// An always-on labelled range slider that reports its value live, with a readout.
function createRange(
    label: string,
    opts: { min: number; max: number; step: number; value: number },
    onChange: (value: number) => void,
): HTMLLabelElement {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(opts.min);
    range.max = String(opts.max);
    range.step = String(opts.step);
    range.value = String(opts.value);
    range.style.width = '80px';
    const readout = document.createElement('span');
    readout.textContent = opts.value.toFixed(2);
    range.addEventListener('input', () => {
        const v = Number(range.value);
        readout.textContent = v.toFixed(2);
        onChange(v);
    });
    wrapper.append(label, range, readout);
    return wrapper;
}

// A monospace readout row: a fixed-width label followed by a value span. The
// caller updates `value.textContent` each frame.
function createReadoutRow(label: string): { row: HTMLDivElement; value: HTMLSpanElement } {
    const row = document.createElement('div');
    const lbl = document.createElement('span');
    lbl.textContent = label.padEnd(8); // align values (monospace + white-space:pre)
    const value = document.createElement('span');
    row.style.cssText = 'white-space:pre';
    row.append(lbl, value);
    return { row, value };
}

// Make a value span click-to-copy: copies its current text to the clipboard and
// briefly flashes white. Used for the Vec3 coordinate readouts.
function makeCopyable(value: HTMLSpanElement): void {
    value.style.cursor = 'pointer';
    value.title = 'click to copy';
    value.addEventListener('click', async () => {
        const text = value.textContent?.trim();
        if (!text || text === '-') return;
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            return; // clipboard blocked (e.g. insecure context) — nothing to flash
        }
        // Flash via colour only; the per-frame textContent update leaves it intact.
        value.style.color = '#fff';
        setTimeout(() => {
            value.style.color = '';
        }, 500);
    });
}

// Minimal debug overlay (plain DOM): a text panel showing the camera position
// (toggle with the backtick `) plus checkboxes toggling debug wireframes.
export function createDebugOverlay(perf: Performance): DebugOverlay {
    const element = document.createElement('div');
    element.style.cssText = [
        'position:fixed',
        'top:8px',
        'left:8px',
        'padding:6px 8px',
        'display:none',
        'flex-direction:column',
        'gap:4px',
        'font:12px/1.4 monospace',
        'color:#0f0',
        'background:rgba(0,0,0,0.6)',
        'z-index:1000',
    ].join(';');

    // Line segments for the physics wireframe. Coloured per-vertex by crashcat.
    const physicsLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true }));
    physicsLines.visible = false;
    physicsLines.frustumCulled = false; // geometry is rebuilt each frame; skip culling

    // Marker drawn at the last raycast hit. Non-raycastable so clicks don't hit it.
    const raycastMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xff3366, depthTest: false }),
    );
    raycastMarker.visible = false;
    raycastMarker.renderOrder = 1000;
    raycastMarker.frustumCulled = false;
    raycastMarker.raycast = () => {};

    // Readout rows. The three Vec3 lines (cam / feet / hit) are click-to-copy.
    const text = document.createElement('div');
    text.style.cssText = 'display:flex;flex-direction:column';
    const modeRow = createReadoutRow('mode');
    const camRow = createReadoutRow('cam');
    const feetRow = createReadoutRow('feet');
    const hitRow = createReadoutRow('hit');
    const splatsRow = createReadoutRow('splats');
    makeCopyable(camRow.value);
    makeCopyable(hitRow.value);
    makeCopyable(feetRow.value);
    // The feet row shows the ground state after the (copyable) coords, so split it
    // into a copyable coord span plus a plain suffix span.
    const groundSpan = document.createElement('span');
    feetRow.row.append(groundSpan);
    text.append(modeRow.row, camRow.row, feetRow.row, hitRow.row, splatsRow.row);

    const overlay: DebugOverlay = {
        element,
        text,
        fields: {
            mode: modeRow.value,
            cam: camRow.value,
            feet: feetRow.value,
            ground: groundSpan,
            hit: hitRow.value,
            splats: splatsRow.value,
        },
        enabled: false,
        showPhysics: false,
        showNavMesh: false,
        orbitMode: false,
        physicsLines,
        raycaster: new THREE.Raycaster(),
        raycastMarker,
        lastHit: null,
    };

    const orbitCheckbox = createCheckbox('orbit camera', (checked) => {
        overlay.orbitMode = checked;
    });

    const physicsCheckbox = createCheckbox('physics debug', (checked) => {
        overlay.showPhysics = checked;
        physicsLines.visible = checked;
    });

    const navmeshCheckbox = createCheckbox('navmesh debug', (checked) => {
        overlay.showNavMesh = checked;
    });

    const lodSlider = createRange('lod scale', { min: 0.2, max: 2, step: 0.05, value: perf.lodScale }, (value) => {
        perf.lodScale = value;
    });

    element.append(orbitCheckbox, physicsCheckbox, navmeshCheckbox, lodSlider, overlay.text);
    document.body.appendChild(element);

    window.addEventListener('keydown', (event) => {
        if (event.key === '`') {
            overlay.enabled = !overlay.enabled;
            element.style.display = overlay.enabled ? 'flex' : 'none';
            // Raycast is a panel feature — hide its marker when the panel closes.
            if (!overlay.enabled) overlay.raycastMarker.visible = false;
        }
    });

    return overlay;
}

// Wire up click-to-raycast against the scene (e.g. the splat). On each click the
// marker jumps to the hit point and overlay.lastHit is updated.
export function attachDebugRaycast(
    overlay: DebugOverlay,
    camera: THREE.Camera,
    scene: THREE.Scene,
    domElement: HTMLElement,
): void {
    const ndc = new THREE.Vector2();

    domElement.addEventListener('click', (event) => {
        if (!overlay.enabled) return; // only raycast while the debug panel is open

        const rect = domElement.getBoundingClientRect();
        ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        overlay.raycaster.setFromCamera(ndc, camera);
        const hit = overlay.raycaster.intersectObjects(scene.children, true)[0];
        if (!hit) return;

        overlay.lastHit = hit.point.clone();
        overlay.raycastMarker.position.copy(hit.point);
        overlay.raycastMarker.visible = true;
    });
}

export function updateDebugOverlay(
    overlay: DebugOverlay,
    camera: THREE.PerspectiveCamera,
    character: Character,
    spark: SparkRenderer,
): void {
    if (!overlay.enabled) return;

    const p = camera.position;
    const c = character.kcc.position;
    const h = overlay.lastHit;
    const ground = GROUND_STATE_NAMES[character.kcc.ground.state] ?? '?';
    const active = spark.activeSplats.toLocaleString();
    const max = spark.maxSplats.toLocaleString();
    const f = overlay.fields;
    f.mode.textContent = overlay.orbitMode ? 'orbit' : 'first-person';
    f.cam.textContent = `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`;
    f.feet.textContent = `${c[0].toFixed(2)}, ${c[1].toFixed(2)}, ${c[2].toFixed(2)}`;
    f.ground.textContent = `  (${ground})`;
    f.hit.textContent = h ? `${h.x.toFixed(2)}, ${h.y.toFixed(2)}, ${h.z.toFixed(2)}` : '-';
    f.splats.textContent = `${active} / ${max}  (lod x${spark.lodSplatScale.toFixed(2)})`;
}

// Rebuild the physics wireframe from the crashcat debug helpers (flat line segments).
export function updatePhysicsDebug(overlay: DebugOverlay, world: World): void {
    if (!overlay.showPhysics) return;

    const { vertices, colors } = ccDebug.bodies(world);
    const geometry = overlay.physicsLines.geometry;
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}
