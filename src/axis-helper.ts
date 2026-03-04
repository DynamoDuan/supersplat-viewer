import { Entity, Vec3, Color, StandardMaterial, Quat } from 'playcanvas';
import type { AppBase } from 'playcanvas';

/**
 * Normal direction helper - displays the computed PCA normal in a prominent axis-style (cylinder + cone).
 * "Gravity" = the normal direction from selected points.
 */
class GravityHelper {
    private app: AppBase;
    private entities: Entity[] = [];
    private length = 1.5;  // Longer arrow for better visibility

    constructor(app: AppBase) {
        this.app = app;
    }

    /**
     * Set the normal direction to display. Centroid and normal in world space.
     */
    setNormal(centroid: Vec3, normal: Vec3): void {
        console.log('=== GravityHelper.setNormal called ===');
        console.log('Centroid:', centroid);
        console.log('Normal:', normal);

        this.clear();
        const n = normal.clone().normalize();
        const end = centroid.clone().add(n.clone().mulScalar(this.length));
        const color = new Color(1, 1, 0);  // Pure bright yellow

        console.log('Arrow start:', centroid);
        console.log('Arrow end:', end);
        console.log('Arrow length:', this.length);

        const shaft = this.createAxisLine(centroid, end, color);
        this.app.root.addChild(shaft);
        this.entities.push(shaft);
        console.log('Shaft entity created and added to root');

        const cone = new Entity('normal-cone');
        cone.addComponent('render', { type: 'cone' });
        const coneMat = new StandardMaterial();
        coneMat.diffuse = color;
        coneMat.emissive = color;
        coneMat.emissiveIntensity = 2.0;  // Brighter emission
        coneMat.depthTest = true;
        coneMat.depthWrite = true;
        coneMat.update();
        if (cone.render) cone.render.material = coneMat;
        cone.setLocalPosition(end.x, end.y, end.z);
        cone.setLocalScale(0.15, 0.15, 0.15);  // Even larger cone
        const from = new Vec3(0, 1, 0);
        cone.setLocalRotation(this.quatFromVectors(from, n));
        this.app.root.addChild(cone);
        this.entities.push(cone);
        console.log('Cone entity created and added to root');
        console.log('Total entities:', this.entities.length);
        this.app.renderNextFrame = true;
    }

    private quatFromVectors(from: Vec3, to: Vec3): Quat {
        const dot = from.dot(to);
        if (dot > 0.999999) return new Quat(0, 0, 0, 1);
        if (dot < -0.999999) {
            let perp = new Vec3(1, 0, 0);
            if (Math.abs(from.dot(perp)) > 0.9) perp = new Vec3(0, 0, 1);
            const axis = new Vec3().cross(from, perp).normalize();
            return new Quat(axis.x, axis.y, axis.z, 0);
        }
        const axis = new Vec3().cross(from, to);
        const q = new Quat(axis.x, axis.y, axis.z, 1 + dot);
        const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
        q.x /= len; q.y /= len; q.z /= len; q.w /= len;
        return q;
    }

    private createAxisLine(start: Vec3, end: Vec3, color: Color): Entity {
        const entity = new Entity('normal-axis');
        entity.addComponent('render', { type: 'cylinder' });

        const material = new StandardMaterial();
        material.diffuse = color;
        material.emissive = color;
        material.emissiveIntensity = 2.0;  // Brighter emission
        material.depthTest = true;
        material.depthWrite = true;
        material.update();
        if (entity.render) entity.render.material = material;

        const direction = new Vec3().sub2(end, start);
        const len = direction.length();
        const midpoint = new Vec3().add2(start, end).mulScalar(0.5);

        entity.setLocalPosition(midpoint.x, midpoint.y, midpoint.z);
        entity.setLocalScale(0.05, len / 2, 0.05);  // Much thicker shaft
        const from = new Vec3(0, 1, 0);
        entity.setLocalRotation(this.quatFromVectors(from, direction.clone().normalize()));
        return entity;
    }

    clear(): void {
        this.entities.forEach(e => e.destroy());
        this.entities = [];
    }

    destroy(): void {
        this.clear();
    }

    setVisible(visible: boolean): void {
        this.entities.forEach(e => {
            if (e.render) e.render.enabled = visible;
        });
    }
}

export { GravityHelper };
