import {
    ADDRESS_CLAMP_TO_EDGE,
    BLEND_NORMAL,
    BUFFER_STATIC,
    FILTER_NEAREST,
    PIXELFORMAT_R8_G8_B8_A8,
    PRIMITIVE_POINTS,
    SEMANTIC_COLOR,
    SEMANTIC_POSITION,
    TYPE_FLOAT32,
    TYPE_UINT8,
    Color,
    Entity,
    GSplatComponent,
    Mat4,
    Mesh,
    MeshInstance,
    ShaderMaterial,
    Texture,
    Vec3,
    VertexBuffer,
    VertexFormat,
    type AppBase
} from 'playcanvas';

import { vertexShader, fragmentShader } from './shaders/simple-centers-shader';

/**
 * Centers overlay for displaying Gaussian splat centers as points
 * Similar to supersplat's SplatOverlay but adapted for supersplat-viewer
 */
class CentersOverlay {
    private app: AppBase;
    private entity: Entity | null = null;
    private mesh: Mesh | null = null;
    private material: ShaderMaterial | null = null;
    private meshInstance: MeshInstance | null = null;
    private gsplatEntity: Entity | null = null;
    private enabled = false;
    private pointSize = 0.01;
    private useGaussianColor = false;
    private selectedColor = new Color(0.0, 0.0, 0.8, 1.0);  // Deep blue for all point cloud centers (default color)
    private unselectedColor = new Color(0.5, 0.5, 0.5, 0.8);
    private highlightedPointId = -1;
    private maxPoints = 100000;  // Maximum number of points to display (default: 100k)
    private depthThreshold = 0.02;
    private depthFilterEnabled = false;
    private showFilteredPoints = false;  // Show filtered points with different color
    private filteredPointColor = new Color(1.0, 0.0, 0.0, 1.0);  // Red for filtered points
    private totalPoints = 0;  // Total number of points
    private filteredPointsCount = 0;  // Number of filtered points
    private cachedPositions: Vec3[] | null = null;  // Cached positions for filtering
    private cachedOpacities: Float32Array | null = null;  // Cached opacities for filtering
    private filterStateTexture: Texture | null = null;  // GPU texture holding per-splat filter state
    private depthTexture: Texture | null = null;  // GPU texture holding per-splat depth values for visualization
    private splatTexWidth = 1;
    private splatTexHeight = 1;
    private depthMin = 0.0;  // Minimum depth for normalization
    private depthMax = 1.0;  // Maximum depth for normalization (default to 1.0 to ensure depthMax > depthMin)

    // Cursor highlight state (show only nearest N points by ID)
    private cursorHighlightEnabled = false;
    private cursorHighlightColor = new Color(0.0, 1.0, 0.0, 1.0);  // Green for cursor proximity
    private cursorHighlightIds: number[] = [];  // IDs of the nearest N points to highlight (max 5)

    constructor(app: AppBase) {
        this.app = app;
    }

