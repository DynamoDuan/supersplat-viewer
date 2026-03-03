import { Entity, Vec3, Color, StandardMaterial } from 'playcanvas';
import type { AppBase } from 'playcanvas';

class AxisHelper {
    private entities: Entity[] = [];

    constructor(app: AppBase, length: number = 1.0) {
        // Create X axis (Red)
        const xAxis = this.createAxisLine(app, new Vec3(0, 0, 0), new Vec3(length, 0, 0), new Color(1, 0, 0));
        this.entities.push(xAxis);

        // Create Y axis (Green)
        const yAxis = this.createAxisLine(app, new Vec3(0, 0, 0), new Vec3(0, length, 0), new Color(0, 1, 0));
        this.entities.push(yAxis);

        // Create Z axis (Blue)
        const zAxis = this.createAxisLine(app, new Vec3(0, 0, 0), new Vec3(0, 0, length), new Color(0, 0, 1));
        this.entities.push(zAxis);

        // Add all axes to the scene
        this.entities.forEach(entity => app.root.addChild(entity));
    }

    private createAxisLine(app: AppBase, start: Vec3, end: Vec3, color: Color): Entity {
        const entity = new Entity('axis');

        // Create a simple cylinder to represent the axis
        entity.addComponent('render', {
            type: 'cylinder'
        });

        // Set material color
        const material = new StandardMaterial();
        material.diffuse = color;
        material.emissive = color;
        material.emissiveIntensity = 0.5;
        material.update();

        if (entity.render) {
            entity.render.material = material;
        }

        // Position and orient the cylinder
        const direction = new Vec3().sub2(end, start);
        const length = direction.length();
        const midpoint = new Vec3().add2(start, end).mulScalar(0.5);

        entity.setLocalPosition(midpoint);
        entity.setLocalScale(0.05, length / 2, 0.05); // Thicker cylinder

        // Rotate to align with direction
        if (Math.abs(direction.x) > 0.001) {
            // X axis - rotate 90° around Z
            entity.setLocalEulerAngles(0, 0, 90);
        } else if (Math.abs(direction.z) > 0.001) {
            // Z axis - rotate 90° around X
            entity.setLocalEulerAngles(90, 0, 0);
        }
        // Y axis - default orientation is already correct

        return entity;
    }

    destroy() {
        this.entities.forEach(entity => entity.destroy());
        this.entities = [];
    }

    setVisible(visible: boolean) {
        this.entities.forEach(entity => {
            if (entity.render) {
                entity.render.enabled = visible;
            }
        });
    }
}

export { AxisHelper };
