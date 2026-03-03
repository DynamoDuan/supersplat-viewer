import {
    type BoundingBox,
    Mat4,
    Quat,
    Vec3
} from 'playcanvas';

import { vecToAngles } from './core/math';
import { Camera, type CameraFrame } from './cameras/camera';
import { OrbitController } from './cameras/orbit-controller';
import { Annotation } from './settings';
import { Global } from './types';

const tmpCamera = new Camera();
const tmpv = new Vec3();

// Fixed camera for real2sim: pos, rotation matrix, fov.
const FIXED_CAMERA = {
    pos: [0.4214223792319385, 0.5457549945299672, -1.2059909003747704] as [number, number, number],
    rotationMatrix: [
        [0.9786331529531755, 0.03990237507444073, -0.20170511248935927],
        [-0.07133697531067347, 0.9859460257592279, -0.15106776705541258],
        [0.19284239133149841, 0.16222895781272428, 0.9677259825759287]
    ] as [[number, number, number], [number, number, number], [number, number, number]],
    fovy: 44
};

const createCamera = (position: Vec3, target: Vec3, fov: number) => {
    const result = new Camera();
    result.look(position, target);
    result.fov = fov;
    return result;
};

const createFixedCamera = (): Camera => {
    const cam = new Camera();

    cam.position.set(FIXED_CAMERA.pos[0], FIXED_CAMERA.pos[1], FIXED_CAMERA.pos[2]);
    cam.fov = FIXED_CAMERA.fovy;

    const m = FIXED_CAMERA.rotationMatrix;

    // Extract vectors EXACTLY like the gizmo does
    const forward = new Vec3(m[0][2], m[1][2], m[2][2]).normalize();
    const up = new Vec3(m[0][1], m[1][1], m[2][1]).normalize();
    const right = new Vec3(m[0][0], m[1][0], m[2][0]).normalize();

    // Build rotation matrix from these vectors
    // Camera looks in -Z direction, so we need to negate forward
    const mat = new Mat4();
    // Right vector (X axis)
    mat.data[0] = right.x; mat.data[1] = right.y; mat.data[2] = right.z; mat.data[3] = 0;
    // Up vector (Y axis)
    mat.data[4] = up.x; mat.data[5] = up.y; mat.data[6] = up.z; mat.data[7] = 0;
    // Negative forward vector (Z axis) because camera looks in -Z
    mat.data[8] = -forward.x; mat.data[9] = -forward.y; mat.data[10] = -forward.z; mat.data[11] = 0;
    mat.data[12] = 0; mat.data[13] = 0; mat.data[14] = 0; mat.data[15] = 1;

    const quat = new Quat();
    quat.setFromMat4(mat);
    quat.getEulerAngles(cam.angles);

    console.log('=== Fixed Camera Debug ===');
    console.log('Position:', cam.position);
    console.log('Forward:', forward);
    console.log('Up:', up);
    console.log('Right:', right);
    console.log('Angles:', cam.angles);

    cam.distance = 1.0;

    return cam;
};

const createFrameCamera = (bbox: BoundingBox, fov: number) => {
    const sceneSize = bbox.halfExtents.length();
    const distance = sceneSize / Math.sin(fov / 180 * Math.PI * 0.5);
    return createCamera(
        new Vec3(2, 1, 2).normalize().mulScalar(distance).add(bbox.center),
        bbox.center,
        fov
    );
};

class CameraManager {
    update: (deltaTime: number, cameraFrame: CameraFrame) => void;

    camera = new Camera();

    private savedResetCamera: Camera | null = null;

    constructor(global: Global, bbox: BoundingBox) {
        const { events, settings } = global;

        const camera0 = settings.cameras[0].initial;
        const frameCamera = createFrameCamera(bbox, camera0.fov);

        // Use fixed camera as default reset position
        const fixedCamera = createFixedCamera();
        const defaultResetCamera = fixedCamera;
        let resetCamera = defaultResetCamera;

        const orbit = new OrbitController();
        this.camera.copy(resetCamera);
        orbit.onEnter(this.camera);

        const target = new Camera(this.camera);

        this.update = (deltaTime: number, frame: CameraFrame) => {
            orbit.update(deltaTime, frame, target);
            this.camera.copy(target);
        };

        events.on('inputEvent', (eventName) => {
            switch (eventName) {
                case 'frame':
                    orbit.goto(frameCamera);
                    break;
                case 'reset':
                    orbit.goto(this.savedResetCamera || resetCamera);
                    break;
                case 'cancel':
                case 'interrupt':
                    break;
            }
        });

        events.on('pick', (position: Vec3) => {
            tmpCamera.copy(this.camera);
            tmpCamera.look(this.camera.position, position);
            orbit.goto(tmpCamera);
        });

        events.on('annotation.activate', (annotation: Annotation) => {
            const { initial } = annotation.camera;
            tmpCamera.fov = initial.fov;
            tmpCamera.look(
                new Vec3(initial.position),
                new Vec3(initial.target)
            );
            orbit.goto(tmpCamera);
        });

        events.on('saveResetView', () => {
            this.savedResetCamera = new Camera(this.camera);
            console.log('Saved current view as reset position');
        });

        events.on('restoreDefaultResetView', () => {
            this.savedResetCamera = null;
            console.log('Restored default reset view');
        });
    }
}

export { CameraManager };
