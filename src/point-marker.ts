import {
    Color,
    Entity,
    Mat4,
    Mesh,
    MeshInstance,
    SphereGeometry,
    StandardMaterial,
    Vec3,
    type AppBase,
    type GSplatComponent
} from 'playcanvas';

export interface MarkedPoint {
    index: number;           // 点在点云中的索引
    position: Vec3;          // 世界坐标位置
    colorId: number;         // 固定颜色ID (0-19)
    originalColor: Color;    // 原始颜色
}

const MAX_POINTS = 20;

// Pre-calculate 20 colors with higher contrast
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
    let r, g, b;
    if (s === 0) {
        r = g = b = l;
    } else {
        const hue2rgb = (p: number, q: number, t: number) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1/6) return p + (q - p) * 6 * t;
            if (t < 1/2) return q;
            if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
    }
    return { r, g, b };
}

const preCalculatedColors: Color[] = [];
for (let i = 0; i < MAX_POINTS; i++) {
    const hue = (i * 360 / MAX_POINTS) % 360;
    const lightnessPattern = [0.3, 0.5, 0.7, 0.4, 0.6];
    const lightness = lightnessPattern[i % lightnessPattern.length];
    const rgb = hslToRgb(hue / 360, 1.0, lightness);
    preCalculatedColors.push(new Color(rgb.r, rgb.g, rgb.b));
}

export class PointMarker {
    private app: AppBase;
    gsplatEntity: Entity | null = null;
    private scene: Entity | null = null;
    
    selectedPoints: MarkedPoint[] = [];
    private nextColorId = 0;
    private pointSpheres = new Map<number, { entity: Entity; meshInstance: MeshInstance; isHovered: boolean }>();
    hoveredListItemIndex: number | null = null;
    private currentSphereSize = 0.01; // Large size for better visibility
    
    // Callbacks
    onPointsChanged?: () => void;
    onHoverChanged?: (index: number | null) => void;

    constructor(app: AppBase, scene?: Entity) {
        this.app = app;
        this.scene = scene || null;
    }

    attach(gsplatEntity: Entity) {
        this.gsplatEntity = gsplatEntity;
        // Use gsplatEntity as the parent for adding spheres (like CentersOverlay does)
        this.scene = gsplatEntity;
        console.log('PointMarker: attach called, scene set to gsplatEntity:', this.scene?.name || 'unnamed', 'scene exists:', !!this.scene);
    }

    getPointColor(colorId: number): Color {
        if (colorId >= 0 && colorId < MAX_POINTS) {
            return preCalculatedColors[colorId];
        }
        // Fallback: calculate dynamically if more than MAX_POINTS
        const hue = (colorId * 360 / MAX_POINTS) % 360;
        const lightnessPattern = [0.3, 0.5, 0.7, 0.4, 0.6];
        const lightness = lightnessPattern[colorId % lightnessPattern.length];
        const rgb = hslToRgb(hue / 360, 1.0, lightness);
        return new Color(rgb.r, rgb.g, rgb.b);
    }

    colorToCSS(color: Color): string {
        const r = Math.round(color.r * 255);
        const g = Math.round(color.g * 255);
        const b = Math.round(color.b * 255);
        return `rgb(${r}, ${g}, ${b})`;
    }

    selectPoint(index: number, position: Vec3, originalColor: Color): boolean {
        // Check if already selected
        if (this.selectedPoints.find(p => p.index === index)) {
            return false; // Already selected
        }

        // Assign a fixed colorId to this point
        const colorId = this.nextColorId++;
        const point: MarkedPoint = {
            index,
            position: position.clone(),
            colorId,
            originalColor: originalColor.clone()
        };

        this.selectedPoints.push(point);
        this.createOrUpdateSphere(colorId);
        this.app.renderNextFrame = true;
        this.onPointsChanged?.();
        return true;
    }

    deletePointByIndex(arrayIndex: number): boolean {
        if (arrayIndex < 0 || arrayIndex >= this.selectedPoints.length) {
            return false;
        }

        const pointToDelete = this.selectedPoints[arrayIndex];
        const colorIdToDelete = pointToDelete.colorId;
        
        // Clear hover state if deleted point was hovered
        if (this.hoveredListItemIndex === arrayIndex) {
            this.setHoveredListItem(null);
        } else if (this.hoveredListItemIndex !== null && this.hoveredListItemIndex > arrayIndex) {
            this.setHoveredListItem(this.hoveredListItemIndex - 1);
        }
        
        // Remove only this one sphere
        this.removeSphere(colorIdToDelete);

        // Remove from array
        this.selectedPoints.splice(arrayIndex, 1);

        this.app.renderNextFrame = true;
        this.onPointsChanged?.();
        return true;
    }

