import type { Vec3 } from 'mathcat';

import { addCrowdAgent, isAgentAtTarget, makeAgentParams, type Navigation, setAgentTarget, snapToNavMesh } from './navigation';
import { groundHeight, type Physics } from './physics';

// Character model variants to populate the crowd with (data only — the visual
// system, character-visuals.ts, maps these to GLB files). Flat/low-poly set.
export const CHARACTER_VARIANTS = [
    'Male_Casual',
    'Male_Shirt',
    'Male_Suit',
    'Male_LongSleeve',
    'Female_Casual',
    'Female_Dress',
    'Female_TankTop',
    'Female_Alternative',
];

// Hand-authored footpath routes (world space). Pedestrians walk end-to-end along
// one of these and ping-pong back, so they follow the sidewalks and never cut
// across the road. Keep waypoints close enough that the navmesh shortest-path
// between them hugs the footpath.
const PATHS: Vec3[][] = [
    [
        [-20.51, -0.51, -1.37],
        [-7.5, -0.18, 2.63],
        [7.54, -0.29, 2.2],
        [10.71, -0.37, 1.37],
    ],
    [
        [15.44, -0.84, -2.13],
        [10.69, -0.51, -11.57],
        [-1.05, 0.89, -7.83],
        [-14.3, -0.9, -9.11],
    ],
    [
        [-8.63, -0.21, 2.56],
        [-4.91, -0.31, -8.06],
        [3.77, 0.01, 2.42],
        [-8.19, -0.21, 2.34],
    ],
];

// --- Pedestrian tuning ---
const PED_RADIUS = 0.3;
const PED_HEIGHT = 1.8;
const PED_SPEED = 1.3; // brisk stroll (m/s), the average across the crowd. Kept near
// WALK_CLIP_SPEED (character-visuals.ts) so the walk clip plays ~1x — its natural,
// non-slow-motion cadence. Real walking is ~1.3-1.4 m/s.
const PED_SPEED_VARIANCE = 0.15; // ±15% per-pedestrian, so the crowd doesn't move in lockstep
// Per-instance recolor (character-visuals.ts) tints each pedestrian's clothing/
// hair/skin, so mesh repeats read as different people — we can run well past the
// base-model count without visible duplicates.
const PED_COUNT = 30;
const ARRIVAL_THRESHOLD = 0.6; // how close (m) counts as "reached the waypoint"
// Below this speed (m/s) the velocity direction is mostly jitter, so we keep the
// last heading instead of re-aiming. Set near the idle cutoff (WALK_EXIT_SPEED in
// character-visuals.ts) so a stationary/crawling pedestrian holds a steady facing
// rather than spinning to chase noise.
const FACING_MIN_SPEED = 0.3;
// Anti-stalemate: an agent creeping below STUCK_SPEED while still short of its
// target for STUCK_RECOVER_TIME seconds gets its target re-issued, forcing navcat
// to replan a corridor around whatever it's jammed against. The re-issue is
// desynced (see below) so a deadlocked pair doesn't recover in lockstep and
// immediately re-lock.
const STUCK_SPEED = 0.08; // m/s below which a not-yet-arrived agent counts as stalled
const STUCK_RECOVER_TIME = 1.2; // seconds stalled before forcing a replan
// Escalation: if re-issuing the target doesn't help after this many consecutive
// replans (~ABANDON_AFTER * STUCK_RECOVER_TIME seconds of never reaching the next
// waypoint), the agent gives up on its route entirely and reroutes onto a fresh
// path (see pickNewPath) — the reliable way out of a spot the corridor replan
// can't fix (e.g. a jammed doorway or a persistent head-on knot).
const ABANDON_AFTER = 5;

// Data-only character record. The visual system reads these; it holds NO three.js.
export type Character = {
    id: string; // == navcat agent id
    variant: string; // which model to draw
    scale: number; // per-instance size multiplier (height variety)
    position: Vec3; // feet, world space
    facing: number; // travel-direction yaw (radians), model-agnostic
    speed: number; // m/s (drives idle<->walk)
    // --- sim bookkeeping (plain data) ---
    prev: Vec3; // previous position (for velocity)
    pathIndex: number; // which footpath route
    wpIndex: number; // waypoint currently walking toward
    dir: number; // +1 forward along the path, -1 back
    stuckTime: number; // seconds spent stalled short of the target (anti-deadlock)
    stuckReplans: number; // consecutive failed replans; triggers a reroute past ABANDON_AFTER
};

export type Characters = {
    list: Character[];
};

export function initCharacters(): Characters {
    return { list: [] };
}

// Advance to the next waypoint along the path, reversing at either end, and send
// the agent there.
function advancePath(navigation: Navigation, ch: Character): void {
    const path = PATHS[ch.pathIndex];
    let next = ch.wpIndex + ch.dir;
    if (next < 0 || next >= path.length) {
        ch.dir = -ch.dir;
        next = ch.wpIndex + ch.dir;
    }
    ch.wpIndex = next;
    setAgentTarget(navigation, ch.id, path[next]);
}

