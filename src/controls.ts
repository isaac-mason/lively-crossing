import type { Vec3 } from 'mathcat';
import type * as THREE from 'three';

import { EYE_HEIGHT } from './character';
import { CHARACTER_LOOK_TARGET, CHARACTER_SPAWN } from './scene';

const LOOK_SENSITIVITY = 0.0022; // radians per pixel of mouse movement
const PITCH_LIMIT = Math.PI / 2 - 0.05; // stop just short of straight up/down

export type FirstPersonControls = {
    camera: THREE.PerspectiveCamera;
    domElement: HTMLElement;
    /** Whether this controller is the active camera driver (vs. orbit mode). */
    enabled: boolean;
    /** Is the pointer currently locked (mouse driving the look)? */
    locked: boolean;
    yaw: number;
    pitch: number;
    input: {
        forward: boolean;
        backward: boolean;
        left: boolean;
        right: boolean;
        jump: boolean;
    };
};

// Initial look angles from the spawn → look-target direction (see scene.ts).
function initialAngles(): { yaw: number; pitch: number } {
    const dx = CHARACTER_LOOK_TARGET[0] - CHARACTER_SPAWN[0];
    const dy = CHARACTER_LOOK_TARGET[1] - (CHARACTER_SPAWN[1] + EYE_HEIGHT);
    const dz = CHARACTER_LOOK_TARGET[2] - CHARACTER_SPAWN[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    // Forward (yaw only) is (-sin yaw, 0, -cos yaw); pitch lifts it on the up axis.
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.asin(Math.max(-1, Math.min(1, dy / len)));
    return { yaw, pitch };
}

export function initFirstPersonControls(camera: THREE.PerspectiveCamera, domElement: HTMLElement): FirstPersonControls {
    const { yaw, pitch } = initialAngles();

    const controls: FirstPersonControls = {
        camera,
        domElement,
        enabled: true,
        locked: false,
        yaw,
        pitch,
        input: { forward: false, backward: false, left: false, right: false, jump: false },
    };

    // Click the canvas to capture the mouse (first-person mode only).
    domElement.addEventListener('click', () => {
        if (controls.enabled && !controls.locked) domElement.requestPointerLock();
    });

    document.addEventListener('pointerlockchange', () => {
        controls.locked = document.pointerLockElement === domElement;
    });

    document.addEventListener('mousemove', (e) => {
        if (!controls.locked) return;
        controls.yaw -= e.movementX * LOOK_SENSITIVITY;
        controls.pitch -= e.movementY * LOOK_SENSITIVITY;
        controls.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, controls.pitch));
    });

    const setKey = (code: string, down: boolean): boolean => {
        switch (code) {
            case 'KeyW':
            case 'ArrowUp':
                controls.input.forward = down;
                return true;
            case 'KeyS':
            case 'ArrowDown':
                controls.input.backward = down;
                return true;
            case 'KeyA':
            case 'ArrowLeft':
                controls.input.left = down;
                return true;
            case 'KeyD':
            case 'ArrowRight':
                controls.input.right = down;
                return true;
            case 'Space':
                controls.input.jump = down;
                return true;
            default:
                return false;
        }
    };

    window.addEventListener('keydown', (e) => {
        if (!controls.enabled) return;
        if (setKey(e.code, true)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
        setKey(e.code, false);
    });

    return controls;
}

// Release the mouse and clear held keys (e.g. when switching to orbit mode).
export function releaseFirstPersonControls(controls: FirstPersonControls): void {
    if (controls.locked) document.exitPointerLock();
    controls.input.forward = false;
    controls.input.backward = false;
    controls.input.left = false;
    controls.input.right = false;
    controls.input.jump = false;
}

// Build the world-space horizontal move direction from yaw + the held keys.
export function getMoveDirection(controls: FirstPersonControls, out: Vec3): Vec3 {
    const f = (controls.input.forward ? 1 : 0) - (controls.input.backward ? 1 : 0);
    const r = (controls.input.right ? 1 : 0) - (controls.input.left ? 1 : 0);
    const sin = Math.sin(controls.yaw);
    const cos = Math.cos(controls.yaw);
    // forward = (-sin, 0, -cos); right = (cos, 0, -sin)
    out[0] = -sin * f + cos * r;
    out[1] = 0;
    out[2] = -cos * f - sin * r;
    return out;
}

// Point the camera at the character's eyes and aim it from yaw/pitch.
export function updateFirstPersonCamera(controls: FirstPersonControls, feet: Vec3): void {
    controls.camera.position.set(feet[0], feet[1] + EYE_HEIGHT, feet[2]);
    controls.camera.rotation.order = 'YXZ';
    controls.camera.rotation.set(controls.pitch, controls.yaw, 0);
}