    deleteLastPoint(): boolean {
        if (this.selectedPoints.length === 0) return false;
        return this.deletePointByIndex(this.selectedPoints.length - 1);
    }

    clearAll(): void {
        // Remove all spheres
        this.pointSpheres.forEach((sphereData) => {
            if (sphereData.entity) {
                sphereData.entity.destroy();
            }
        });
        this.pointSpheres.clear();
        
        this.selectedPoints = [];
        this.nextColorId = 0;
        this.setHoveredListItem(null);
        this.app.renderNextFrame = true;
        this.onPointsChanged?.();
    }

    reorderPoints(fromIndex: number, toIndex: number): void {
        if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || 
            fromIndex >= this.selectedPoints.length || toIndex > this.selectedPoints.length) {
            return;
        }
        
        // Move item from fromIndex to toIndex
        let targetIndex = toIndex;
        if (fromIndex < toIndex) {
            targetIndex = toIndex - 1;
        }
        
        const [movedItem] = this.selectedPoints.splice(fromIndex, 1);
        this.selectedPoints.splice(targetIndex, 0, movedItem);

        // Update hovered index if needed (only adjust list index, don't touch spheres)
        if (this.hoveredListItemIndex !== null) {
            if (this.hoveredListItemIndex === fromIndex) {
                this.hoveredListItemIndex = targetIndex;
            } else if (this.hoveredListItemIndex > fromIndex && this.hoveredListItemIndex <= targetIndex) {
                this.hoveredListItemIndex = this.hoveredListItemIndex - 1;
            } else if (this.hoveredListItemIndex < fromIndex && this.hoveredListItemIndex >= targetIndex) {
                this.hoveredListItemIndex = this.hoveredListItemIndex + 1;
            }
        }