// Abandon the current route and switch to a different one, aiming at whichever of
// its waypoints is nearest so the hand-off reads as "changed their mind" rather
// than a teleport. Used as the last-resort escape when replanning keeps failing.
function pickNewPath(navigation: Navigation, ch: Character): void {
    let newIndex = ch.pathIndex;
    if (PATHS.length > 1) {
        while (newIndex === ch.pathIndex) newIndex = Math.floor(Math.random() * PATHS.length);
    }
    ch.pathIndex = newIndex;

    const path = PATHS[newIndex];
    let nearest = 0;
    let nearestDist = Infinity;
    for (let k = 0; k < path.length; k++) {
        const dx = path[k][0] - ch.position[0];
        const dz = path[k][2] - ch.position[2];
        const d = dx * dx + dz * dz;
        if (d < nearestDist) {
            nearestDist = d;
            nearest = k;
        }
    }
    ch.wpIndex = nearest;
    ch.dir = Math.random() < 0.5 ? 1 : -1; // then wander either way along the new route
    setAgentTarget(navigation, ch.id, path[nearest]);
}

// Create the navcat agents + Character data records. Distributes pedestrians
// across the footpaths, each starting somewhere along its path in a random
// direction. Call once after the navmesh loads.
export function spawnCharacters(characters: Characters, navigation: Navigation): void {
    for (let i = 0; i < PED_COUNT; i++) {
        // Give each pedestrian its own walk speed (±PED_SPEED_VARIANCE) so they
        // drift apart instead of marching in step. Own params per agent — navcat
        // reads maxSpeed/maxAcceleration off it live.
        const speed = PED_SPEED * (1 + (Math.random() * 2 - 1) * PED_SPEED_VARIANCE);
        const params = makeAgentParams(PED_RADIUS, PED_HEIGHT, speed);

        const pathIndex = i % PATHS.length; // spread evenly across the routes
        const path = PATHS[pathIndex];
        const startIdx = Math.floor(Math.random() * path.length);

        // Each agent needs its OWN array — navcat stores it by reference.
        const spawn: Vec3 = [path[startIdx][0], path[startIdx][1], path[startIdx][2]];
        if (!snapToNavMesh(navigation, spawn, spawn)) continue;

        const agentId = addCrowdAgent(navigation, spawn, params);
        if (!agentId) continue;

        const ch: Character = {
            id: agentId,
            variant: CHARACTER_VARIANTS[i % CHARACTER_VARIANTS.length], // recolor makes repeats distinct
            scale: 0.92 + Math.random() * 0.16, // ±8% height variety
            position: [spawn[0], spawn[1], spawn[2]],
            facing: 0,
            speed: 0,
            prev: [spawn[0], spawn[1], spawn[2]],
            pathIndex,
            wpIndex: startIdx,
            dir: Math.random() < 0.5 ? 1 : -1, // start toward either end
            stuckTime: 0,
            stuckReplans: 0,
        };
        advancePath(navigation, ch); // aim at the first waypoint
        characters.list.push(ch);
    }
}

// Per-frame: pull each agent's navmesh position/velocity into its Character data
// and, on arrival, step to the next waypoint along its path. Pure data — no
// meshes touched. Run after the navcat crowd step (navigation.updateCrowd).
export function updateCharacters(characters: Characters, navigation: Navigation, physics: Physics, dt: number): void {
    for (const ch of characters.list) {
        const agent = navigation.crowd?.agents[ch.id];
        if (!agent) continue;

        const px = agent.position[0];
        const py = agent.position[1];
        const pz = agent.position[2];
        const dx = px - ch.prev[0];
        const dz = pz - ch.prev[2];

        ch.speed = dt > 1e-5 ? Math.hypot(dx, dz) / dt : 0;
        if (ch.speed > FACING_MIN_SPEED) ch.facing = Math.atan2(dx, dz);
        ch.position[0] = px;
        // The navmesh Y is a coarse walkable height; raycast the real collider to
        // plant feet on the actual surface (curbs, slopes), falling back to the
        // navmesh height where the ray misses.
        ch.position[1] = groundHeight(physics, px, pz, py) ?? py;
        ch.position[2] = pz;
        ch.prev[0] = px;
        ch.prev[1] = py; // horizontal-only speed/facing, so prev Y is unused
        ch.prev[2] = pz;

        if (isAgentAtTarget(navigation, ch.id, ARRIVAL_THRESHOLD)) {
            advancePath(navigation, ch);
            ch.stuckTime = 0;
            ch.stuckReplans = 0; // made progress — clear the give-up counter
            continue;
        }

        // Not there yet: if we've been crawling in place, we're likely jammed
        // against another agent.
        if (ch.speed < STUCK_SPEED) {
            ch.stuckTime += dt;
            if (ch.stuckTime > STUCK_RECOVER_TIME) {
                ch.stuckReplans++;
                if (ch.stuckReplans >= ABANDON_AFTER) {
                    // Replanning the current route keeps failing — bail out and
                    // take a different path entirely.
                    pickNewPath(navigation, ch);
                    ch.stuckReplans = 0;
                } else {
                    // First just re-issue the current waypoint to force a corridor
                    // replan around whatever we're jammed against.
                    setAgentTarget(navigation, ch.id, PATHS[ch.pathIndex][ch.wpIndex]);
                }
                // Reset to a small random negative so a deadlocked pair's next
                // recovery fires at different times, breaking the symmetry instead
                // of re-locking in step.
                ch.stuckTime = -Math.random() * 0.5;
            }
        } else {
            ch.stuckTime = 0;
            ch.stuckReplans = 0; // moving again — no longer a candidate to reroute
        }
    }
}
