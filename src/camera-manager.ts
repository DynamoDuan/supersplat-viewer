import {
    type BoundingBox,
    Vec3
} from 'playcanvas';
import { Camera, type CameraFrame } from './cameras/camera';
import { OrbitController } from './cameras/orbit-controller';
import { Annotation } from './settings';
import { Global } from './types';

const tmpCamera = new Camera();

const STORAGE_KEY = 'supersplat_saved_view';

type SavedView = {
    position: [number, number, number];
    angles: [number, number, number];
    distance: number;
    fov: number;
};

const loadSavedView = (): SavedView | null => {
    try {
        const s = localStorage.getItem(STORAGE_KEY);
        console.log('Loading saved view from localStorage:', s);
        if (!s) return null;
        const v = JSON.parse(s) as SavedView;
        if (Array.isArray(v?.position) && Array.isArray(v?.angles) && typeof v?.distance === 'number' && typeof v?.fov === 'number') {
            console.log('Successfully loaded saved view:', v);
            return v;
        }
    } catch (e) {
        console.error('Error loading saved view:', e);
    }
    return null;
};

const saveViewToStorage = (camera: Camera) => {
    const v: SavedView = {
        position: [camera.position.x, camera.position.y, camera.position.z],
        angles: [camera.angles.x, camera.angles.y, camera.angles.z],
        distance: camera.distance,
        fov: camera.fov
    };
    console.log('Saving view to localStorage:', v);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
};

const createCameraFromSavedView = (v: SavedView): Camera => {
    const cam = new Camera();
    cam.position.set(v.position[0], v.position[1], v.position[2]);
    cam.angles.set(v.angles[0], v.angles[1], v.angles[2]);
    cam.distance = v.distance;
    cam.fov = v.fov;
    return cam;
};

const createCamera = (position: Vec3, target: Vec3, fov: number) => {
    const result = new Camera();
    result.look(position, target);
    result.fov = fov;
    return result;
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
        const defaultResetCamera = frameCamera;
        const savedFromStorage = loadSavedView();
        console.log('Initializing camera - savedFromStorage:', savedFromStorage);
        let resetCamera = savedFromStorage ? createCameraFromSavedView(savedFromStorage) : defaultResetCamera;

        const orbit = new OrbitController();
        this.camera.copy(resetCamera);
        console.log('Initial camera position:', this.camera.position, 'angles:', this.camera.angles);
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
            saveViewToStorage(this.camera);
            console.log('Saved current view as reset position (persisted to localStorage)');
        });

        events.on('restoreDefaultResetView', () => {
            this.savedResetCamera = null;
            localStorage.removeItem(STORAGE_KEY);
            resetCamera = defaultResetCamera;
            orbit.goto(defaultResetCamera);
            console.log('Restored default reset view');
        });
    }
}

export { CameraManager };
