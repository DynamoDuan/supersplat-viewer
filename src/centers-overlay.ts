import {
    BLEND_NORMAL,
    PRIMITIVE_POINTS,
    Color,
    Entity,
    GSplatComponent,
    ShaderMaterial,
    StandardMaterial,
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
    private selectedColor = new Color(0.2, 1, 1, 1);  // Bright cyan for highlighted centers
    private unselectedColor = new Color(0.5, 0.5, 0.5, 0.8);
    private highlightedPointId = -1;
    private maxPoints = 100000;  // Maximum number of points to display (default: 100k)

    // Hover sphere for showing green ball on hovered point
    private hoverSphere: Entity | null = null;
    private hoveredPointPosition: Vec3 | null = null;

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
        // Disable depth test so centers render on top of splats
        this.material.depthTest = false;
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
        // Use a higher draw bucket to render after splats
        this.meshInstance.drawBucket = 200;
        this.meshInstance.cull = false;

        // Create entity
        this.entity = new Entity('centersOverlay');
        this.entity.addComponent('render', {
            meshInstances: [this.meshInstance],
            layers: [scene.layers.getLayerByName('World').id]
        });

        // Attach to gsplat entity
        gsplatEntity.addChild(this.entity);

        // Create hover sphere (green ball) for highlighting hovered point
        this.hoverSphere = new Entity('hoverSphere');

        // Create green material
        const greenMaterial = new StandardMaterial();
        greenMaterial.diffuse.set(0, 1, 0);  // Green color
        greenMaterial.emissive.set(0, 0.8, 0);  // Green emissive for visibility
        greenMaterial.opacity = 0.9;
        greenMaterial.blendType = BLEND_NORMAL;
        greenMaterial.depthTest = false;  // Always render on top
        greenMaterial.depthWrite = false;
        greenMaterial.update();

        this.hoverSphere.addComponent('render', {
            type: 'sphere',
            material: greenMaterial,
            layers: [scene.layers.getLayerByName('World').id]
        });
        this.hoverSphere.setLocalScale(0.05, 0.05, 0.05);  // Small sphere
        this.hoverSphere.enabled = false;  // Hidden by default

        // Attach to gsplat entity (in world space)
        gsplatEntity.addChild(this.hoverSphere);

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
        if (this.hoverSphere) {
            this.hoverSphere.remove();
            this.hoverSphere.destroy();
            this.hoverSphere = null;
        }
        this.mesh = null;
        this.material = null;
        this.meshInstance = null;
        this.gsplatEntity = null;
        this.hoveredPointPosition = null;
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

        // Update hover sphere
        if (this.hoverSphere && this.gsplatEntity) {
            if (this.hoveredPointPosition && this.enabled) {
                this.hoverSphere.enabled = true;
                // Convert world position to local position relative to gsplatEntity
                const worldTransform = this.gsplatEntity.getWorldTransform();
                const localPos = new Vec3();
                worldTransform.invert().transformPoint(this.hoveredPointPosition, localPos);
                this.hoverSphere.setLocalPosition(localPos);
            } else {
                this.hoverSphere.enabled = false;
            }
        }
    }

    /**
     * Set enabled state
     */
    setEnabled(enabled: boolean) {
        this.enabled = enabled;
        // Hide hover sphere when centers are disabled
        if (!enabled && this.hoverSphere) {
            this.hoverSphere.enabled = false;
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
     * Set hovered point position (shows green sphere at this position)
     */
    setHoveredPointPosition(position: Vec3 | null) {
        this.hoveredPointPosition = position;
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

