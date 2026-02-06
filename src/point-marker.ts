import {
    Color,
    Entity,
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
    private scene: Entity;
    
    selectedPoints: MarkedPoint[] = [];
    private nextColorId = 0;
    private pointSpheres = new Map<number, { entity: Entity; meshInstance: MeshInstance }>();
    hoveredListItemIndex: number | null = null;
    private currentSphereSize = 0.005;
    
    // Callbacks
    onPointsChanged?: () => void;
    onHoverChanged?: (index: number | null) => void;

    constructor(app: AppBase, scene: Entity) {
        this.app = app;
        this.scene = scene;
    }

    attach(gsplatEntity: Entity) {
        this.gsplatEntity = gsplatEntity;
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
        
        // Remove sphere
        this.removeSphere(colorIdToDelete);
        
        // Remove from array
        this.selectedPoints.splice(arrayIndex, 1);
        
        // Recreate spheres for remaining points
        this.updateAllSpheres();
        
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
        
        // Update hovered index if needed
        if (this.hoveredListItemIndex !== null) {
            if (this.hoveredListItemIndex === fromIndex) {
                this.setHoveredListItem(targetIndex);
            } else if (this.hoveredListItemIndex > fromIndex && this.hoveredListItemIndex <= targetIndex) {
                this.setHoveredListItem(this.hoveredListItemIndex - 1);
            } else if (this.hoveredListItemIndex < fromIndex && this.hoveredListItemIndex >= targetIndex) {
                this.setHoveredListItem(this.hoveredListItemIndex + 1);
            }
        }
        
        // Recreate all spheres
        this.updateAllSpheres();
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
        
        this.onHoverChanged?.(index);
    }

    setSphereSize(size: number): void {
        this.currentSphereSize = size;
        this.updateAllSpheres();
    }

    private createOrUpdateSphere(colorId: number, updateSize = false, hoverSize = false): void {
        const point = this.selectedPoints.find(p => p.colorId === colorId);
        if (!point) return;
        
        const color = this.getPointColor(colorId);
        const position = point.position.clone();
        
        // Determine sphere size
        let sphereSize = this.currentSphereSize;
        if (hoverSize) {
            sphereSize = this.currentSphereSize * 2; // Double size when hovered
        }
        
        let sphereData = this.pointSpheres.get(colorId);
        
        if (!sphereData || updateSize) {
            // Remove old sphere if exists
            if (sphereData && sphereData.entity) {
                sphereData.entity.destroy();
            }
            
            // Create new sphere using PlayCanvas geometry
            const material = new StandardMaterial();
            material.diffuse = color;
            material.emissive = color;
            material.emissiveIntensity = 0.5;
            material.update();
            
            // Create sphere mesh
            const geometry = new SphereGeometry({
                radius: sphereSize,
                segments: 16
            });
            const mesh = Mesh.fromGeometry(this.app.graphicsDevice, geometry);
            
            const entity = new Entity();
            const meshInstance = new MeshInstance(mesh, material);
            entity.addComponent('render', {
                meshInstances: [meshInstance]
            });
            entity.setPosition(position);
            this.scene.addChild(entity);
            
            sphereData = { entity, meshInstance };
            this.pointSpheres.set(colorId, sphereData);
        } else {
            // Update existing sphere
            if (sphereData.entity) {
                sphereData.entity.setPosition(position);
                sphereData.meshInstance.material.diffuse = color;
                sphereData.meshInstance.material.emissive = color;
                sphereData.meshInstance.material.update();
                
                // Update size if needed
                if (hoverSize || updateSize) {
                    // Recreate mesh with new size
                    const oldMesh = sphereData.meshInstance.mesh;
                    const geometry = new SphereGeometry({
                        radius: sphereSize,
                        segments: 16
                    });
                    const newMesh = Mesh.fromGeometry(this.app.graphicsDevice, geometry);
                    sphereData.meshInstance.mesh = newMesh;
                    sphereData.entity.render.meshInstances = [sphereData.meshInstance];
                    if (oldMesh) {
                        oldMesh.destroy();
                    }
                }
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

    destroy(): void {
        this.clearAll();
    }
}

