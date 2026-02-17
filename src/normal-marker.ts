import {
    Color,
    ConeGeometry,
    CylinderGeometry,
    Entity,
    Mat4,
    Mesh,
    MeshInstance,
    Quat,
    SphereGeometry,
    StandardMaterial,
    Vec3,
    type AppBase
} from 'playcanvas';

export interface NormalAnnotation {
    index: number;
    position: Vec3; // world-space position
}

export class NormalMarker {
    private app: AppBase;
    private gsplatEntity: Entity | null = null;

    points: NormalAnnotation[] = [];
    private pointSpheres: { entity: Entity; meshInstance: MeshInstance }[] = [];
    private arrowEntity: Entity | null = null;
    private currentSphereSize = 0.01;
    private computedNormal: Vec3 | null = null;
    private computedCentroid: Vec3 | null = null;
    private visible = true;

    onPointsChanged?: () => void;

    constructor(app: AppBase) {
        this.app = app;
    }

    attach(gsplatEntity: Entity): void {
        this.gsplatEntity = gsplatEntity;
    }

    addPoint(index: number, position: Vec3): boolean {
        // Check if already added
        if (this.points.find(p => p.index === index)) {
            return false;
        }

        this.points.push({
            index,
            position: position.clone()
        });

        this.createSphere(this.points.length - 1);
        this.app.renderNextFrame = true;
        this.onPointsChanged?.();
        return true;
    }

    deletePointByIndex(idx: number): void {
        if (idx < 0 || idx >= this.points.length) return;

        // Destroy the sphere
        const sphereData = this.pointSpheres[idx];
        if (sphereData?.entity) {
            sphereData.entity.destroy();
        }
        this.pointSpheres.splice(idx, 1);
        this.points.splice(idx, 1);

        this.app.renderNextFrame = true;
        this.onPointsChanged?.();
    }

    clearAll(): void {
        for (const s of this.pointSpheres) {
            if (s.entity) s.entity.destroy();
        }
        this.pointSpheres = [];
        this.points = [];
        this.clearArrow();
        this.computedNormal = null;
        this.computedCentroid = null;
        this.app.renderNextFrame = true;
        this.onPointsChanged?.();
    }

    setComputedNormal(normal: Vec3, centroid: Vec3): void {
        this.computedNormal = normal.clone();
        this.computedCentroid = centroid.clone();
        this.clearArrow();
        this.createArrow(centroid, normal);
        this.app.renderNextFrame = true;
    }

    clearArrow(): void {
        if (this.arrowEntity) {
            this.arrowEntity.destroy();
            this.arrowEntity = null;
        }
    }

    show(): void {
        this.visible = true;
        for (const s of this.pointSpheres) {
            if (s.entity) s.entity.enabled = true;
        }
        if (this.arrowEntity) this.arrowEntity.enabled = true;
        this.app.renderNextFrame = true;
    }

    hide(): void {
        this.visible = false;
        for (const s of this.pointSpheres) {
            if (s.entity) s.entity.enabled = false;
        }
        if (this.arrowEntity) this.arrowEntity.enabled = false;
        this.app.renderNextFrame = true;
    }

    setSphereSize(size: number): void {
        this.currentSphereSize = size;
        // Rebuild all spheres with new size
        for (let i = 0; i < this.points.length; i++) {
            const old = this.pointSpheres[i];
            if (old?.entity) old.entity.destroy();
            this.createSphere(i);
        }
        this.app.renderNextFrame = true;
    }

    getComputedNormal(): Vec3 | null {
        return this.computedNormal;
    }

    getComputedCentroid(): Vec3 | null {
        return this.computedCentroid;
    }

    exportToJSON(): { points: number[][]; normal: number[] | null; centroid: number[] | null } {
        return {
            points: this.points.map(p => [p.position.x, p.position.y, p.position.z]),
            normal: this.computedNormal ? [this.computedNormal.x, this.computedNormal.y, this.computedNormal.z] : null,
            centroid: this.computedCentroid ? [this.computedCentroid.x, this.computedCentroid.y, this.computedCentroid.z] : null
        };
    }

    private createSphere(idx: number): void {
        const point = this.points[idx];
        if (!point || !this.gsplatEntity) return;

        // Convert world position to local coords relative to gsplatEntity
        const worldMatrix = this.gsplatEntity.getWorldTransform();
        const invWorldMatrix = new Mat4();
        invWorldMatrix.invert(worldMatrix);
        const localPos = new Vec3();
        invWorldMatrix.transformPoint(point.position, localPos);

        // Green material
        const greenColor = new Color(0, 1, 0);
        const material = new StandardMaterial();
        material.diffuse = greenColor;
        material.emissive = greenColor;
        material.emissiveIntensity = 0.5;
        material.depthTest = true;
        material.depthWrite = true;
        material.update();

        const geometry = new SphereGeometry({
            radius: this.currentSphereSize,
            latitudeBands: 16,
            longitudeBands: 16
        });
        const mesh = Mesh.fromGeometry(this.app.graphicsDevice, geometry);
        const entity = new Entity();
        const meshInstance = new MeshInstance(mesh, material);
        meshInstance.drawBucket = 50;
        meshInstance.cull = false;

        const worldLayer = this.app.scene.layers.getLayerByName('World');
        entity.addComponent('render', {
            meshInstances: [meshInstance],
            layers: worldLayer ? [worldLayer.id] : []
        });
        entity.setPosition(localPos);
        entity.enabled = this.visible;
        this.gsplatEntity.addChild(entity);

        // Ensure array is large enough
        while (this.pointSpheres.length <= idx) {
            this.pointSpheres.push(null as any);
        }
        this.pointSpheres[idx] = { entity, meshInstance };
    }

