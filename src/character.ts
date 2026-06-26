import { capsule, type Filter, filter, type KCC, kcc, transformed } from 'crashcat';
import { quat, type Vec3, vec3, vec4 } from 'mathcat';
import { OBJECT_LAYER_MOVING, type Physics } from './physics';
import { CHARACTER_SPAWN, GRAVITY } from './scene';

// --- Character dimensions (metres) ---
const CHARACTER_HEIGHT = 1.8; // full capsule height, foot to crown (standard adult)
const CHARACTER_RADIUS = 0.3;
// A capsule's total height is its cylinder section plus a radius hemisphere at
// each end, so cylinder = height - 2*radius (and half of that for the shape arg).
const HALF_HEIGHT_OF_CYLINDER = CHARACTER_HEIGHT / 2 - CHARACTER_RADIUS;
/** Camera height above the character's feet (its `position`) — eyes near the crown. */
export const EYE_HEIGHT = CHARACTER_HEIGHT * 0.9;

// --- Movement feel — basic KCC (direct velocity control, no momentum) ---
const MAX_SPEED = 3.0; // ground speed (m/s) while a move key is held
const JUMP_SPEED = 4.5; // upward launch velocity on jump (m/s)
const MAX_SLOPE_ANGLE = (50 * Math.PI) / 180;

export type Character = {
    kcc: KCC;
    filter: Filter;
    updateSettings: kcc.UpdateSettings;
};

export function initCharacter(physics: Physics): Character {
    // Offset the shape so the capsule sits ABOVE the character position (= feet):
    // the capsule centre is half the full height up.
    const shapeOffset = vec3.fromValues(0, CHARACTER_HEIGHT / 2, 0);
    const shape = transformed.create({
        shape: capsule.create({ halfHeightOfCylinder: HALF_HEIGHT_OF_CYLINDER, radius: CHARACTER_RADIUS }),
        position: shapeOffset,
        quaternion: quat.create(),
    });

    const character = kcc.create(
        {
            shape,
            // Inner kinematic body so raycasts/sensors can see the character. It
            // doesn't drive movement — the KCC's own sweeps do.
            innerRigidBody: { shape, objectLayer: OBJECT_LAYER_MOVING },
            up: vec3.fromValues(0, 1, 0),
            maxSlopeAngle: MAX_SLOPE_ANGLE,
            // Supporting plane passes through the bottom hemisphere centre (local space).
            supportingVolumePlane: vec4.fromValues(0, 1, 0, -CHARACTER_RADIUS),
        },
        vec3.fromValues(CHARACTER_SPAWN[0], CHARACTER_SPAWN[1], CHARACTER_SPAWN[2]),
        quat.create(),
    );

    kcc.add(physics.world, character);

    return {
        kcc: character,
        filter: filter.create(physics.world.settings.layers),
        updateSettings: kcc.createDefaultUpdateSettings(),
    };
}

// Scratch vectors — reused each frame to avoid per-frame allocation.
const _up = vec3.create();
const _lin = vec3.create();
const _vertical = vec3.create();
const _horizontal = vec3.create();
const _newVel = vec3.create();

/**
 * Advance the character one step with a basic KCC. `moveDir` is a world-space
 * horizontal wish-direction (y≈0, any magnitude — normalized here); `jump`
 * requests a jump this frame. Horizontal velocity is set directly from the input
 * (no acceleration/friction/momentum), so releasing the keys stops you at once —
 * no sliding around on uneven ground.
 */
export function updateCharacter(physics: Physics, c: Character, moveDir: Vec3, jump: boolean, dt: number): void {
    const character = c.kcc;

    const moveLen = vec3.length(moveDir);
    if (moveLen > 1e-6) vec3.scale(moveDir, moveDir, 1 / moveLen);
    else vec3.zero(moveDir);

    // Account for moving platforms under the character (vertical follow + ground vel).
    kcc.updateGroundVelocity(physics.world, character);

    // Current vertical speed (along up) — preserved for gravity/jump below.
    vec3.copy(_up, character.up);
    vec3.copy(_lin, character.linearVelocity);
    const verticalSpeed = vec3.dot(_lin, _up);

    // Grounded only if we're also settling toward the floor (not launching off it).
    const groundVerticalSpeed = vec3.dot(character.ground.velocity, _up);
    const movingTowardsGround = verticalSpeed - groundVerticalSpeed < 0.1;
    const onGround = character.ground.state === kcc.GroundState.ON_GROUND && movingTowardsGround;
    const willJump = onGround && jump;

    // --- Horizontal: set directly to wish-dir * speed (zero when no input) ---
    vec3.scale(_horizontal, moveDir, MAX_SPEED);

    // --- Vertical: ground stick / jump, then gravity ---
    let newVerticalSpeed = onGround ? groundVerticalSpeed : verticalSpeed;
    if (willJump) newVerticalSpeed += JUMP_SPEED;
    newVerticalSpeed += vec3.dot(GRAVITY, _up) * dt;

    // Recombine horizontal + vertical and hand the velocity to the controller.
    vec3.scale(_vertical, _up, newVerticalSpeed);
    vec3.add(_newVel, _horizontal, _vertical);
    vec3.copy(character.linearVelocity, _newVel);

    // Stair step-up, plus floor-stick — but not on the jump frame, or we'd snap
    // straight back down and never leave the ground.
    vec3.scale(c.updateSettings.walkStairsStepUp, character.up, 0.4);
    if (willJump) vec3.zero(c.updateSettings.stickToFloorStepDown);
    else vec3.scale(c.updateSettings.stickToFloorStepDown, character.up, -0.5);

    kcc.update(physics.world, character, dt, GRAVITY, c.updateSettings, undefined, c.filter);
}
