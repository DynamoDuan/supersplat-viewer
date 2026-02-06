import {
    type AppBase,
    type Entity,
    GSplatComponent,
    Ray,
    RenderTarget,
    Vec3,
    PROJECTION_ORTHOGRAPHIC
} from 'playcanvas';

const vec = new Vec3();
const vecb = new Vec3();
const ray = new Ray();
const tempVec = new Vec3();
const tempVec2 = new Vec3();

// Convert uint bits to float (for reading position texture)
const uintBitsToFloat = (bits: number): number => {
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);
    view.setUint32(0, bits, true);
    return view.getFloat32(0, true);
};

// get the normalized world-space ray starting at the camera position
// facing the supplied screen position
// works for both perspective and orthographic cameras
const getRay = (camera: Entity, screenX: number, screenY: number, ray: Ray) => {
    const cameraPos = camera.getPosition();

    // create the pick ray in world space
    if (camera.camera.projection === PROJECTION_ORTHOGRAPHIC) {
        camera.camera.screenToWorld(screenX, screenY, -1.0, vec);
        camera.camera.screenToWorld(screenX, screenY, 1.0, vecb);
        vecb.sub(vec).normalize();
        ray.set(vec, vecb);
    } else {
        camera.camera.screenToWorld(screenX, screenY, 1.0, vec);
        vec.sub(cameraPos).normalize();
        ray.set(cameraPos, vec);
    }
};

// Calculate distance from point to ray (similar to annotation.html)
const findClosestPointOnRay = (rayOrigin: Vec3, rayDirection: Vec3, pointPosition: Vec3, pointRadius: number): { distance: number; t: number; point: Vec3 } | null => {
    // Calculate vector from ray origin to point
    tempVec.sub2(pointPosition, rayOrigin);
    const projectionLength = tempVec.dot(rayDirection);
    
    // If projection is behind ray, skip
    if (projectionLength < 0) {
        return null;
    }
    
    // Calculate closest point on ray
    tempVec2.copy(rayOrigin).addScaled(rayDirection, projectionLength);
    
    // Calculate distance
    const distance = tempVec2.distance(pointPosition);
    
    // If distance is within point radius, return distance and projection length
    if (distance <= pointRadius) {
        return {
            distance: distance,
            t: projectionLength,
            point: pointPosition.clone()
        };
    }
    
    return null;
};

class Picker {
    pick: (x: number, y: number) => Promise<Vec3 | null>;
    getClosestPointIndex: (x: number, y: number) => Promise<{ index: number; position: Vec3 } | null>;
    release: () => void;

    private gsplatEntity: Entity | null = null;
    cachedPositions: Vec3[] | null = null;
    positionCacheValid = false;