    /**
     * Attach overlay to a gsplat entity
     */
    attach(gsplatEntity: Entity) {
        this.detach();

        const gsplat = gsplatEntity.gsplat as GSplatComponent;
        if (!gsplat) {
            return;
        }

        this.gsplatEntity = gsplatEntity;
        const device = this.app.graphicsDevice;
        const scene = this.app.scene;

        // Get centers data from resource
        const instance = gsplat.instance;
        const resource = instance.resource as any;

        console.log('=== CentersOverlay attach ===');
        console.log('Resource has centers:', !!resource.centers);

        let centers: Float32Array | null = null;
        let numSplats = 0;

        // Get centers from resource
        if (resource.centers) {
            centers = resource.centers;
            numSplats = centers.length / 3; // centers is [x,y,z, x,y,z, ...]
            console.log('Using resource.centers, numSplats:', numSplats);
        }

        if (!centers || numSplats === 0) {
            console.error('No centers data available');
            return;
        }

        this.setTotalPoints(numSplats);

        // Cache positions as Vec3 array for filtering
        this.cachedPositions = [];
        for (let i = 0; i < numSplats; i++) {
            this.cachedPositions.push(new Vec3(centers[i * 3], centers[i * 3 + 1], centers[i * 3 + 2]));
        }
        console.log('CentersOverlay: cached', this.cachedPositions.length, 'positions');

        // Try to get opacities from resource
        const splatData = (resource as any).splatData;
        if (splatData && splatData.opacities) {
            this.cachedOpacities = splatData.opacities;
            console.log('CentersOverlay: cached', this.cachedOpacities.length, 'opacities');
        } else {
            console.log('CentersOverlay: no opacities available in resource');
            this.cachedOpacities = null;
        }

        // Compute texture dimensions for per-splat data (still needed for filter state)
        this.splatTexWidth = Math.max(1, Math.ceil(Math.sqrt(numSplats)));
        this.splatTexHeight = Math.max(1, Math.ceil(numSplats / this.splatTexWidth));

        // Create filter state texture (RGBA8, same layout as splatState)
        this.filterStateTexture = new Texture(device, {
            name: 'depthFilterState',
            width: this.splatTexWidth,
            height: this.splatTexHeight,
            format: PIXELFORMAT_R8_G8_B8_A8,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST,
            mipmaps: false
        });
        // Initialize to all-visible (R=0)
        const initPixels = this.filterStateTexture.lock();
        for (let i = 0; i < initPixels.length; i += 4) {
            initPixels[i] = 0;       // R = not filtered
            initPixels[i + 1] = 0;
            initPixels[i + 2] = 0;
            initPixels[i + 3] = 255; // A
        }
        this.filterStateTexture.unlock();

        // Create depth texture for visualization (R32F format for depth values)
        // We'll use RGBA8 and pack depth into R channel as normalized value
        this.depthTexture = new Texture(device, {
            name: 'depthVisualization',
            width: this.splatTexWidth,
            height: this.splatTexHeight,
            format: PIXELFORMAT_R8_G8_B8_A8,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST,
            mipmaps: false
        });
        // Initialize to zero depth
        const initDepthPixels = this.depthTexture.lock();
        for (let i = 0; i < initDepthPixels.length; i += 4) {
            initDepthPixels[i] = 0;       // R = normalized depth (0-255)
            initDepthPixels[i + 1] = 0;
            initDepthPixels[i + 2] = 0;
            initDepthPixels[i + 3] = 255; // A
        }
        this.depthTexture.unlock();

        // Create shader material with simplified shader
        this.material = new ShaderMaterial({
            uniqueName: 'centersOverlayMaterial',
            vertexGLSL: vertexShader,
            fragmentGLSL: fragmentShader
        });

        this.material.setParameter('splatSize', this.pointSize);
        this.material.blendType = BLEND_NORMAL;
        this.material.depthWrite = false;
        this.material.depthTest = true;
        this.material.depthFunc = 7; // FUNC_ALWAYS
        this.material.update();

        // Create vertex buffer with positions and colors
        const colors = new Uint8Array(numSplats * 4);
        for (let i = 0; i < numSplats; i++) {
            // Default color: deep blue
            colors[i * 4] = Math.floor(this.selectedColor.r * 255);
            colors[i * 4 + 1] = Math.floor(this.selectedColor.g * 255);
            colors[i * 4 + 2] = Math.floor(this.selectedColor.b * 255);
            colors[i * 4 + 3] = Math.floor(this.selectedColor.a * 255);
        }

        const vertexFormat = new VertexFormat(device, [
            { semantic: SEMANTIC_POSITION, components: 3, type: TYPE_FLOAT32 },
            { semantic: SEMANTIC_COLOR, components: 4, type: TYPE_UINT8, normalize: true }
        ]);

        const vertexBuffer = new VertexBuffer(device, vertexFormat, numSplats, {
            usage: BUFFER_STATIC
        });
        const vertexData = new ArrayBuffer(vertexFormat.size * numSplats);
        const posView = new Float32Array(vertexData);
        const colorView = new Uint8Array(vertexData);

        // Interleave position and color data
        const posOffset = 0;
        const colorOffset = 12; // 3 floats * 4 bytes = 12 bytes
        const stride = vertexFormat.size;

        for (let i = 0; i < numSplats; i++) {
            const vertexOffset = i * stride;
            // Position (3 floats)
            posView[(vertexOffset + posOffset) / 4] = centers[i * 3];
            posView[(vertexOffset + posOffset) / 4 + 1] = centers[i * 3 + 1];
            posView[(vertexOffset + posOffset) / 4 + 2] = centers[i * 3 + 2];
            // Color (4 bytes)
            colorView[vertexOffset + colorOffset] = colors[i * 4];
            colorView[vertexOffset + colorOffset + 1] = colors[i * 4 + 1];
            colorView[vertexOffset + colorOffset + 2] = colors[i * 4 + 2];
            colorView[vertexOffset + colorOffset + 3] = colors[i * 4 + 3];
        }

        vertexBuffer.setData(vertexData);

        // Create mesh with point primitive
        this.mesh = new Mesh(device);
        this.mesh.vertexBuffer = vertexBuffer;
        this.mesh.primitive[0] = {
            baseVertex: 0,
            type: PRIMITIVE_POINTS,
            base: 0,
            count: numSplats
        };

        this.meshInstance = new MeshInstance(this.mesh, this.material, null);
        this.meshInstance.drawBucket = 300;
        this.meshInstance.cull = false;

        // Create entity
        this.entity = new Entity('centersOverlay');
        this.entity.addComponent('render', {
            meshInstances: [this.meshInstance],
            layers: [scene.layers.getLayerByName('World').id]
        });

        // Attach to gsplat entity
        gsplatEntity.addChild(this.entity);

        console.log('CentersOverlay attached successfully with', numSplats, 'points');
    }

