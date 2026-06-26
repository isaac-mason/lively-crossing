import type { Vec3 } from 'mathcat';
import * as THREE from 'three';

import { addCrowdAgent, isAgentAtTarget, makeAgentParams, type Navigation, setAgentTarget, snapToNavMesh } from './navigation';

// --- Pedestrian dimensions (metres) — stand-in capsules, same scale as the player ---
const PED_RADIUS = 0.3;
const PED_HEIGHT = 1.8;
const PED_SPEED = 0.9; // unhurried stroll (m/s)

const PED_COUNT = 30;
const ARRIVAL_THRESHOLD = 0.6; // how close (m) counts as "reached the waypoint"
const SPAWN_JITTER = 1.5; // random lateral spread (m) so spawns don't perfectly stack on the route line

// Waypoint network (world space). Pedestrians wander between these: on reaching
// one they pick a random *different* waypoint to head to next, so the crowd
// spreads across the whole intersection rather than shuttling one line.
const WAYPOINTS: Vec3[] = [
    [-28.76, 1.45, -10.27],
    [19.42, 2.24, -7.77],
    [-13.64, 0.87, -10.01],
    [-7.23, 0.97, -7.63],
    [-9.03, 1.34, 2.21],
    [1.49, 1.36, 1.29],
    [15.69, 0.85, -3.25],
];

type Pedestrian = {
    agentId: string;
    mesh: THREE.Mesh;
    targetIndex: number; // which waypoint it's currently walking toward
};

export type Crowd = {
    pedestrians: Pedestrian[];
};

export function initCrowd(): Crowd {
    return { pedestrians: [] };
}

// A random waypoint index other than `exclude`, so a pedestrian always heads
// somewhere new rather than re-picking the point it just left.
function pickWaypoint(exclude: number): number {
    if (WAYPOINTS.length < 2) return 0;
    let idx = Math.floor(Math.random() * (WAYPOINTS.length - 1));
    if (idx >= exclude) idx++;
    return idx;
}

// Spawn the stand-in crowd: capsule meshes + navcat agents, each starting near a
// waypoint and walking to a random other one. Call once after the navmesh loads.
export function spawnCrowd(crowd: Crowd, navigation: Navigation, scene: THREE.Scene): void {
    // A capsule's cylinder section is the full height minus a radius hemisphere
    // at each end (matches the player capsule in character.ts).
    const cylinderLength = PED_HEIGHT - 2 * PED_RADIUS;
    const geometry = new THREE.CapsuleGeometry(PED_RADIUS, cylinderLength, 4, 12);

    const params = makeAgentParams(PED_RADIUS, PED_HEIGHT, PED_SPEED);

    for (let i = 0; i < PED_COUNT; i++) {
        // Spread the spawn across waypoints (round-robin), with a little lateral
        // jitter so peds sharing a start point don't perfectly stack.
        const homeIndex = i % WAYPOINTS.length;
        // Each agent needs its OWN position array: navcat's crowd stores the
        // array by reference (and writes the snapped point back into it), so a
        // shared scratch buffer would make every agent alias the same position.
        const home = WAYPOINTS[homeIndex];
        const spawn: Vec3 = [
            home[0] + (Math.random() - 0.5) * 2 * SPAWN_JITTER,
            home[1],
            home[2] + (Math.random() - 0.5) * 2 * SPAWN_JITTER,
        ];
        if (!snapToNavMesh(navigation, spawn, spawn)) continue;

        const agentId = addCrowdAgent(navigation, spawn, params);
        if (!agentId) continue;

        // Distinct hue per pedestrian so the stand-ins are easy to tell apart.
        const material = new THREE.MeshStandardMaterial({
            color: new THREE.Color().setHSL((i / PED_COUNT) % 1, 0.6, 0.55),
        });
        const mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);

        // Head off to a random waypoint that isn't the one we spawned at.
        const targetIndex = pickWaypoint(homeIndex);
        setAgentTarget(navigation, agentId, WAYPOINTS[targetIndex]);

        crowd.pedestrians.push({ agentId, mesh, targetIndex });
    }
}

// Per-frame: copy each agent's navmesh position onto its capsule, and when an
// agent reaches its waypoint, send it off to a random new one.
export function updateCrowdMeshes(crowd: Crowd, navigation: Navigation): void {
    for (const ped of crowd.pedestrians) {
        const agent = navigation.crowd?.agents[ped.agentId];
        if (!agent) continue;

        // Agent position is at the feet (on the navmesh); the capsule mesh is
        // centred, so lift it half its height to stand on the ground.
        ped.mesh.position.set(agent.position[0], agent.position[1] + PED_HEIGHT / 2, agent.position[2]);

        if (isAgentAtTarget(navigation, ped.agentId, ARRIVAL_THRESHOLD)) {
            ped.targetIndex = pickWaypoint(ped.targetIndex);
            setAgentTarget(navigation, ped.agentId, WAYPOINTS[ped.targetIndex]);
        }
    }
}