    constructor(app: AppBase, camera: Entity, gsplatEntity?: Entity) {
        this.gsplatEntity = gsplatEntity || null;

        // Load point positions from texture (cache for performance)
        const loadPositions = async () => {
            if (!this.gsplatEntity || this.positionCacheValid) {
                return;
            }

            const gsplat = this.gsplatEntity.gsplat as GSplatComponent;
            if (!gsplat || !gsplat.instance) {
                return;
            }

            const resource = gsplat.instance.resource;
            const posTexture = (resource as any).transformATexture;
            if (!posTexture) {
                return;
            }

            const texWidth = posTexture.width;
            const texHeight = posTexture.height;
            const numSplats = (resource as any).numSplats || texWidth * texHeight;

            // Read position texture data from GPU
            // Note: Reading from GPU texture is expensive, so we cache the result
            try {
                const { graphicsDevice } = app;
                
                // Create a render target to read from the texture
                const renderTarget = new RenderTarget({
                    colorBuffer: posTexture,
                    depth: false
                });

                // Read pixels from texture (RGBA32UI format: 4 uint32 per pixel)
                const pixels = await posTexture.read(0, 0, texWidth, texHeight, { renderTarget });
                const positions: Vec3[] = [];

                // Parse RGBA32UI format (4 uint32 values per pixel)
                // Each pixel contains: R=x(uint32), G=y(uint32), B=z(uint32), A=w(uint32)
                for (let i = 0; i < numSplats && i < texWidth * texHeight; i++) {
                    const x = i % texWidth;
                    const y = Math.floor(i / texWidth);
                    const pixelIdx = (y * texWidth + x) * 4;

                    // Read 3 uint32 values (x, y, z) and convert to float
                    // pixels is Uint32Array when reading RGBA32UI texture
                    const px = uintBitsToFloat((pixels as Uint32Array)[pixelIdx]);
                    const py = uintBitsToFloat((pixels as Uint32Array)[pixelIdx + 1]);
                    const pz = uintBitsToFloat((pixels as Uint32Array)[pixelIdx + 2]);

                    positions.push(new Vec3(px, py, pz));
                }

                renderTarget.destroy();

                this.cachedPositions = positions;
                this.positionCacheValid = true;
            } catch (error) {
                console.warn('Failed to read position texture (ray-based picking may be unavailable):', error);
                // Fallback: return null to indicate picking is not available
                this.cachedPositions = [];
                this.positionCacheValid = true; // Mark as valid to avoid retrying
            }
        };

        // Load positions asynchronously
        loadPositions();

        this.pick = async (x: number, y: number) => {
            if (!this.gsplatEntity) {
                return null;
            }

            // Ensure positions are loaded
            if (!this.positionCacheValid) {
                await loadPositions();
            }

            if (!this.cachedPositions || this.cachedPositions.length === 0) {
                return null;
            }

            const gsplat = this.gsplatEntity.gsplat as GSplatComponent;
            if (!gsplat) {
                return null;
            }

            const { graphicsDevice } = app;

            // Convert screen coordinates to normalized device coordinates [-1, 1]
            const screenX = (x * 2) - 1;
            const screenY = -((y * 2) - 1); // Flip Y

            // Get ray from camera through screen point
            getRay(camera,
                Math.floor(x * graphicsDevice.canvas.offsetWidth),
                Math.floor(y * graphicsDevice.canvas.offsetHeight),
                ray
            );

            // Get world transform matrix
            const worldMatrix = this.gsplatEntity.getWorldTransform();
            const rayOrigin = ray.origin;
            const rayDirection = ray.direction;

            // Dynamically adjust point radius based on camera distance
            const cameraPos = camera.getPosition();
            const gsplatPos = this.gsplatEntity.getPosition();
            const cameraDistance = cameraPos.distance(gsplatPos);
            const pointRadius = Math.max(0.005, 0.01 * (cameraDistance / 10));

            let closestPoint: Vec3 | null = null;
            let minDistance = Infinity;
            let closestIndex = -1;

            // Iterate through all points to find closest intersection
            // Limit to reasonable number for performance (sample if too many)
            const maxPointsToCheck = 100000; // Limit to 100k points for performance
            const step = this.cachedPositions.length > maxPointsToCheck 
                ? Math.ceil(this.cachedPositions.length / maxPointsToCheck) 
                : 1;

            for (let i = 0; i < this.cachedPositions.length; i += step) {
                const localPos = this.cachedPositions[i];
                
                // Transform to world space
                const worldPos = new Vec3();
                worldMatrix.transformPoint(localPos, worldPos);

                const intersection = findClosestPointOnRay(rayOrigin, rayDirection, worldPos, pointRadius);
                
                if (intersection && intersection.distance < minDistance) {
                    minDistance = intersection.distance;
                    closestPoint = worldPos.clone();
                    closestIndex = i;
                }
            }

            return closestPoint;
        };

        // Get the index of the closest point (for point selection)
        // This returns both the world position and the point index
        this.getClosestPointIndex = async (x: number, y: number): Promise<{ index: number; position: Vec3 } | null> => {
            if (!this.gsplatEntity) {
                return null;
            }

            // Ensure positions are loaded
            if (!this.positionCacheValid) {
                await loadPositions();
            }

            if (!this.cachedPositions || this.cachedPositions.length === 0) {
                return null;
            }

            const gsplat = this.gsplatEntity.gsplat as GSplatComponent;
            if (!gsplat) {
                return null;
            }

            const { graphicsDevice } = app;

            // Get ray from camera through screen point
            getRay(camera,
                Math.floor(x * graphicsDevice.canvas.offsetWidth),
                Math.floor(y * graphicsDevice.canvas.offsetHeight),
                ray
            );

            // Get world transform matrix
            const worldMatrix = this.gsplatEntity.getWorldTransform();
            const rayOrigin = ray.origin;
            const rayDirection = ray.direction;

            // Dynamically adjust point radius based on camera distance
            const cameraPos = camera.getPosition();
            const gsplatPos = this.gsplatEntity.getPosition();
            const cameraDistance = cameraPos.distance(gsplatPos);
            const pointRadius = Math.max(0.005, 0.01 * (cameraDistance / 10));

            let closestPoint: Vec3 | null = null;
            let minDistance = Infinity;
            let closestIndex = -1;

            // Iterate through all points to find closest intersection
            const maxPointsToCheck = 100000;
            const step = this.cachedPositions.length > maxPointsToCheck 
                ? Math.ceil(this.cachedPositions.length / maxPointsToCheck) 
                : 1;

            for (let i = 0; i < this.cachedPositions.length; i += step) {
                const localPos = this.cachedPositions[i];
                
                // Transform to world space
                const worldPos = new Vec3();
                worldMatrix.transformPoint(localPos, worldPos);

                const intersection = findClosestPointOnRay(rayOrigin, rayDirection, worldPos, pointRadius);
                
                if (intersection && intersection.distance < minDistance) {
                    minDistance = intersection.distance;
                    closestPoint = worldPos.clone();
                    closestIndex = i;
                }
            }

            if (closestIndex >= 0 && closestPoint) {
                return { index: closestIndex, position: closestPoint };
            }

            return null;
        };

        this.release = () => {
            this.cachedPositions = null;
            this.positionCacheValid = false;
        };
    }
}

export { Picker };
