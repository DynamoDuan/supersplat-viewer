import {
    type AppBase,
    type Entity,
    GSplatComponent,
    Mat4,
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

// Convert IEEE 754 half-precision float (uint16) to float32
const halfToFloat = (h: number): number => {
    const sign = (h >> 15) & 0x1;
    const exponent = (h >> 10) & 0x1f;
    const mantissa = h & 0x3ff;
    if (exponent === 0) {
        // subnormal
        return (sign ? -1 : 1) * Math.pow(2, -14) * (mantissa / 1024);
    } else if (exponent === 31) {
        return mantissa ? NaN : (sign ? -Infinity : Infinity);
    }
    return (sign ? -1 : 1) * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
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
    pickNearest: (x: number, y: number, count?: number) => Promise<{ index: number; position: Vec3 }[]>;
    getClosestPointIndex: (x: number, y: number) => Promise<{ index: number; position: Vec3 } | null>;
    getSplatsNearRay: (normalizedX: number, normalizedY: number, worldRadius: number) => number[];
    getPointsInScreenRect: (x1: number, y1: number, x2: number, y2: number) => number[];
    release: () => void;

    private gsplatEntity: Entity | null = null;
    private camera: Entity;
    private app: AppBase;
    cachedPositions: Vec3[] | null = null;
    cachedOpacities: Float32Array | null = null;
    positionCacheValid = false;

    constructor(app: AppBase, camera: Entity, gsplatEntity?: Entity) {
        this.gsplatEntity = gsplatEntity || null;
        this.camera = camera;
        this.app = app;

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

                // Read opacity from colorTexture (RGBA16F: alpha channel = opacity)
                const colorTexture = (resource as any).colorTexture;
                if (colorTexture) {
                    try {
                        const colorRT = new RenderTarget({
                            colorBuffer: colorTexture,
                            depth: false
                        });
                        const colorPixels = await colorTexture.read(0, 0, colorTexture.width, colorTexture.height, { renderTarget: colorRT });
                        const opacities = new Float32Array(numSplats);
                        for (let i = 0; i < numSplats && i < colorTexture.width * colorTexture.height; i++) {
                            const pixelIdx = i * 4;
                            // RGBA16F → Uint16Array, alpha is index 3
                            opacities[i] = halfToFloat((colorPixels as Uint16Array)[pixelIdx + 3]);
                        }
                        colorRT.destroy();
                        this.cachedOpacities = opacities;
                    } catch (e) {
                        console.warn('Failed to read color texture for opacity:', e);
                        this.cachedOpacities = null;
                    }
                }

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

        // Get the N nearest points to the ray through screen coords
        this.pickNearest = async (x: number, y: number, count: number = 5): Promise<{ index: number; position: Vec3 }[]> => {
            if (!this.gsplatEntity) {
                return [];
            }

            if (!this.positionCacheValid) {
                await loadPositions();
            }

            if (!this.cachedPositions || this.cachedPositions.length === 0) {
                return [];
            }

            const gsplat = this.gsplatEntity.gsplat as GSplatComponent;
            if (!gsplat) {
                return [];
            }

            const { graphicsDevice } = app;

            getRay(camera,
                Math.floor(x * graphicsDevice.canvas.offsetWidth),
                Math.floor(y * graphicsDevice.canvas.offsetHeight),
                ray
            );

            const worldMatrix = this.gsplatEntity.getWorldTransform();
            const rayOrigin = ray.origin;
            const rayDirection = ray.direction;

            const maxPointsToCheck = 100000;
            const step = this.cachedPositions.length > maxPointsToCheck
                ? Math.ceil(this.cachedPositions.length / maxPointsToCheck)
                : 1;

            // Track N nearest by perpendicular distance to ray
            const nearest: { index: number; px: number; py: number; pz: number; dist: number }[] = [];
            const wp = new Vec3();
            const toP = new Vec3();
            const cp = new Vec3();

            for (let i = 0; i < this.cachedPositions.length; i += step) {
                worldMatrix.transformPoint(this.cachedPositions[i], wp);

                toP.sub2(wp, rayOrigin);
                const proj = toP.dot(rayDirection);
                if (proj < 0) continue;

                cp.copy(rayOrigin).addScaled(rayDirection, proj);
                const dist = cp.distance(wp);

                if (nearest.length < count) {
                    nearest.push({ index: i, px: wp.x, py: wp.y, pz: wp.z, dist });
                    if (nearest.length === count) {
                        nearest.sort((a, b) => a.dist - b.dist);
                    }
                } else if (dist < nearest[nearest.length - 1].dist) {
                    const last = nearest[nearest.length - 1];
                    last.index = i;
                    last.px = wp.x;
                    last.py = wp.y;
                    last.pz = wp.z;
                    last.dist = dist;
                    nearest.sort((a, b) => a.dist - b.dist);
                }
            }

            if (nearest.length < count) {
                nearest.sort((a, b) => a.dist - b.dist);
            }

            return nearest.map(n => ({ index: n.index, position: new Vec3(n.px, n.py, n.pz) }));
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

        // Get all splat indices near the ray through normalized screen coords within worldRadius.
        this.getSplatsNearRay = (normalizedX: number, normalizedY: number, worldRadius: number): number[] => {
            if (!this.cachedPositions || this.cachedPositions.length === 0 || !this.gsplatEntity) {
                return [];
            }

            const { graphicsDevice } = this.app;
            getRay(
                this.camera,
                Math.floor(normalizedX * graphicsDevice.canvas.offsetWidth),
                Math.floor(normalizedY * graphicsDevice.canvas.offsetHeight),
                ray
            );

            const worldMatrix = this.gsplatEntity.getWorldTransform();
            const rayOrigin = new Vec3().copy(ray.origin);
            const rayDir = new Vec3().copy(ray.direction);
            const result: number[] = [];
            const worldPos = new Vec3();
            const toPoint = new Vec3();
            const closestPt = new Vec3();

            for (let i = 0; i < this.cachedPositions.length; i++) {
                worldMatrix.transformPoint(this.cachedPositions[i], worldPos);

                toPoint.sub2(worldPos, rayOrigin);
                const proj = toPoint.dot(rayDir);
                if (proj < 0) continue;

                closestPt.copy(rayOrigin).addScaled(rayDir, proj);
                const dist = closestPt.distance(worldPos);

                if (dist <= worldRadius) {
                    result.push(i);
                }
            }

            return result;
        };

        this.getPointsInScreenRect = (x1: number, y1: number, x2: number, y2: number): number[] => {
            if (!this.cachedPositions || this.cachedPositions.length === 0 || !this.gsplatEntity) {
                return [];
            }

            const viewMatrix = new Mat4().copy(this.camera.getWorldTransform()).invert();
            const projMatrix = this.camera.camera.projectionMatrix;
            const worldMatrix = this.gsplatEntity.getWorldTransform();
            const mvpMatrix = new Mat4().mul2(projMatrix, new Mat4().mul2(viewMatrix, worldMatrix));
            const mvpd = mvpMatrix.data;

            const minX = Math.min(x1, x2);
            const maxX = Math.max(x1, x2);
            const minY = Math.min(y1, y2);
            const maxY = Math.max(y1, y2);

            const result: number[] = [];

            for (let i = 0; i < this.cachedPositions.length; i++) {
                const px = this.cachedPositions[i].x;
                const py = this.cachedPositions[i].y;
                const pz = this.cachedPositions[i].z;

                const clipW = mvpd[3] * px + mvpd[7] * py + mvpd[11] * pz + mvpd[15];
                if (clipW <= 0) continue;

                const clipX = mvpd[0] * px + mvpd[4] * py + mvpd[8] * pz + mvpd[12];
                const clipY = mvpd[1] * px + mvpd[5] * py + mvpd[9] * pz + mvpd[13];

                const screenX = (clipX / clipW + 1) * 0.5;
                const screenY = (1 - clipY / clipW) * 0.5;

                if (screenX >= minX && screenX <= maxX && screenY >= minY && screenY <= maxY) {
                    result.push(i);
                }
            }

            return result;
        };

        this.release = () => {
            this.cachedPositions = null;
            this.cachedOpacities = null;
            this.positionCacheValid = false;
        };
    }
}

export { Picker };