    /**
     * Detach overlay from gsplat entity
     */
    detach() {
        if (this.entity) {
            this.entity.remove();
            this.entity.destroy();
            this.entity = null;
        }
        this.mesh = null;
        this.material = null;
        this.meshInstance = null;
        this.gsplatEntity = null;
        this.cursorHighlightEnabled = false;
    }

    /**
     * Update overlay before rendering
     */
    update() {
        if (!this.enabled || !this.entity || !this.material || !this.gsplatEntity) {
            if (this.entity) {
                this.entity.enabled = false;
            }
            return;
        }

        const gsplat = this.gsplatEntity.gsplat as GSplatComponent;
        if (!gsplat) {
            return;
        }

        this.entity.enabled = true;

        // Update uniforms for simplified shader
        this.material.setParameter('splatSize', this.pointSize * window.devicePixelRatio);
        this.material.update();
    }

    /**
     * Set enabled state
     */
    setEnabled(enabled: boolean) {
        this.enabled = enabled;
        // Disable cursor highlighting when centers are disabled
        if (!enabled) {
            this.cursorHighlightEnabled = false;
        }
    }

    /**
     * Set point size
     */
    setPointSize(size: number) {
        this.pointSize = size;
    }

    /**
     * Set whether to use Gaussian colors
     */
    setUseGaussianColor(use: boolean) {
        this.useGaussianColor = use;
    }

    /**
     * Set selected color
     */
    setSelectedColor(color: Color) {
        this.selectedColor.copy(color);
    }

    /**
     * Set unselected color
     */
    setUnselectedColor(color: Color) {
        this.unselectedColor.copy(color);
    }

    /**
     * Set highlighted point ID
     */
    setHighlightedPointId(pointId: number) {
        this.highlightedPointId = pointId;
    }

    /**
     * Set depth threshold for near-surface filter
     */
    setDepthThreshold(threshold: number) {
        this.depthThreshold = threshold;
    }

    /**
     * Set whether depth filter is enabled
     */
    setDepthFilterEnabled(enabled: boolean) {
        this.depthFilterEnabled = enabled;
    }

    /**
     * Set whether to show filtered points with different color
     */
    setShowFilteredPoints(show: boolean) {
        this.showFilteredPoints = show;
        this.updateVertexColorsFromFilterState();
    }

