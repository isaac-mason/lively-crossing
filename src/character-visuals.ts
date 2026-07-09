import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

import { CHARACTER_VARIANTS, type Character } from './characters';

const BASE = import.meta.env.BASE_URL;

// Base model calibration: skinned-mesh render size didn't match the baked height,
// so scale up to ~human height here (tune to taste vs the 1.8m player).
const CHARACTER_SCALE = 1.2;

// Model forward axis vs travel direction. These characters face +Z, so 0.
const FACING_OFFSET = 0;

// Lazy vertical nudge for foot placement: the rig's feet sit a touch above the
// navmesh position, so sink the whole visual down a bit to plant them. Tune to taste.
const FOOT_OFFSET_Y = -0.1;

const WALK_ENTER_SPEED = 0.6; // m/s: rise above this to switch Idle -> Walk
const WALK_EXIT_SPEED = 0.1; // m/s: fall below this to switch Walk -> Idle

const BLEND_RATE = 8;

const TURN_RATE = 5;

const WALK_CLIP_SPEED = 1.6;

type Template = { scene: THREE.Object3D; clips: THREE.AnimationClip[] };

type View = {
    root: THREE.Object3D;
    mixer: THREE.AnimationMixer;
    idle: THREE.AnimationAction | null;
    walk: THREE.AnimationAction | null;
    walkWeight: number; // 0 = idle, 1 = walking (smoothed)
    walking: boolean; // latched gait state (hysteresis) driving walkWeight's target
    yaw: number; // current rendered yaw, damped toward the character's facing
};

// The visualization system: owns all three.js for the characters. It reads the
// data-only Character[] (from characters.ts) and creates/updates/removes one animated
// SkinnedMesh per character id. Nothing else in the app touches these meshes.
export type CharacterVisuals = {
    scene: THREE.Scene;
    templates: Map<string, Template>;
    views: Map<string, View>;
};

export function initCharacterVisuals(scene: THREE.Scene): CharacterVisuals {
    return { scene, templates: new Map(), views: new Map() };
}

// Load the GLB templates. Await before the crowd is visible (views are created
// lazily on first update once templates exist).
export async function loadCharacterVisuals(visuals: CharacterVisuals): Promise<void> {
    const loader = new GLTFLoader();
    await Promise.all(
        CHARACTER_VARIANTS.map(async (name) => {
            try {
                const gltf = await loader.loadAsync(`${BASE}characters/${name}.glb`);
                gltf.scene.traverse((o) => {
                    o.frustumCulled = false; // skinned bounds are unreliable -> avoid cull flicker
                });
                visuals.templates.set(name, { scene: gltf.scene, clips: gltf.animations });
            } catch (err) {
                console.warn(`character load failed: ${name}`, err);
            }
        }),
    );
}

// --- Per-instance recolor ---------------------------------------------------
// The models carry no textures — every part is a flat PBR material named by body
// part (Skin, Hair, Shirt, Pants, ...). So each pedestrian is made visually unique
// by cloning its materials and tinting the clothing/hair/skin slots from curated
// palettes. This turns 8 base meshes into an effectively unlimited crowd.
// Palettes are sRGB hex; THREE.Color.setStyle converts to the renderer's linear
// working space, so the swatches read as picked.
const SKIN = ['#f4d0b0', '#e8b892', '#d69f74', '#b87e56', '#8f5a3c', '#6b4228', '#4a2c1a'];
const HAIR = ['#1c1512', '#2e2018', '#4a3220', '#6b4a2a', '#9c7b45', '#c9a86a', '#3d3d3d', '#7a7a7a', '#6e2f24'];
// Tops/outerwear — muted midtones: some colour, but dusty/earthy rather than
// either garish or washed-out pastel.
const TOP = [
    '#cd7f88', // dusty rose
    '#d08a63', // clay
    '#d4b25e', // mustard
    '#88ab84', // sage
    '#5fa1a0', // muted teal
    '#6b8fc0', // denim blue
    '#7d84bb', // slate blue
    '#ab74a2', // mauve
    '#dd8f7c', // warm coral
    '#9aa268', // olive
    '#b3aa9c', // warm grey
    '#e6dcc6', // cream
];
// Bottoms — deeper muted neutrals + denim to anchor the midtone tops.
const BOTTOM = ['#5f7799', '#6b7f96', '#8f877a', '#9a8b76', '#7c7d63', '#6f6f7a', '#a99b6f', '#565660'];
const FOOT = ['#2a2a2a', '#4a4a4a', '#e8e8e8', '#5a3a28', '#7a7a7a', '#c0c0c0'];

// Material name -> palette. Names not listed keep their authored colour (Eyes,
// TieTexture, Details). Same palette across related slots (Hair+Eyebrows,
// Jacket+Shirt) means one colour per category, so each outfit stays coordinated.
const SLOT_PALETTES: Record<string, string[]> = {
    Skin: SKIN,
    Hair: HAIR,
    HairBase: HAIR,
    Eyebrows: HAIR,
    Shirt: TOP,
    Dress: TOP,
    TankTop: TOP,
    Jacket: TOP,
    LightJacket: TOP,
    Pants: BOTTOM,
    Shoes: FOOT,
    Socks: FOOT,
};

