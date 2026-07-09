import {
    addBroadphaseLayer,
    addObjectLayer,
    type BodyId,
    CastRayStatus,
    castRay,
    createClosestCastRayCollector,
    createDefaultCastRaySettings,
    createWorld,
    createWorldSettings,
    enableCollision,
    type Filter,
    filter,
    MotionType,
    registerAll,
    rigidBody,
    triangleMesh,
    updateWorld,
    type World,
} from 'crashcat';
import type { Vec3 } from 'mathcat';
import type { Collider } from './collider';
import { GRAVITY } from './scene';

// Register all shapes & constraints up front. Simplest during development; swap
// for granular registerShapes/registerConstraints later for better tree-shaking.
registerAll();

const settings = createWorldSettings();

// Earth gravity (shared with the character controller, see scene.ts).
settings.gravity = GRAVITY;

export const BROADPHASE_LAYER_MOVING = addBroadphaseLayer(settings);
export const BROADPHASE_LAYER_NOT_MOVING = addBroadphaseLayer(settings);

export const OBJECT_LAYER_MOVING = addObjectLayer(settings, BROADPHASE_LAYER_MOVING);
export const OBJECT_LAYER_NOT_MOVING = addObjectLayer(settings, BROADPHASE_LAYER_NOT_MOVING);
export const OBJECT_LAYER_GHOST = addObjectLayer(settings, BROADPHASE_LAYER_MOVING);

enableCollision(settings, OBJECT_LAYER_MOVING, OBJECT_LAYER_NOT_MOVING);
enableCollision(settings, OBJECT_LAYER_MOVING, OBJECT_LAYER_MOVING);

export type Physics = {
    world: World;
};

export function initPhysics(): Physics {
    const world = createWorld(settings);
    return { world };
}

// Clamp the frame delta so a long pause (e.g. tab refocus) can't blow up the sim.
const MAX_DELTA = 1 / 30;

export function updatePhysics(physics: Physics, dt: number): void {
    updateWorld(physics.world, undefined, Math.min(dt, MAX_DELTA));
}

/**
 * Add the splat scene's collision geometry as a single static triangle-mesh body.
 * Returns the body id — don't hold the body reference, it's pooled (see crashcat README).
 */
export function createSplatCollider(physics: Physics, collider: Collider): BodyId {
    const shape = triangleMesh.create({
        positions: Array.from(collider.positions),
        indices: Array.from(collider.indices),
    });

    const body = rigidBody.create(physics.world, {
        shape,
        motionType: MotionType.STATIC,
        objectLayer: OBJECT_LAYER_NOT_MOVING,
    });

    return body.id;
}

// Reused scratch for ground raycasts (one per pedestrian per frame — avoid allocs).
const _rayCollector = createClosestCastRayCollector();
const _raySettings = createDefaultCastRaySettings();
let _rayFilter: Filter | null = null;
const _rayOrigin: Vec3 = [0, 0, 0];
const _rayDown: Vec3 = [0, -1, 0];

// Vertical search window around the probe height. The navmesh Y is close to the
// real surface, so a metre up / two down comfortably brackets curbs and slopes.
const GROUND_RAY_UP = 1.0;
const GROUND_RAY_DOWN = 2.0;

/**
 * World-space ground height under (x, z), found by casting a short downward ray at
 * the static collider from `nearY + GROUND_RAY_UP`. Returns the hit Y, or null if
 * nothing is hit in the window (off the mesh, or over a gap) so the caller can fall
 * back to the navmesh height.
 */
export function groundHeight(physics: Physics, x: number, z: number, nearY: number): number | null {
    if (!_rayFilter) _rayFilter = filter.forWorld(physics.world);
    _rayOrigin[0] = x;
    _rayOrigin[1] = nearY + GROUND_RAY_UP;
    _rayOrigin[2] = z;
    const length = GROUND_RAY_UP + GROUND_RAY_DOWN;

    _rayCollector.reset();
    castRay(physics.world, _rayCollector, _raySettings, _rayOrigin, _rayDown, length, _rayFilter);
    if (_rayCollector.hit.status !== CastRayStatus.COLLIDING) return null;
    return _rayOrigin[1] - _rayCollector.hit.fraction * length;
}
