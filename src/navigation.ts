import {
    addTile,
    createFindNearestPolyResult,
    createNavMesh,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
    findRandomPoint,
    type NavMesh,
    type NavMeshTile,
    type Vec3,
} from 'navcat';
import { crowd } from 'navcat/blocks';
import { createNavMeshHelper, type DebugObject } from 'navcat/three';
import * as THREE from 'three';

import { NAVMESH_URL } from './scene';

const CROWD_MAX_AGENT_RADIUS = 0.4;
// Search box for snapping a world point onto the nearest navmesh poly. Generous
// on Y (±4 m) because hand-picked waypoints (e.g. from a raycast) often sit a
// couple of metres above the walkable surface — the navmesh ground here is at
// y≈-0.7 while street-level picks read ~1.5–2.5.
const FIND_HALF_EXTENTS: Vec3 = [2, 4, 2];

type NavMeshData = {
    origin: Vec3;
    tileWidth: number;
    tileHeight: number;
    tiles: NavMeshTile[];
};

export type Navigation = {
    navMesh: NavMesh | null;
    navMeshHelper: DebugObject | null;
    crowd: crowd.Crowd | null;
};

export function initNavigation(): Navigation {
    return {
        navMesh: null,
        navMeshHelper: null,
        crowd: null,
    };
}

export async function loadNavigation(navigation: Navigation): Promise<void> {
    const res = await fetch(NAVMESH_URL);
    if (!res.ok) throw new Error(`Failed to load navmesh (${res.status})`);

    const data = (await res.json()) as NavMeshData;

    const navMesh = createNavMesh();
    navMesh.origin = data.origin;
    navMesh.tileWidth = data.tileWidth;
    navMesh.tileHeight = data.tileHeight;
    for (const tile of data.tiles) {
        addTile(navMesh, tile);
    }

    navigation.navMesh = navMesh;
    navigation.crowd = crowd.create(CROWD_MAX_AGENT_RADIUS);
    // Default placement tolerance is just maxAgentRadius (tiny) — widen it so an
    // agent snaps onto the navmesh even if its spawn point isn't exactly on a poly.
    navigation.crowd.agentPlacementHalfExtents = [1, 2, 1];
}

/* ---------------- crowd (agent steering / avoidance) ---------------- */

const _nearest = createFindNearestPolyResult();

// Default agent params for a creature of the given radius/height/speed.
export function makeAgentParams(radius: number, height: number, maxSpeed: number): crowd.AgentParams {
    return {
        radius,
        height,
        maxAcceleration: maxSpeed * 8,
        maxSpeed,
        collisionQueryRange: radius * 6,
        separationWeight: 2,
        updateFlags:
            crowd.CrowdUpdateFlags.ANTICIPATE_TURNS |
            crowd.CrowdUpdateFlags.OBSTACLE_AVOIDANCE |
            crowd.CrowdUpdateFlags.SEPARATION |
            crowd.CrowdUpdateFlags.OPTIMIZE_VIS |
            crowd.CrowdUpdateFlags.OPTIMIZE_TOPO,
        // Bias avoidance toward committing to a side and sampling more finely, so
        // two agents meeting head-on veer past each other instead of mirror-matching
        // into a dead stop. `weightSide` (default 0.75) is the main anti-stalemate
        // lever; the extra adaptive rings/depth make the chosen dodge smoother.
        obstacleAvoidance: {
            ...crowd.DEFAULT_OBSTACLE_AVOIDANCE_PARAMS,
            weightSide: 2,
            adaptiveRings: 3,
            adaptiveDepth: 7,
        },
        queryFilter: DEFAULT_QUERY_FILTER,
    };
}

export function addCrowdAgent(navigation: Navigation, position: Vec3, params: crowd.AgentParams): string | null {
    if (!navigation.crowd || !navigation.navMesh) return null;
    return crowd.addAgent(navigation.crowd, navigation.navMesh, position, params);
}