    /**
     * Compute depth values for visualization (can be called independently of filtering)
     */
    computeDepthVisualization(positions: Vec3[], cameraEntity: Entity, opacities?: Float32Array | null) {
        if (!this.depthTexture || !this.gsplatEntity || !positions || positions.length === 0) {
            return;
        }

        const cam = cameraEntity.camera;
        if (!cam) return;

        const near = cam.nearClip;
        const far = cam.farClip;

        // Build view matrix (inverse of camera world transform)
        const viewMatrix = new Mat4().copy(cameraEntity.getWorldTransform()).invert();
        const gsplatWorldMatrix = this.gsplatEntity.getWorldTransform();

        // Compute model-view matrix
        const mvMatrix = new Mat4().mul2(viewMatrix, gsplatWorldMatrix);
        const mvd = mvMatrix.data;

        const numSplats = Math.min(positions.length, this.splatTexWidth * this.splatTexHeight);

        // Calculate depths for all points
        const depths: number[] = [];
        for (let i = 0; i < numSplats; i++) {
            const px = positions[i].x, py = positions[i].y, pz = positions[i].z;
            const viewZ = mvd[2] * px + mvd[6] * py + mvd[10] * pz + mvd[14];
            const depth = -viewZ;  // z-depth: positive = farther from camera
            if (depth > 0 && depth >= near && depth <= far) {
                depths.push(depth);
            } else {
                depths.push(0);
            }
        }

        // Find min/max depth
        let minDepth = Infinity;
        let maxDepth = -Infinity;
        for (let i = 0; i < depths.length; i++) {
            if (depths[i] > 0) {
                minDepth = Math.min(minDepth, depths[i]);
                maxDepth = Math.max(maxDepth, depths[i]);
            }
        }

        // Update depth range
        if (minDepth < Infinity && maxDepth > -Infinity && maxDepth > minDepth) {
            this.depthMin = minDepth;
            this.depthMax = maxDepth;
        } else {
            // Default range if no valid depths
            this.depthMin = near;
            this.depthMax = far;
        }

        // Write normalized depth values to texture
        const depthPixels = this.depthTexture.lock();
        for (let i = 0; i < numSplats; i++) {
            const depth = depths[i];
            const idx = i * 4;
            
            if (depth > 0 && maxDepth > minDepth) {
                // Normalize depth to [0, 1] then to [0, 255]
                const normalized = (depth - minDepth) / (maxDepth - minDepth);
                depthPixels[idx] = Math.floor(normalized * 255);  // R = normalized depth
            } else {
                depthPixels[idx] = 0;
            }
            depthPixels[idx + 1] = 0;
            depthPixels[idx + 2] = 0;
            depthPixels[idx + 3] = 255;
        }

        // Clear remaining pixels
        for (let i = numSplats; i < this.splatTexWidth * this.splatTexHeight; i++) {
            const idx = i * 4;
            depthPixels[idx] = 0;
            depthPixels[idx + 1] = 0;
            depthPixels[idx + 2] = 0;
            depthPixels[idx + 3] = 255;
        }

        this.depthTexture.unlock();
    }

    /**
     * Get statistics about filtering
     */
    getFilterStats() {
        const erasedCount = this.getErasedCount();
        return {
            total: this.totalPoints,
            filtered: this.filteredPointsCount,
            erased: erasedCount,
            visible: this.totalPoints - this.filteredPointsCount - erasedCount
        };
    }

    /**
     * Update total points count (called when points are loaded)
     */
    setTotalPoints(count: number) {
        this.totalPoints = count;
        this.filteredPointsCount = 0;
    }

    /**
     * Set the filtered points count (called externally after GPU readback)
     */
    setFilteredPointsCount(count: number) {
        this.filteredPointsCount = count;
    }

    /**
     * Get the gsplat entity
     */
    getGsplatEntity(): Entity | null {
        return this.gsplatEntity;
    }