        // Only update the UI list, don't touch any spheres
        this.onPointsChanged?.();
    }

    setHoveredListItem(index: number | null): void {
        const oldIndex = this.hoveredListItemIndex;
        this.hoveredListItemIndex = index;
        
        // Restore old sphere size
        if (oldIndex !== null && oldIndex < this.selectedPoints.length) {
            const oldPoint = this.selectedPoints[oldIndex];
            this.createOrUpdateSphere(oldPoint.colorId, false, false);
        }
        
        // Enlarge new sphere
        if (index !== null && index < this.selectedPoints.length) {
            const point = this.selectedPoints[index];
            this.createOrUpdateSphere(point.colorId, false, true);
        }

        this.app.renderNextFrame = true;
        this.onHoverChanged?.(index);
    }

    setSphereSize(size: number): void {
        this.currentSphereSize = size;
        this.updateAllSpheres();
        this.app.renderNextFrame = true;
    }

    private createOrUpdateSphere(colorId: number, updateSize = false, hoverSize = false): void {
        const point = this.selectedPoints.find(p => p.colorId === colorId);
        if (!point) return;
        
        const color = this.getPointColor(colorId);
        // Convert world position to local position relative to gsplatEntity
        let position = point.position.clone();
        if (this.gsplatEntity) {
            const worldMatrix = this.gsplatEntity.getWorldTransform();
            const invWorldMatrix = new Mat4();
            invWorldMatrix.invert(worldMatrix);
            const localPos = new Vec3();
            invWorldMatrix.transformPoint(position, localPos);
            position = localPos;
        }
        
        // Determine sphere size
        let sphereSize = this.currentSphereSize;
        if (hoverSize) {
            sphereSize = this.currentSphereSize * 2; // Double size when hovered
        }
        
        let sphereData = this.pointSpheres.get(colorId);
        
        // Check if we need to recreate sphere due to hover state change
        const needsSizeUpdate = sphereData && (sphereData.isHovered !== hoverSize);
        
        if (!sphereData || updateSize || needsSizeUpdate) {
            // Remove old sphere if exists
            if (sphereData && sphereData.entity) {
                sphereData.entity.destroy();
            }
            
            // Create new sphere using PlayCanvas geometry
            const material = new StandardMaterial();
            material.diffuse = color;
            material.emissive = color;
            material.emissiveIntensity = 0.5;
            // Enable depth test to render above Gaussian splats but respect depth
            material.depthTest = true;
            material.depthWrite = true;
            material.update();
            
            // Create sphere mesh
            const geometry = new SphereGeometry({
                radius: sphereSize,
                latitudeBands: 16,
                longitudeBands: 16
            });
            const mesh = Mesh.fromGeometry(this.app.graphicsDevice, geometry);
            
            const entity = new Entity();
            const meshInstance = new MeshInstance(mesh, material);

            // Set render order: render after Gaussian splats but before point cloud overlay
            // Gaussian splats render at default bucket (0), point cloud overlay at 300
            // So we use a value between them (e.g., 50) to render above splats but below overlay
            meshInstance.drawBucket = 50;
            meshInstance.cull = false;

            // Get the World layer from the scene
            const worldLayer = this.app.scene.layers.getLayerByName('World');

            entity.addComponent('render', {
                meshInstances: [meshInstance],
                layers: worldLayer ? [worldLayer.id] : []
            });
            entity.setPosition(position);
            // Ensure scene is set (in case attach wasn't called yet)
            if (!this.scene) {
                if (this.gsplatEntity) {
                    this.scene = this.gsplatEntity;
                    console.log('PointMarker: scene was null, setting to gsplatEntity');
                } else {
                    console.error('PointMarker: scene is null and gsplatEntity is also null, cannot add sphere');
                    return;
                }
            }
            if (!this.scene) {
                console.error('PointMarker: scene is still null after attempt to set, cannot add sphere');
                return;
            }
            console.log('PointMarker: Creating sphere at position', position, 'colorId:', colorId, 'size:', sphereSize, 'hoverSize:', hoverSize, 'scene:', this.scene.name || 'unnamed');
            this.scene.addChild(entity);
            console.log('PointMarker: Sphere added, entity children count:', this.scene.children.length);
            
            sphereData = { entity, meshInstance, isHovered: hoverSize };
            this.pointSpheres.set(colorId, sphereData);
        } else {
            // Update existing sphere (should not reach here if needsSizeUpdate is true)
            if (sphereData.entity) {
                // Just update position and color
                // Position is already converted to local coordinates above
                sphereData.entity.setPosition(position);
                const mat = sphereData.meshInstance.material as StandardMaterial;
                if (mat) {
                    mat.diffuse = color;
                    mat.emissive = color;
                    mat.update();
                }
                // Update hover state
                sphereData.isHovered = hoverSize;
            }
        }
    }

    private removeSphere(colorId: number): void {
        const sphereData = this.pointSpheres.get(colorId);
        if (sphereData && sphereData.entity) {
            sphereData.entity.destroy();
            this.pointSpheres.delete(colorId);
        }
    }

    private updateAllSpheres(): void {
        this.selectedPoints.forEach((point) => {
            const isHovered = this.hoveredListItemIndex !== null && 
                this.selectedPoints[this.hoveredListItemIndex]?.colorId === point.colorId;
            this.createOrUpdateSphere(point.colorId, true, isHovered);
        });
    }

    // Get sphere entity for a colorId (for external access if needed)
    getSphereEntity(colorId: number): Entity | null {
        const sphereData = this.pointSpheres.get(colorId);
        return sphereData?.entity || null;
    }

    // JSON export/import
    exportToJSON(): number[][] {
        return this.selectedPoints.map(point => [
            point.position.x,
            point.position.y,
            point.position.z
        ]);
    }

    async importFromJSON(
        jsonData: number[][], 
        findPointCallback: (x: number, y: number, z: number) => Promise<{ index: number; position: Vec3; color: Color } | null>
    ): Promise<number> {
        let loadedCount = 0;
        const tolerance = 0.001;
        
        // Clear existing points first
        this.clearAll();
        
        for (const pointData of jsonData) {
            if (!Array.isArray(pointData) || pointData.length < 3) {
                continue;
            }
            
            const [x, y, z] = pointData;
            const targetPos = new Vec3(x, y, z);
            const result = await findPointCallback(x, y, z);
            
            if (result) {
                const distance = result.position.distance(targetPos);
                if (distance <= tolerance) {
                    if (this.selectPoint(result.index, result.position, result.color)) {
                        loadedCount++;
                    }
                }
            }
        }
        
        return loadedCount;
    }

    setAllSpheresVisible(visible: boolean): void {
        this.pointSpheres.forEach((s) => { if (s.entity) s.entity.enabled = visible; });
        this.app.renderNextFrame = true;
    }

    destroy(): void {
        this.clearAll();
    }
}