export function removeCrowdAgent(navigation: Navigation, agentId: string): void {
    if (navigation.crowd) crowd.removeAgent(navigation.crowd, agentId);
}

// Snap a world point onto the nearest navmesh poly. Returns false if none is
// within the search box. Also used by recovery (re-grounding an off-mesh creature).
export function snapToNavMesh(navigation: Navigation, point: Vec3, out: Vec3): boolean {
    if (!navigation.navMesh) return false;
    findNearestPoly(_nearest, navigation.navMesh, point, FIND_HALF_EXTENTS, DEFAULT_QUERY_FILTER);
    if (!_nearest.success) return false;
    out[0] = _nearest.position[0];
    out[1] = _nearest.position[1];
    out[2] = _nearest.position[2];
    return true;
}

// Pick a uniformly-random walkable point anywhere on the navmesh (within the
// connected, pruned street network). Writes into `out`; false if no navmesh.
export function randomNavMeshPoint(navigation: Navigation, out: Vec3): boolean {
    if (!navigation.navMesh) return false;
    const res = findRandomPoint(navigation.navMesh, DEFAULT_QUERY_FILTER, Math.random);
    if (!res.success) return false;
    out[0] = res.position[0];
    out[1] = res.position[1];
    out[2] = res.position[2];
    return true;
}

export function getAgent(navigation: Navigation, agentId: string): crowd.Agent | undefined {
    return navigation.crowd?.agents[agentId];
}

export function setAgentMaxSpeed(navigation: Navigation, agentId: string, maxSpeed: number): void {
    const agent = navigation.crowd?.agents[agentId];
    if (agent) agent.maxSpeed = maxSpeed;
}

// Send an agent toward a world point (snapped onto the navmesh).
export function setAgentTarget(navigation: Navigation, agentId: string, target: Vec3): boolean {
    if (!navigation.crowd || !navigation.navMesh) return false;
    findNearestPoly(_nearest, navigation.navMesh, target, FIND_HALF_EXTENTS, DEFAULT_QUERY_FILTER);
    if (!_nearest.success) return false;
    return crowd.requestMoveTarget(navigation.crowd, agentId, _nearest.nodeRef, _nearest.position);
}

export function setAgentVelocity(navigation: Navigation, agentId: string, velocity: Vec3): boolean {
    if (!navigation.crowd) return false;
    return crowd.requestMoveVelocity(navigation.crowd, agentId, velocity);
}

export function isAgentAtTarget(navigation: Navigation, agentId: string, threshold: number): boolean {
    if (!navigation.crowd) return false;
    return crowd.isAgentAtTarget(navigation.crowd, agentId, threshold);
}

export function updateCrowd(navigation: Navigation, dt: number): void {
    if (!navigation.crowd || !navigation.navMesh) return;
    crowd.update(navigation.crowd, navigation.navMesh, dt);
}

export function updateNavigation(navigation: Navigation, scene: THREE.Scene, show: boolean): void {
    if (!navigation.navMesh) return;

    if (show && !navigation.navMeshHelper) {
        const helper = createNavMeshHelper(navigation.navMesh);

        helper.object.traverse((o) => {
            if (o instanceof THREE.Mesh) {
                o.frustumCulled = false;
                o.renderOrder = 999;

                const materials = (Array.isArray(o.material) ? o.material : [o.material]) as THREE.MeshBasicMaterial[];
                for (const mat of materials) {
                    mat.transparent = true;
                    mat.opacity = 0.5;
                    mat.depthWrite = false;
                    mat.depthTest = false;
                }
            }
        });

        scene.add(helper.object);
        navigation.navMeshHelper = helper;
    } else if (!show && navigation.navMeshHelper) {
        scene.remove(navigation.navMeshHelper.object);
        navigation.navMeshHelper.dispose();
        navigation.navMeshHelper = null;
    }
}