    /**
     * Compute depth filtering on CPU using proper alpha-blending depth (same as gsplat rendering).
     *
     * Expected depth: ED(pixel) = Σ(α_i · T_i · z_i)  where T_i = Π(1 - α_j) for j < i
     *
     * Steps:
     *   1. Project all splats to screen, record (pixelIdx, depth, alpha) per splat
     *   2. Sort by depth front-to-back
     *   3. Accumulate per-pixel: weight_i = α_i · T_i, depthAccum += weight_i · z_i
     *   4. Compare each splat's depth against the blended surface depth
     */
    computeFiltering(positions: Vec3[], cameraEntity: Entity, opacities?: Float32Array | null) {
        console.log('computeFiltering called, positions:', positions?.length, 'threshold:', this.depthThreshold);

        if (!this.filterStateTexture || !this.gsplatEntity || !positions || positions.length === 0) {
            console.log('computeFiltering early return');
            return;
        }

        const cam = cameraEntity.camera;
        if (!cam) {
            console.log('computeFiltering: no camera');
            return;
        }

        const near = cam.nearClip;
        const far = cam.farClip;

        // Build matrices
        const viewMatrix = new Mat4().copy(cameraEntity.getWorldTransform()).invert();
        const projMatrix = cam.projectionMatrix;
        const gsplatWorldMatrix = this.gsplatEntity.getWorldTransform();
        const mvMatrix = new Mat4().mul2(viewMatrix, gsplatWorldMatrix);
        const mvpMatrix = new Mat4().mul2(projMatrix, mvMatrix);

        const mvd = mvMatrix.data;
        const mvpd = mvpMatrix.data;

        const numSplats = Math.min(positions.length, this.splatTexWidth * this.splatTexHeight);

        // CPU depth buffer resolution
        const res = 512;

        // --- Pass 1: project all splats ---
        // Store (pixelIdx, depth, alpha, splatId) for sorting
        const projectedList: { pixel: number; depth: number; alpha: number; id: number }[] = [];
        const perSplatDepth = new Float32Array(numSplats); // store depth per splat for later comparison

        for (let i = 0; i < numSplats; i++) {
            const px = positions[i].x, py = positions[i].y, pz = positions[i].z;

            // View-space Z depth
            const viewZ = mvd[2] * px + mvd[6] * py + mvd[10] * pz + mvd[14];
            const depth = -viewZ;

            // Per-splat opacity (sigmoid-transformed, range 0-1)
            const alpha = (opacities && i < opacities.length) ? Math.max(0, Math.min(1, opacities[i])) : 1.0;

            // Clip space
            const clipW = mvpd[3] * px + mvpd[7] * py + mvpd[11] * pz + mvpd[15];
            if (clipW <= 0 || depth <= 0 || depth < near || depth > far) {
                perSplatDepth[i] = -1; // invalid
                continue;
            }

            const clipX = mvpd[0] * px + mvpd[4] * py + mvpd[8] * pz + mvpd[12];
            const clipY = mvpd[1] * px + mvpd[5] * py + mvpd[9] * pz + mvpd[13];
            const ndcX = clipX / clipW;
            const ndcY = clipY / clipW;

            const sx = Math.floor((ndcX * 0.5 + 0.5) * res);
            const sy = Math.floor((1.0 - (ndcY * 0.5 + 0.5)) * res);

            perSplatDepth[i] = depth;

            if (sx >= 0 && sx < res && sy >= 0 && sy < res) {
                projectedList.push({ pixel: sy * res + sx, depth, alpha, id: i });
            }
        }

        // --- Pass 2: sort front-to-back by depth ---
        projectedList.sort((a, b) => a.depth - b.depth);

        // --- Pass 3: accumulate per-pixel with transmittance ---
        // ED(pixel) = Σ(α_i · T_i · z_i), totalWeight = Σ(α_i · T_i)
        const depthAccum = new Float32Array(res * res);
        const weightAccum = new Float32Array(res * res);
        const transmittance = new Float32Array(res * res);
        transmittance.fill(1.0);

        for (let k = 0; k < projectedList.length; k++) {
            const { pixel, depth, alpha } = projectedList[k];
            const T = transmittance[pixel];
            if (T < 1e-4) continue; // early termination: pixel is fully opaque

            const w = alpha * T;
            depthAccum[pixel] += w * depth;
            weightAccum[pixel] += w;
            transmittance[pixel] = T * (1 - alpha);
        }

        // Normalize to get expected depth
        const surfaceDepth = new Float32Array(res * res);
        for (let i = 0; i < res * res; i++) {
            surfaceDepth[i] = weightAccum[i] > 1e-10 ? depthAccum[i] / weightAccum[i] : Infinity;
        }

        // --- Pass 4: compare each splat against blended surface depth ---
        const thresholdWorld = this.depthThreshold * (far - near);
        let filteredCount = 0;

        const pixels = this.filterStateTexture.lock();

        for (let i = 0; i < numSplats; i++) {
            let isFiltered = false;
            const depth = perSplatDepth[i];

            if (depth > 0) {
                // Re-project to find pixel (we need screen coords again)
                const px = positions[i].x, py = positions[i].y, pz = positions[i].z;
                const clipW = mvpd[3] * px + mvpd[7] * py + mvpd[11] * pz + mvpd[15];
                if (clipW > 0) {
                    const clipX = mvpd[0] * px + mvpd[4] * py + mvpd[8] * pz + mvpd[12];
                    const clipY = mvpd[1] * px + mvpd[5] * py + mvpd[9] * pz + mvpd[13];
                    const sx = Math.floor(((clipX / clipW) * 0.5 + 0.5) * res);
                    const sy = Math.floor((1.0 - ((clipY / clipW) * 0.5 + 0.5)) * res);

                    if (sx >= 0 && sx < res && sy >= 0 && sy < res) {
                        const sd = surfaceDepth[sy * res + sx];
                        if (sd < Infinity && depth > sd + thresholdWorld) {
                            isFiltered = true;
                            filteredCount++;
                        }
                    }
                }
            }

            const idx = i * 4;
            pixels[idx] = isFiltered ? 255 : 0;  // R channel = filter state
            // pixels[idx + 1] preserved (G channel = eraser state) - don't modify
            pixels[idx + 2] = 0;  // B channel = preview
            pixels[idx + 3] = 255;  // A channel
        }

        // Clear remaining pixels (preserve G channel)
        for (let i = numSplats; i < this.splatTexWidth * this.splatTexHeight; i++) {
            const idx = i * 4;
            pixels[idx] = 0;  // R channel = not filtered
            // pixels[idx + 1] preserved (G channel = eraser state) - don't modify
            pixels[idx + 2] = 0;  // B channel = preview
            pixels[idx + 3] = 255;  // A channel
        }

        this.filterStateTexture.unlock();
        this.filteredPointsCount = filteredCount;

        console.log('computeFiltering done: filtered', filteredCount, 'out of', numSplats, 'points');

        // --- Update vertex colors based on filter state ---
        this.updateVertexColorsFromFilterState();

        // --- Also update depth visualization texture ---
        if (this.depthTexture) {
            // Find min/max depth from valid splats
            let minDepth = Infinity;
            let maxDepth = -Infinity;
            for (let i = 0; i < numSplats; i++) {
                const d = perSplatDepth[i];
                if (d > 0) {
                    minDepth = Math.min(minDepth, d);
                    maxDepth = Math.max(maxDepth, d);
                }
            }
            if (minDepth < Infinity && maxDepth > minDepth) {
                this.depthMin = minDepth;
                this.depthMax = maxDepth;
            }

            const depthPixels = this.depthTexture.lock();
            for (let i = 0; i < numSplats; i++) {
                const d = perSplatDepth[i];
                const idx = i * 4;
                if (d > 0 && maxDepth > minDepth) {
                    depthPixels[idx] = Math.floor(((d - minDepth) / (maxDepth - minDepth)) * 255);
                } else {
                    depthPixels[idx] = 0;
                }
                depthPixels[idx + 1] = 0;
                depthPixels[idx + 2] = 0;
                depthPixels[idx + 3] = 255;
            }
            for (let i = numSplats; i < this.splatTexWidth * this.splatTexHeight; i++) {
                const idx = i * 4;
                depthPixels[idx] = 0;
                depthPixels[idx + 1] = 0;
                depthPixels[idx + 2] = 0;
                depthPixels[idx + 3] = 255;
            }
            this.depthTexture.unlock();
        }
    }