const pick = <T>(a: T[]): T => a[(Math.random() * a.length) | 0];

// Tint a freshly-cloned character. One colour per palette-category per instance
// (so hair+eyebrows match, jacket+shirt coordinate). Non-recolorable slots keep
// their shared authored material. SkeletonUtils.clone() shares material refs, so
// we clone the ones we touch — otherwise recoloring one pedestrian recolors all.
function recolorInstance(root: THREE.Object3D): void {
    const chosen = new Map<string[], THREE.Color>(); // palette -> this instance's colour
    const colorFor = (palette: string[]): THREE.Color => {
        let c = chosen.get(palette);
        if (!c) {
            c = new THREE.Color().setStyle(pick(palette));
            chosen.set(palette, c);
        }
        return c;
    };

    root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const wasArray = Array.isArray(mesh.material);
        const mats = (wasArray ? mesh.material : [mesh.material]) as THREE.Material[];
        const out = mats.map((m) => {
            const palette = SLOT_PALETTES[m.name];
            if (!palette) return m; // leave Eyes / Tie / Details as-is
            const nm = m.clone() as THREE.MeshStandardMaterial;
            nm.color.copy(colorFor(palette));
            return nm;
        });
        mesh.material = wasArray ? out : out[0];
    });
}

const findClip = (clips: THREE.AnimationClip[], name: string) => clips.find((c) => c.name === name) ?? null;

function createView(visuals: CharacterVisuals, ch: Character): View | null {
    const tmpl = visuals.templates.get(ch.variant) ?? visuals.templates.values().next().value;
    if (!tmpl) return null;

    const root = cloneSkinned(tmpl.scene);
    root.scale.setScalar(CHARACTER_SCALE * ch.scale);
    recolorInstance(root); // unique clothing/hair/skin per pedestrian
    visuals.scene.add(root);

    const mixer = new THREE.AnimationMixer(root);
    const idleClip = findClip(tmpl.clips, 'Idle') ?? findClip(tmpl.clips, 'Standing');
    const walkClip = findClip(tmpl.clips, 'Walk');
    const idle = idleClip ? mixer.clipAction(idleClip) : null;
    const walk = walkClip ? mixer.clipAction(walkClip) : null;
    // Both play; a random phase keeps the crowd out of lock-step. Start idle and
    // let the first updates blend to walk once the agent actually gets moving.
    if (idle) {
        idle.play();
        idle.time = Math.random() * idleClip!.duration;
        idle.setEffectiveWeight(1);
    }
    if (walk) {
        walk.play();
        walk.time = Math.random() * walkClip!.duration;
        walk.setEffectiveWeight(0);
    }

    return { root, mixer, idle, walk, walkWeight: 0, walking: false, yaw: ch.facing + FACING_OFFSET };
}

// Per-frame: sync the meshes to the character data — spawn views for new ids,
// place/orient/animate existing ones, and drop views whose character is gone.
export function updateCharacterVisuals(visuals: CharacterVisuals, characters: Character[], dt: number): void {
    const alive = new Set<string>();

    for (const ch of characters) {
        alive.add(ch.id);
        let view = visuals.views.get(ch.id);
        if (!view) {
            const created = createView(visuals, ch);
            if (!created) continue; // templates not loaded yet
            visuals.views.set(ch.id, created);
            view = created;
        }

        view.root.position.set(ch.position[0], ch.position[1] + FOOT_OFFSET_Y, ch.position[2]);
        // Damp the yaw toward the target facing along the shortest arc so slow /
        // noisy heading changes turn gracefully instead of snapping.
        const targetYaw = ch.facing + FACING_OFFSET;
        const delta = Math.atan2(Math.sin(targetYaw - view.yaw), Math.cos(targetYaw - view.yaw));
        view.yaw += delta * Math.min(1, TURN_RATE * dt);
        view.root.rotation.y = view.yaw;

        // Latch gait with hysteresis: only flip states when speed crosses the far
        // threshold, so a jittery crawl near the boundary stays put (as Idle).
        if (view.walking ? ch.speed < WALK_EXIT_SPEED : ch.speed > WALK_ENTER_SPEED) {
            view.walking = !view.walking;
        }
        const target = view.walking ? 1 : 0;
        view.walkWeight += (target - view.walkWeight) * Math.min(1, BLEND_RATE * dt);
        view.walk?.setEffectiveWeight(view.walkWeight);
        view.idle?.setEffectiveWeight(1 - view.walkWeight);
        // Match stride cadence to actual speed so the feet don't slide.
        if (view.walk) view.walk.timeScale = THREE.MathUtils.clamp(ch.speed / WALK_CLIP_SPEED, 0.4, 1.6);

        view.mixer.update(dt);
    }

    for (const [id, view] of visuals.views) {
        if (!alive.has(id)) {
            visuals.scene.remove(view.root);
            visuals.views.delete(id);
        }
    }
}