    private createArrow(centroid: Vec3, normal: Vec3): void {
        if (!this.gsplatEntity) return;

        const worldMatrix = this.gsplatEntity.getWorldTransform();
        const invWorldMatrix = new Mat4();
        invWorldMatrix.invert(worldMatrix);

        // Convert centroid to local coords
        const localCentroid = new Vec3();
        invWorldMatrix.transformPoint(centroid, localCentroid);

        // Create parent entity for arrow
        const arrowParent = new Entity('normal-arrow');

        // Arrow dimensions (scaled to be clearly visible)
        const shaftHeight = 0.15;
        const shaftRadius = 0.005;
        const headHeight = 0.03;
        const headRadius = 0.015;

        const redColor = new Color(1, 0, 0);

        // --- Shaft ---
        const shaftMat = new StandardMaterial();
        shaftMat.diffuse = redColor;
        shaftMat.emissive = redColor;
        shaftMat.emissiveIntensity = 1.0;
        shaftMat.depthTest = true;
        shaftMat.depthWrite = true;
        shaftMat.update();

        const shaftGeo = new CylinderGeometry({
            radius: shaftRadius,
            height: shaftHeight,
            heightSegments: 1,
            capSegments: 8
        });
        const shaftMesh = Mesh.fromGeometry(this.app.graphicsDevice, shaftGeo);
        const shaftEntity = new Entity('shaft');
        const shaftMI = new MeshInstance(shaftMesh, shaftMat);
        shaftMI.drawBucket = 50;
        shaftMI.cull = false;

        const worldLayer = this.app.scene.layers.getLayerByName('World');
        shaftEntity.addComponent('render', {
            meshInstances: [shaftMI],
            layers: worldLayer ? [worldLayer.id] : []
        });
        // Cylinder is centered at origin along Y. Shift up so bottom is at origin.
        shaftEntity.setLocalPosition(0, shaftHeight / 2, 0);

        // --- Head ---
        const headMat = new StandardMaterial();
        headMat.diffuse = redColor;
        headMat.emissive = redColor;
        headMat.emissiveIntensity = 1.0;
        headMat.depthTest = true;
        headMat.depthWrite = true;
        headMat.update();

        const headGeo = new ConeGeometry({
            baseRadius: headRadius,
            peakRadius: 0,
            height: headHeight,
            heightSegments: 1,
            capSegments: 8
        });
        const headMesh = Mesh.fromGeometry(this.app.graphicsDevice, headGeo);
        const headEntity = new Entity('head');
        const headMI = new MeshInstance(headMesh, headMat);
        headMI.drawBucket = 50;
        headMI.cull = false;

        headEntity.addComponent('render', {
            meshInstances: [headMI],
            layers: worldLayer ? [worldLayer.id] : []
        });
        // Place head on top of shaft
        headEntity.setLocalPosition(0, shaftHeight + headHeight / 2, 0);

        arrowParent.addChild(shaftEntity);
        arrowParent.addChild(headEntity);

        // Position at centroid in local space
        arrowParent.setLocalPosition(localCentroid);

        // Orient: arrow is built along +Y, we need to rotate it to point along `normal`
        // Compute quaternion that rotates (0,1,0) to `normal` direction
        // We need to transform the normal direction into local space as well
        // Since normal is a direction (not a point), we use the inverse transpose for normals,
        // but for uniform scale the inverse matrix works fine.
        const localNormal = new Vec3();
        // Transform direction: apply rotation only (no translation)
        const invRot = new Mat4();
        invRot.copy(invWorldMatrix);
        // Zero out translation for direction transform
        invRot.data[12] = 0;
        invRot.data[13] = 0;
        invRot.data[14] = 0;
        invRot.transformPoint(normal, localNormal);
        localNormal.normalize();

        const from = new Vec3(0, 1, 0);
        const quat = this.quatFromVectors(from, localNormal);
        arrowParent.setLocalRotation(quat);

        arrowParent.enabled = this.visible;
        this.gsplatEntity.addChild(arrowParent);
        this.arrowEntity = arrowParent;
    }

    private quatFromVectors(from: Vec3, to: Vec3): Quat {
        // Quaternion that rotates `from` to `to`
        const dot = from.dot(to);
        if (dot > 0.999999) {
            return new Quat(0, 0, 0, 1); // identity
        }
        if (dot < -0.999999) {
            // 180 degree rotation: pick an arbitrary perpendicular axis
            let perp = new Vec3(1, 0, 0);
            if (Math.abs(from.dot(perp)) > 0.9) {
                perp = new Vec3(0, 0, 1);
            }
            const axis = new Vec3();
            axis.cross(from, perp);
            axis.normalize();
            return new Quat(axis.x, axis.y, axis.z, 0); // 180 deg
        }
        const axis = new Vec3();
        axis.cross(from, to);
        const q = new Quat(axis.x, axis.y, axis.z, 1 + dot);
        // Normalize
        const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
        q.x /= len;
        q.y /= len;
        q.z /= len;
        q.w /= len;
        return q;
    }

    destroy(): void {
        this.clearAll();
    }
}
