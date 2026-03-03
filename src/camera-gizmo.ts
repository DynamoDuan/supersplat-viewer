import {
    Entity,
    Vec3,
    Color,
    StandardMaterial,
    BLEND_NONE,
    CULLFACE_NONE
} from 'playcanvas';

class CameraGizmo {
    entity: Entity;

    constructor(parent: Entity) {
        this.entity = new Entity('camera-gizmo');
        parent.addChild(this.entity);

        // Create camera body (box)
        const body = new Entity('camera-body');
        body.addComponent('render', {
            type: 'box',
            material: this.createMaterial(new Color(0.2, 0.2, 0.8))
        });
        body.setLocalScale(0.08, 0.06, 0.1);
        this.entity.addChild(body);

        // Create lens (cylinder pointing forward) - BLACK to show front
        const lens = new Entity('camera-lens');
        lens.addComponent('render', {
            type: 'cylinder',
            material: this.createMaterial(new Color(0.1, 0.1, 0.1))
        });
        lens.setLocalScale(0.04, 0.03, 0.04);
        lens.setLocalPosition(0, 0, -0.08);
        lens.setLocalEulerAngles(90, 0, 0);
        this.entity.addChild(lens);

        // Create a RED cone pointing forward to clearly show camera direction
        const directionCone = new Entity('direction-cone');
        directionCone.addComponent('render', {
            type: 'cone',
            material: this.createMaterial(new Color(1, 0, 0))
        });
        directionCone.setLocalScale(0.03, 0.08, 0.03);
        directionCone.setLocalPosition(0, 0, -0.15);
        directionCone.setLocalEulerAngles(-90, 0, 0);
        this.entity.addChild(directionCone);

        // Create frustum lines to show view direction
        this.createFrustumLines();
    }

    private createMaterial(color: Color): StandardMaterial {
        const material = new StandardMaterial();
        material.diffuse = color;
        material.emissive = color.clone().mulScalar(0.3);
        material.blendType = BLEND_NONE;
        material.cull = CULLFACE_NONE;
        material.update();
        return material;
    }

    private createFrustumLines() {
        // Create 4 lines representing the camera frustum
        const frustumDepth = 0.3;
        const frustumSize = 0.15;

        const corners = [
            new Vec3(-frustumSize, -frustumSize, -frustumDepth),
            new Vec3(frustumSize, -frustumSize, -frustumDepth),
            new Vec3(frustumSize, frustumSize, -frustumDepth),
            new Vec3(-frustumSize, frustumSize, -frustumDepth)
        ];

        // Create lines from camera center to frustum corners
        corners.forEach((corner, i) => {
            const line = new Entity(`frustum-line-${i}`);
            line.addComponent('render', {
                type: 'cylinder',
                material: this.createMaterial(new Color(0.8, 0.8, 0.2))
            });

            const length = corner.length();
            const midpoint = corner.clone().mulScalar(0.5);

            line.setLocalScale(0.005, length / 2, 0.005);
            line.setLocalPosition(midpoint);

            // Orient cylinder towards corner
            const dir = corner.clone().normalize();
            const up = new Vec3(0, 1, 0);
            line.lookAt(line.getPosition().add(dir), up);
            line.rotateLocal(90, 0, 0);

            this.entity.addChild(line);
        });
    }

    setPositionAndRotation(position: Vec3, forward: Vec3, up: Vec3) {
        this.entity.setPosition(position);
        this.entity.lookAt(position.clone().add(forward), up);
    }

    setVisible(visible: boolean) {
        this.entity.enabled = visible;
    }
}

export { CameraGizmo };