    /**
     * Clear the filter state (mark all points as visible)
     */
    clearFilterState() {
        if (!this.filterStateTexture) return;
        const pixels = this.filterStateTexture.lock();
        for (let i = 0; i < pixels.length; i += 4) {
            pixels[i] = 0;      // R = depth filter
            // pixels[i + 1] preserved (G channel = eraser state)
            pixels[i + 2] = 0;
            pixels[i + 3] = 255;
        }
        this.filterStateTexture.unlock();
        this.filteredPointsCount = 0;
        this.updateVertexColorsFromFilterState();
    }

    /**
     * Update vertex colors based on filter state texture
     */
    private updateVertexColorsFromFilterState() {
        if (!this.mesh || !this.filterStateTexture) {
            console.log('updateVertexColorsFromFilterState: early return - mesh or texture missing');
            return;
        }

        const vertexBuffer = this.mesh.vertexBuffer;
        if (!vertexBuffer) {
            console.log('updateVertexColorsFromFilterState: no vertex buffer');
            return;
        }

        const numSplats = this.totalPoints;
        const vertexFormat = vertexBuffer.format;
        const stride = vertexFormat.size;
        const colorOffset = 12; // 3 floats * 4 bytes = 12 bytes

        // Read filter state
        const filterPixels = this.filterStateTexture.lock();

        // Lock vertex buffer and update colors
        const vertexData = new ArrayBuffer(stride * numSplats);
        const colorView = new Uint8Array(vertexData);

        // Read existing vertex data
        const existingData = vertexBuffer.lock();
        colorView.set(new Uint8Array(existingData));
        vertexBuffer.unlock();

        let filteredVisibleCount = 0;
        let filteredHiddenCount = 0;
        let erasedCount = 0;
        let normalCount = 0;
        let highlightCount = 0;

        // Create a set for fast lookup of cursor highlight IDs
        const highlightSet = new Set(this.cursorHighlightIds);

        // Update colors based on filter state
        for (let i = 0; i < numSplats; i++) {
            const filterIdx = i * 4;
            const isFiltered = filterPixels[filterIdx] > 0; // R channel = filter state
            const isErased = filterPixels[filterIdx + 1] > 0; // G channel = erased state
            const isCursorHighlight = this.cursorHighlightEnabled && highlightSet.has(i);

            const vertexOffset = i * stride;
            const colorIdx = vertexOffset + colorOffset;

            if (isErased) {
                // Erased points are invisible (alpha = 0)
                colorView[colorIdx] = 0;
                colorView[colorIdx + 1] = 0;
                colorView[colorIdx + 2] = 0;
                colorView[colorIdx + 3] = 0;
                erasedCount++;
            } else if (isCursorHighlight) {
                // Cursor highlight points shown in green (highest priority)
                colorView[colorIdx] = Math.floor(this.cursorHighlightColor.r * 255);
                colorView[colorIdx + 1] = Math.floor(this.cursorHighlightColor.g * 255);
                colorView[colorIdx + 2] = Math.floor(this.cursorHighlightColor.b * 255);
                colorView[colorIdx + 3] = Math.floor(this.cursorHighlightColor.a * 255);
                highlightCount++;
            } else if (isFiltered && this.showFilteredPoints) {
                // Filtered points shown in red
                colorView[colorIdx] = Math.floor(this.filteredPointColor.r * 255);
                colorView[colorIdx + 1] = Math.floor(this.filteredPointColor.g * 255);
                colorView[colorIdx + 2] = Math.floor(this.filteredPointColor.b * 255);
                colorView[colorIdx + 3] = Math.floor(this.filteredPointColor.a * 255);
                filteredVisibleCount++;
            } else if (isFiltered && !this.showFilteredPoints) {
                // Filtered points are hidden (alpha = 0)
                colorView[colorIdx] = 0;
                colorView[colorIdx + 1] = 0;
                colorView[colorIdx + 2] = 0;
                colorView[colorIdx + 3] = 0;
                filteredHiddenCount++;
            } else {
                // Visible points use selected color
                colorView[colorIdx] = Math.floor(this.selectedColor.r * 255);
                colorView[colorIdx + 1] = Math.floor(this.selectedColor.g * 255);
                colorView[colorIdx + 2] = Math.floor(this.selectedColor.b * 255);
                colorView[colorIdx + 3] = Math.floor(this.selectedColor.a * 255);
                normalCount++;
            }
        }

        this.filterStateTexture.unlock();

        console.log('updateVertexColorsFromFilterState:', {
            total: numSplats,
            normal: normalCount,
            highlighted: highlightCount,
            filteredVisible: filteredVisibleCount,
            filteredHidden: filteredHiddenCount,
            erased: erasedCount,
            showFilteredPoints: this.showFilteredPoints
        });

        // Update vertex buffer with new colors
        vertexBuffer.setData(vertexData);
    }

