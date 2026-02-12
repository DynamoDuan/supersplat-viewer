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

import { vertexShader, fragmentShader } from './shaders/splat-overlay-shader';

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
    private filterStateTexture: Texture | null = null;  // GPU texture holding per-splat filter state
    private depthTexture: Texture | null = null;  // GPU texture holding per-splat depth values for visualization
    private splatTexWidth = 1;
    private splatTexHeight = 1;
    private showDepthVisualization = false;  // Show depth as color-coded points
    private depthFrozen = false;  // When true, depth values are locked and won't update on camera move
    private depthMin = 0.0;  // Minimum depth for normalization
    private depthMax = 1.0;  // Maximum depth for normalization (default to 1.0 to ensure depthMax > depthMin)

    // Frozen depth cloud: back-projected alpha-blended depth rendered as a separate point cloud
    private frozenDepthEntity: Entity | null = null;
    private frozenDepthMesh: Mesh | null = null;
    private frozenDepthMaterial: ShaderMaterial | null = null;

    // Frozen filter cloud: back-projected filtered points rendered as a separate point cloud
    private frozenFilterEntity: Entity | null = null;
    private frozenFilterMesh: Mesh | null = null;
    private frozenFilterMaterial: ShaderMaterial | null = null;
    private filterFrozen = false;

    // Proximity highlight state
    private cursorPosition: Vec3 = new Vec3();
    private cursorHighlightEnabled = false;
    private cursorHighlightRadius = 0.02;  // Larger radius for highlighting ~10 nearest points
    private cursorHighlightColor = new Color(0.0, 1.0, 0.0, 1.0);  // Green for cursor proximity
    private cursorNeighborColor = new Color(0.5, 1.0, 0.5, 1.0);  // Light green for neighbors
    private highlightedPointIds: number[] = [];  // IDs of the nearest N points to highlight
    private maxHighlightedPoints = 10;  // Maximum number of points to highlight

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

        // Get total number of splats
        const instance = gsplat.instance;
        if (instance && instance.resource) {
            const resource = instance.resource as any;
            const numSplats = resource.numSplats || 0;
            this.setTotalPoints(numSplats);
        }

        // Compute texture dimensions for per-splat data
        const numSplats = (instance.resource as any).numSplats || 0;
        this.splatTexWidth = Math.max(1, Math.ceil(Math.sqrt(numSplats || 1)));
        this.splatTexHeight = Math.max(1, Math.ceil((numSplats || 1) / this.splatTexWidth));

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

        // Create shader material
        this.material = new ShaderMaterial({
            uniqueName: 'centersOverlayMaterial',
            vertexGLSL: vertexShader,
            fragmentGLSL: fragmentShader
        });
        
        // Set default depth visualization uniforms (even if texture doesn't exist yet)
        // Use safe defaults to avoid division by zero in shader
        this.material.setParameter('showDepthVisualization', 0.0);
        this.material.setParameter('depthMin', 0.0);
        this.material.setParameter('depthMax', 1.0); // Safe default (ensures depthMax > depthMin)
        this.material.blendType = BLEND_NORMAL;
        this.material.depthWrite = false;
        // Enable depth test but use ALWAYS function to ensure centers render on top
        // This ensures centers are not occluded by gaussians
        this.material.depthTest = true;
        this.material.depthFunc = 7; // FUNC_ALWAYS (always pass depth test)
        
        // Set depth visualization texture and uniforms immediately after material creation
        // This ensures the texture is always bound, even if visualization is disabled
        if (this.depthTexture) {
            this.material.setParameter('depthVisualization', this.depthTexture);
        }
        this.material.setParameter('showDepthVisualization', 0.0); // Default to disabled
        this.material.setParameter('depthMin', 0.0);
        this.material.setParameter('depthMax', 1.0); // Safe default
        
        this.material.update();

        // Create mesh with point primitive
        this.mesh = new Mesh(device);
        this.mesh.primitive[0] = {
            baseVertex: 0,
            type: PRIMITIVE_POINTS,
            base: 0,
            count: 0
        };

        this.meshInstance = new MeshInstance(this.mesh, this.material, null);
        // Use a much higher draw bucket to render after all splats
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

        // Set up uniforms from gsplat instance
        this.updateUniforms(gsplat);

        // Subscribe to sorter updates for dynamic count
        if (instance && instance.sorter) {
            const onSorterUpdated = () => {
                // Estimate count from order texture size
                if (this.mesh && instance.orderTexture) {
                    const estimatedCount = instance.orderTexture.width * instance.orderTexture.height;
                    this.mesh.primitive[0].count = estimatedCount;
                }
            };
            instance.sorter.on('updated', onSorterUpdated);

            // Initialize count
            if (this.mesh && instance.orderTexture) {
                const estimatedCount = instance.orderTexture.width * instance.orderTexture.height;
                this.mesh.primitive[0].count = estimatedCount;
            }
        }
    }

    /**
     * Update shader uniforms from gsplat instance
     */
    private updateUniforms(gsplat: GSplatComponent) {
        if (!this.material) {
            return;
        }

        const instance = gsplat.instance;
        if (!instance) {
            return;
        }

        const resource = instance.resource;
        const orderTexture = instance.orderTexture;

        // Set up order texture uniforms
        this.material.setParameter('splatOrder', orderTexture);
        this.material.setParameter('splatTextureSize', orderTexture.width);

        // Set up other uniforms
        // Note: supersplat-viewer may not have all these textures, use what's available
        // For now, create a simple default state texture
        let stateTexture: any = null;
        let texWidth = 1;
        let texHeight = 1;
        
        // Try to get state texture or create a default
        if ((instance as any).stateTexture) {
            stateTexture = (instance as any).stateTexture;
            texWidth = stateTexture.width;
            texHeight = stateTexture.height;
        } else {
            // Create a minimal default texture
            texWidth = Math.max(1, Math.ceil(Math.sqrt((resource as any).numSplats || 1)));
            texHeight = Math.max(1, Math.ceil(((resource as any).numSplats || 1) / texWidth));
        }
        
        if (stateTexture) {
            this.material.setParameter('splatState', stateTexture);
        }
        
        // Try to set position and color textures if available
        if ((resource as any).transformATexture) {
            this.material.setParameter('splatPosition', (resource as any).transformATexture);
        }
        if ((resource as any).colorTexture) {
            this.material.setParameter('splatColor', (resource as any).colorTexture);
        }
        
        this.material.setParameter('texParams', [texWidth, texHeight]);

        // Set up SH textures if available
        const shBands = (resource as any).shBands || 0;
        this.material.setDefine('SH_BANDS', `${shBands}`);
        if (shBands > 0 && (resource as any).sh1to3Texture) {
            this.material.setParameter('splatSH_1to3', (resource as any).sh1to3Texture);
            if (shBands > 1) {
                if ((resource as any).sh4to7Texture) {
                    this.material.setParameter('splatSH_4to7', (resource as any).sh4to7Texture);
                }
                if ((resource as any).sh8to11Texture) {
                    this.material.setParameter('splatSH_8to11', (resource as any).sh8to11Texture);
                }
                if (shBands > 2 && (resource as any).sh12to15Texture) {
                    this.material.setParameter('splatSH_12to15', (resource as any).sh12to15Texture);
                }
            }
        }

        this.material.update();
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

        // Update uniforms
        this.material.setParameter('splatSize', this.pointSize * window.devicePixelRatio);
        this.material.setParameter('selectedClr', [
            this.selectedColor.r,
            this.selectedColor.g,
            this.selectedColor.b,
            this.selectedColor.a
        ]);
        this.material.setParameter('unselectedClr', [
            this.unselectedColor.r,
            this.unselectedColor.g,
            this.unselectedColor.b,
            this.unselectedColor.a
        ]);
        this.material.setParameter('useGaussianColor', this.useGaussianColor ? 1.0 : 0.0);
        this.material.setParameter('highlightedId', this.highlightedPointId);
        this.material.setParameter('depthFilterEnabled', this.depthFilterEnabled ? 1.0 : 0.0);
        this.material.setParameter('showFilteredPoints', this.showFilteredPoints ? 1.0 : 0.0);
        this.material.setParameter('filteredPointColor', [
            this.filteredPointColor.r,
            this.filteredPointColor.g,
            this.filteredPointColor.b
        ]);
        if (this.filterStateTexture) {
            this.material.setParameter('depthFilterState', this.filterStateTexture);
        }
        // Always set depth visualization texture (it's created in attach(), so should always exist)
        if (this.depthTexture) {
            this.material.setParameter('depthVisualization', this.depthTexture);
        }
        // Always set these uniforms (shader will check if depth visualization is enabled)
        this.material.setParameter('showDepthVisualization', this.showDepthVisualization ? 1.0 : 0.0);
        // Set depth range - use safe defaults if not computed yet
        // Ensure depthMax > depthMin to avoid division by zero in shader
        const safeDepthMin = this.depthMin;
        const safeDepthMax = (this.depthMax > this.depthMin && this.depthMax > 0.0) ? this.depthMax : (this.depthMin + 1.0);
        this.material.setParameter('depthMin', safeDepthMin);
        this.material.setParameter('depthMax', safeDepthMax);

        // Always use FUNC_ALWAYS — filtering is done via CPU-computed filter state texture
        this.material.depthFunc = 7; // FUNC_ALWAYS

        // Proximity highlight uniforms (real-time cursor highlighting)
        this.material.setParameter('cursorPosition', [this.cursorPosition.x, this.cursorPosition.y, this.cursorPosition.z]);
        this.material.setParameter('cursorHighlightRadius', this.cursorHighlightRadius);
        this.material.setParameter('cursorHighlightEnabled', this.cursorHighlightEnabled ? 1.0 : 0.0);
        this.material.setParameter('cursorHighlightColor', [
            this.cursorHighlightColor.r,
            this.cursorHighlightColor.g,
            this.cursorHighlightColor.b
        ]);
        this.material.setParameter('cursorNeighborColor', [
            this.cursorNeighborColor.r,
            this.cursorNeighborColor.g,
            this.cursorNeighborColor.b
        ]);
        
        // Pass highlighted point IDs array (for highlighting nearest N points)
        // We'll use a uniform array, but since WebGL has limitations, we'll use distance-based approach instead
        // The shader will highlight points within radius, sorted by distance

        // Pass camera position for SH evaluation
        // Get camera from the global viewer state
        const cameraEntity = (this.app as any).root?.findByName?.('camera') || 
                             (this.app as any).scene?.camera?.entity ||
                             null;
        if (cameraEntity) {
            const camPos = cameraEntity.getPosition();
            this.material.setParameter('view_position', [camPos.x, camPos.y, camPos.z]);
        } else {
            // Fallback to origin
            this.material.setParameter('view_position', [0, 0, 0]);
        }

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
    }

    /**
     * Set whether to show depth visualization (color-coded by depth)
     */
    setShowDepthVisualization(show: boolean) {
        this.showDepthVisualization = show;
    }

    /**
     * Freeze depth: compute alpha-blended depth at current viewpoint,
     * back-project each pixel to world space, and render as a separate point cloud.
     */
    freezeDepth(positions: Vec3[], cameraEntity: Entity, opacities?: Float32Array | null) {
        // Remove previous frozen cloud
        this.unfreezeDepth();

        if (!this.gsplatEntity || !positions || positions.length === 0) return;

        const cam = cameraEntity.camera;
        if (!cam) return;

        const near = cam.nearClip;
        const far = cam.farClip;

        // Build matrices
        const cameraWorldMatrix = new Mat4().copy(cameraEntity.getWorldTransform());
        const viewMatrix = new Mat4().copy(cameraWorldMatrix).invert();
        const projMatrix = cam.projectionMatrix;
        const gsplatWorldMatrix = this.gsplatEntity.getWorldTransform();
        const mvMatrix = new Mat4().mul2(viewMatrix, gsplatWorldMatrix);
        const mvpMatrix = new Mat4().mul2(projMatrix, mvMatrix);

        const mvd = mvMatrix.data;
        const mvpd = mvpMatrix.data;
        const projd = projMatrix.data;

        const numSplats = Math.min(positions.length, this.splatTexWidth * this.splatTexHeight);
        const res = 512;

        // --- Pass 1: project all splats, collect (pixel, depth, alpha) ---
        const projectedList: { pixel: number; depth: number; alpha: number }[] = [];

        for (let i = 0; i < numSplats; i++) {
            const px = positions[i].x, py = positions[i].y, pz = positions[i].z;
            const viewZ = mvd[2] * px + mvd[6] * py + mvd[10] * pz + mvd[14];
            const depth = -viewZ;
            const alpha = (opacities && i < opacities.length) ? Math.max(0, Math.min(1, opacities[i])) : 1.0;

            const clipW = mvpd[3] * px + mvpd[7] * py + mvpd[11] * pz + mvpd[15];
            if (clipW <= 0 || depth <= 0 || depth < near || depth > far) continue;

            const clipX = mvpd[0] * px + mvpd[4] * py + mvpd[8] * pz + mvpd[12];
            const clipY = mvpd[1] * px + mvpd[5] * py + mvpd[9] * pz + mvpd[13];
            const sx = Math.floor(((clipX / clipW) * 0.5 + 0.5) * res);
            const sy = Math.floor((1.0 - ((clipY / clipW) * 0.5 + 0.5)) * res);

            if (sx >= 0 && sx < res && sy >= 0 && sy < res) {
                projectedList.push({ pixel: sy * res + sx, depth, alpha });
            }
        }

        // --- Pass 2: sort front-to-back ---
        projectedList.sort((a, b) => a.depth - b.depth);

        // --- Pass 3: accumulate alpha-blended depth per pixel ---
        const depthAccum = new Float32Array(res * res);
        const weightAccum = new Float32Array(res * res);
        const transmittance = new Float32Array(res * res);
        transmittance.fill(1.0);

        for (const { pixel, depth, alpha } of projectedList) {
            const T = transmittance[pixel];
            if (T < 1e-4) continue;
            const w = alpha * T;
            depthAccum[pixel] += w * depth;
            weightAccum[pixel] += w;
            transmittance[pixel] = T * (1 - alpha);
        }

        // --- Pass 4: back-project pixels with valid depth to world space ---
        // Perspective back-projection:
        //   viewZ = -depth
        //   viewX = ndcX * depth / proj[0]   (proj[0] = projMatrix[0][0])
        //   viewY = ndcY * depth / proj[5]   (proj[5] = projMatrix[1][1])
        //   worldPos = cameraWorldMatrix * viewPos
        const fx = projd[0];  // focal length x in projection matrix
        const fy = projd[5];  // focal length y in projection matrix
        const camWorld = cameraWorldMatrix.data;

        const worldPositions: number[] = [];
        const colors: number[] = [];

        // Find depth range for colormap
        let minD = Infinity, maxD = -Infinity;
        for (let i = 0; i < res * res; i++) {
            if (weightAccum[i] > 1e-4) {
                const d = depthAccum[i] / weightAccum[i];
                if (d < minD) minD = d;
                if (d > maxD) maxD = d;
            }
        }
        const depthRange = maxD > minD ? maxD - minD : 1.0;

        for (let sy = 0; sy < res; sy++) {
            for (let sx = 0; sx < res; sx++) {
                const idx = sy * res + sx;
                if (weightAccum[idx] < 1e-4) continue;

                const depth = depthAccum[idx] / weightAccum[idx];

                // Pixel → NDC
                const ndcX = (sx + 0.5) / res * 2.0 - 1.0;
                const ndcY = 1.0 - (sy + 0.5) / res * 2.0;

                // NDC + depth → view space
                const vx = ndcX * depth / fx;
                const vy = ndcY * depth / fy;
                const vz = -depth;

                // View space → world space (multiply by camera world transform)
                const wx = camWorld[0] * vx + camWorld[4] * vy + camWorld[8] * vz + camWorld[12];
                const wy = camWorld[1] * vx + camWorld[5] * vy + camWorld[9] * vz + camWorld[13];
                const wz = camWorld[2] * vx + camWorld[6] * vy + camWorld[10] * vz + camWorld[14];

                worldPositions.push(wx, wy, wz);

                // Depth colormap: blue(near) → cyan → green → yellow → red(far)
                const t = Math.max(0, Math.min(1, (depth - minD) / depthRange));
                let r: number, g: number, b: number;
                if (t < 0.25) {
                    const s = t / 0.25;
                    r = 0; g = Math.floor(s * 255); b = 255;
                } else if (t < 0.5) {
                    const s = (t - 0.25) / 0.25;
                    r = 0; g = 255; b = Math.floor((1 - s) * 255);
                } else if (t < 0.75) {
                    const s = (t - 0.5) / 0.25;
                    r = Math.floor(s * 255); g = 255; b = 0;
                } else {
                    const s = (t - 0.75) / 0.25;
                    r = 255; g = Math.floor((1 - s) * 255); b = 0;
                }
                colors.push(r, g, b, 200);
            }
        }

        const pointCount = worldPositions.length / 3;
        if (pointCount === 0) return;

        // --- Create mesh with vertex buffer ---
        const device = this.app.graphicsDevice;

        const format = new VertexFormat(device, [
            { semantic: SEMANTIC_POSITION, components: 3, type: TYPE_FLOAT32 },
            { semantic: SEMANTIC_COLOR, components: 4, type: TYPE_UINT8, normalize: true }
        ]);

        const vb = new VertexBuffer(device, format, pointCount, { usage: BUFFER_STATIC });
        const vbData = vb.lock();
        const floatView = new Float32Array(vbData);
        const uint8View = new Uint8Array(vbData);

        // Stride in bytes: 3 floats (12 bytes) + 4 uint8 (4 bytes) = 16 bytes
        const strideBytes = 16;
        const strideFloats = strideBytes / 4;

        for (let i = 0; i < pointCount; i++) {
            const fi = i * strideFloats;
            floatView[fi] = worldPositions[i * 3];
            floatView[fi + 1] = worldPositions[i * 3 + 1];
            floatView[fi + 2] = worldPositions[i * 3 + 2];
            // Color bytes at offset 12 within each vertex
            const byteOffset = i * strideBytes + 12;
            uint8View[byteOffset] = colors[i * 4];
            uint8View[byteOffset + 1] = colors[i * 4 + 1];
            uint8View[byteOffset + 2] = colors[i * 4 + 2];
            uint8View[byteOffset + 3] = colors[i * 4 + 3];
        }
        vb.unlock();

        this.frozenDepthMesh = new Mesh(device);
        this.frozenDepthMesh.vertexBuffer = vb;
        this.frozenDepthMesh.primitive[0] = {
            type: PRIMITIVE_POINTS,
            base: 0,
            baseVertex: 0,
            count: pointCount,
            indexed: false
        };

        // Simple passthrough shader for world-space points with vertex color
        this.frozenDepthMaterial = new ShaderMaterial({
            uniqueName: 'frozenDepthMaterial',
            vertexGLSL: /* glsl */ `
                attribute vec3 vertex_position;
                attribute vec4 vertex_color;
                uniform mat4 matrix_viewProjection;
                uniform float pointSize;
                varying vec4 vColor;
                void main() {
                    gl_Position = matrix_viewProjection * vec4(vertex_position, 1.0);
                    gl_PointSize = pointSize;
                    vColor = vertex_color;
                }
            `,
            fragmentGLSL: /* glsl */ `
                varying vec4 vColor;
                void main() {
                    gl_FragColor = vColor;
                }
            `
        });
        this.frozenDepthMaterial.blendType = BLEND_NORMAL;
        this.frozenDepthMaterial.depthWrite = false;
        this.frozenDepthMaterial.depthTest = true;
        this.frozenDepthMaterial.depthFunc = 7; // FUNC_ALWAYS
        this.frozenDepthMaterial.setParameter('pointSize', 2.0 * window.devicePixelRatio);
        this.frozenDepthMaterial.update();

        const mi = new MeshInstance(this.frozenDepthMesh, this.frozenDepthMaterial, null);
        mi.cull = false;

        this.frozenDepthEntity = new Entity('frozenDepthCloud');
        this.frozenDepthEntity.addComponent('render', {
            meshInstances: [mi],
            layers: [this.app.scene.layers.getLayerByName('World').id]
        });
        // Add to scene root (world space positions, not relative to gsplat)
        this.app.root.addChild(this.frozenDepthEntity);

        this.depthFrozen = true;
        this.showDepthVisualization = true;

        console.log(`Frozen depth cloud: ${pointCount} points back-projected`);
    }

    /**
     * Unfreeze depth - remove the back-projected point cloud.
     */
    unfreezeDepth() {
        this.depthFrozen = false;
        if (this.frozenDepthEntity) {
            this.frozenDepthEntity.destroy();
            this.frozenDepthEntity = null;
        }
        if (this.frozenDepthMesh) {
            this.frozenDepthMesh.vertexBuffer?.destroy();
            this.frozenDepthMesh = null;
        }
        this.frozenDepthMaterial = null;
    }

    /**
     * Whether depth is currently frozen
     */
    get isDepthFrozen(): boolean {
        return this.depthFrozen;
    }

    /**
     * Freeze filtered points: take the current filter state and back-project
     * filtered splat positions to a world-space red point cloud.
     */
    freezeFilter(positions: Vec3[]) {
        this.unfreezeFilter();

        if (!this.filterStateTexture || !this.gsplatEntity || !positions || positions.length === 0) return;

        const gsplatWorldMatrix = this.gsplatEntity.getWorldTransform();
        const gwd = gsplatWorldMatrix.data;
        const numSplats = Math.min(positions.length, this.splatTexWidth * this.splatTexHeight);

        // Read current filter state texture to find which splats are filtered
        const filterPixels = this.filterStateTexture.lock();
        const worldPositions: number[] = [];
        const colors: number[] = [];

        for (let i = 0; i < numSplats; i++) {
            const isFiltered = filterPixels[i * 4] > 127; // R > 0.5 means filtered
            if (!isFiltered) continue;

            // Transform local position to world space
            const lx = positions[i].x, ly = positions[i].y, lz = positions[i].z;
            const wx = gwd[0] * lx + gwd[4] * ly + gwd[8] * lz + gwd[12];
            const wy = gwd[1] * lx + gwd[5] * ly + gwd[9] * lz + gwd[13];
            const wz = gwd[2] * lx + gwd[6] * ly + gwd[10] * lz + gwd[14];

            worldPositions.push(wx, wy, wz);
            colors.push(255, 50, 50, 200); // red
        }
        this.filterStateTexture.unlock();

        const pointCount = worldPositions.length / 3;
        if (pointCount === 0) return;

        // Build mesh
        const device = this.app.graphicsDevice;
        const format = new VertexFormat(device, [
            { semantic: SEMANTIC_POSITION, components: 3, type: TYPE_FLOAT32 },
            { semantic: SEMANTIC_COLOR, components: 4, type: TYPE_UINT8, normalize: true }
        ]);

        const vb = new VertexBuffer(device, format, pointCount, { usage: BUFFER_STATIC });
        const vbData = vb.lock();
        const floatView = new Float32Array(vbData);
        const uint8View = new Uint8Array(vbData);
        const strideBytes = 16;
        const strideFloats = strideBytes / 4;

        for (let i = 0; i < pointCount; i++) {
            const fi = i * strideFloats;
            floatView[fi] = worldPositions[i * 3];
            floatView[fi + 1] = worldPositions[i * 3 + 1];
            floatView[fi + 2] = worldPositions[i * 3 + 2];
            const byteOffset = i * strideBytes + 12;
            uint8View[byteOffset] = colors[i * 4];
            uint8View[byteOffset + 1] = colors[i * 4 + 1];
            uint8View[byteOffset + 2] = colors[i * 4 + 2];
            uint8View[byteOffset + 3] = colors[i * 4 + 3];
        }
        vb.unlock();

        this.frozenFilterMesh = new Mesh(device);
        this.frozenFilterMesh.vertexBuffer = vb;
        this.frozenFilterMesh.primitive[0] = {
            type: PRIMITIVE_POINTS,
            base: 0,
            baseVertex: 0,
            count: pointCount,
            indexed: false
        };

        this.frozenFilterMaterial = new ShaderMaterial({
            uniqueName: 'frozenFilterMaterial',
            vertexGLSL: /* glsl */ `
                attribute vec3 vertex_position;
                attribute vec4 vertex_color;
                uniform mat4 matrix_viewProjection;
                uniform float pointSize;
                varying vec4 vColor;
                void main() {
                    gl_Position = matrix_viewProjection * vec4(vertex_position, 1.0);
                    gl_PointSize = pointSize;
                    vColor = vertex_color;
                }
            `,
            fragmentGLSL: /* glsl */ `
                varying vec4 vColor;
                void main() {
                    gl_FragColor = vColor;
                }
            `
        });
        this.frozenFilterMaterial.blendType = BLEND_NORMAL;
        this.frozenFilterMaterial.depthWrite = false;
        this.frozenFilterMaterial.depthTest = true;
        this.frozenFilterMaterial.depthFunc = 7;
        this.frozenFilterMaterial.setParameter('pointSize', 3.0 * window.devicePixelRatio);
        this.frozenFilterMaterial.update();

        const mi = new MeshInstance(this.frozenFilterMesh, this.frozenFilterMaterial, null);
        mi.cull = false;

        this.frozenFilterEntity = new Entity('frozenFilterCloud');
        this.frozenFilterEntity.addComponent('render', {
            meshInstances: [mi],
            layers: [this.app.scene.layers.getLayerByName('World').id]
        });
        this.app.root.addChild(this.frozenFilterEntity);

        this.filterFrozen = true;
        console.log(`Frozen filter cloud: ${pointCount} filtered points`);
    }

    /**
     * Unfreeze filter - remove the frozen filter point cloud.
     */
    unfreezeFilter() {
        this.filterFrozen = false;
        if (this.frozenFilterEntity) {
            this.frozenFilterEntity.destroy();
            this.frozenFilterEntity = null;
        }
        if (this.frozenFilterMesh) {
            this.frozenFilterMesh.vertexBuffer?.destroy();
            this.frozenFilterMesh = null;
        }
        this.frozenFilterMaterial = null;
    }

    get isFilterFrozen(): boolean {
        return this.filterFrozen;
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
        return {
            total: this.totalPoints,
            filtered: this.filteredPointsCount,
            visible: this.totalPoints - this.filteredPointsCount
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
        if (!this.filterStateTexture || !this.gsplatEntity || !positions || positions.length === 0) {
            return;
        }

        const cam = cameraEntity.camera;
        if (!cam) return;

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
            pixels[idx] = isFiltered ? 255 : 0;
            pixels[idx + 1] = 0;
            pixels[idx + 2] = 0;
            pixels[idx + 3] = 255;
        }

        // Clear remaining pixels
        for (let i = numSplats; i < this.splatTexWidth * this.splatTexHeight; i++) {
            const idx = i * 4;
            pixels[idx] = 0;
            pixels[idx + 1] = 0;
            pixels[idx + 2] = 0;
            pixels[idx + 3] = 255;
        }

        this.filterStateTexture.unlock();
        this.filteredPointsCount = filteredCount;

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
            pixels[i] = 0;
            pixels[i + 1] = 0;
            pixels[i + 2] = 0;
            pixels[i + 3] = 255;
        }
        this.filterStateTexture.unlock();
        this.filteredPointsCount = 0;
    }

    /**
     * Set cursor position for proximity highlighting
     * When enabled, points near this position will automatically change color
     * @param position - World space position of cursor
     * @param enabled - Whether to enable cursor highlighting
     */
    setCursorPosition(position: Vec3 | null, enabled = true) {
        if (position) {
            this.cursorPosition.copy(position);
            this.cursorHighlightEnabled = enabled;
        } else {
            this.cursorHighlightEnabled = false;
        }
    }

    /**
     * Set the radius for cursor proximity highlighting
     * @param radius - Radius in world units
     */
    setCursorHighlightRadius(radius: number) {
        this.cursorHighlightRadius = radius;
    }

    /**
     * Set the highlight color for cursor proximity
     * @param color - Main highlight color (for points very close to cursor)
     * @param neighborColor - Neighbor highlight color (for points in outer radius)
     */
    setCursorHighlightColor(color: Color, neighborColor?: Color) {
        this.cursorHighlightColor.copy(color);
        if (neighborColor) {
            this.cursorNeighborColor.copy(neighborColor);
        }
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
        this.unfreezeDepth();
        this.unfreezeFilter();
        this.detach();
        if (this.filterStateTexture) {
            this.filterStateTexture.destroy();
            this.filterStateTexture = null;
        }
    }
}

export { CentersOverlay };

