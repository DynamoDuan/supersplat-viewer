import {
    BLEND_NORMAL,
    PRIMITIVE_POINTS,
    Color,
    Entity,
    GSplatComponent,
    ShaderMaterial,
    Mesh,
    MeshInstance,
    Vec3,
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

        // Create shader material
        this.material = new ShaderMaterial({
            uniqueName: 'centersOverlayMaterial',
            vertexGLSL: vertexShader,
            fragmentGLSL: fragmentShader
        });
        this.material.blendType = BLEND_NORMAL;
        this.material.depthWrite = false;
        // Enable depth test but use ALWAYS function to ensure centers render on top
        // This ensures centers are not occluded by gaussians
        this.material.depthTest = true;
        this.material.depthFunc = 7; // FUNC_ALWAYS (always pass depth test)
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
        const instance = gsplat.instance;
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
        this.detach();
    }
}

export { CentersOverlay };