    /**
     * Preview erase: mark points in filterStateTexture B channel for red highlight.
     * Call clearErasePreview() before setting new preview.
     */
    previewErase(indices: number[]) {
        if (!this.filterStateTexture || indices.length === 0) return;
        const pixels = this.filterStateTexture.lock();
        for (const idx of indices) {
            const pixelIdx = idx * 4;
            if (pixelIdx + 2 < pixels.length) {
                pixels[pixelIdx + 2] = 255; // B channel = preview
            }
        }
        this.filterStateTexture.unlock();
    }

    /**
     * Clear erase preview (B channel).
     */
    clearErasePreview() {
        if (!this.filterStateTexture) return;
        const pixels = this.filterStateTexture.lock();
        for (let i = 0; i < pixels.length; i += 4) {
            pixels[i + 2] = 0;
        }
        this.filterStateTexture.unlock();
    }

    /**
     * Erase (hide) splats by marking them in filterStateTexture G channel.
     * The centers overlay shader will discard these points.
     * Also writes to engine stateTexture if available (hides from gsplat renderer).
     */
    eraseSplats(indices: number[]) {
        if (!this.gsplatEntity || indices.length === 0) return;

        // 1. Write to our own filterStateTexture G channel (always exists)
        if (this.filterStateTexture) {
            const pixels = this.filterStateTexture.lock();
            for (const idx of indices) {
                const pixelIdx = idx * 4;
                if (pixelIdx + 1 < pixels.length) {
                    pixels[pixelIdx + 1] = 255; // G channel = erased
                }
            }
            this.filterStateTexture.unlock();
            this.updateVertexColorsFromFilterState();
        }
    }

    /**
     * Get the set of splat indices that are currently erased.
     */
    getErasedIndices(): Set<number> {
        const result = new Set<number>();
        if (!this.filterStateTexture) return result;

        const pixels = this.filterStateTexture.lock();
        const totalPixels = this.splatTexWidth * this.splatTexHeight;
        for (let i = 0; i < totalPixels; i++) {
            if (pixels[i * 4 + 1] > 0) { // G channel
                result.add(i);
            }
        }
        this.filterStateTexture.unlock();
        return result;
    }

    /**
     * Get the filterStateTexture so it can be passed to the gsplat material for eraser rendering.
     * The G channel marks erased splats.
     */
    getFilterStateTexture() {
        return this.filterStateTexture;
    }

    /**
     * Get the count of erased splats.
     */
    getErasedCount(): number {
        if (!this.filterStateTexture) return 0;
        const pixels = this.filterStateTexture.lock();
        let count = 0;
        const totalPixels = this.splatTexWidth * this.splatTexHeight;
        for (let i = 0; i < totalPixels; i++) {
            if (pixels[i * 4 + 1] > 0) count++;
        }
        this.filterStateTexture.unlock();
        return count;
    }

    /**
     * Un-erase all splats.
     */
    uneraseSplats() {
        // Clear filterStateTexture G channel
        if (this.filterStateTexture) {
            const pixels = this.filterStateTexture.lock();
            for (let i = 0; i < pixels.length; i += 4) {
                pixels[i + 1] = 0; // clear G channel
            }
            this.filterStateTexture.unlock();
            this.updateVertexColorsFromFilterState();
        }
    }

    /**
     * Erase all splats except those in the keep set.
     * Points inside keepIndices are un-erased (G=0), all others are erased (G=255).
     */
    eraseAllExcept(keepIndices: Set<number>): void {
        if (!this.filterStateTexture) return;
        const pixels = this.filterStateTexture.lock();
        const totalPixels = this.splatTexWidth * this.splatTexHeight;
        for (let i = 0; i < totalPixels; i++) {
            const idx = i * 4;
            pixels[idx + 1] = keepIndices.has(i) ? 0 : 255;
        }
        this.filterStateTexture.unlock();
        this.updateVertexColorsFromFilterState();
    }

    /**
     * Set the IDs of points to highlight near the cursor (max 5)
     */
    setCursorHighlightIds(ids: number[]) {
        this.cursorHighlightIds = ids.slice(0, 5);
        this.cursorHighlightEnabled = ids.length > 0;
        this.updateVertexColorsFromFilterState();
    }

    /**
     * Get the position of a splat by its ID
     */
    getSplatPosition(splatId: number): Vec3 | null {
        if (!this.gsplatEntity) {
            return null;
        }

        const gsplat = this.gsplatEntity.gsplat as GSplatComponent;
        if (!gsplat || !gsplat.instance) {
            return null;
        }

        const resource = gsplat.instance.resource;
        if (!(resource as any).transformATexture) {
            return null;
        }

        // Read position from texture
        const posTexture = (resource as any).transformATexture;
        const texWidth = posTexture.width;

        // Calculate texture coordinates
        const _x = splatId % texWidth;
        const _y = Math.floor(splatId / texWidth);

        // For now, we'll need to read from the GPU texture which is complex
        // Instead, let's return null and use a different approach
        // TODO: Implement proper position reading from texture
        return null;
    }

    /**
     * Get enabled state (public getter)
     */
    get isEnabled(): boolean {
        return this.enabled;
    }

    /**
     * Clean up resources
     */
    destroy() {
        this.detach();
        if (this.filterStateTexture) {
            this.filterStateTexture.destroy();
            this.filterStateTexture = null;
        }
    }
}

export { CentersOverlay };

