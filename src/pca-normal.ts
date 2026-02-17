import { Mat4, Vec3 } from 'playcanvas';

/**
 * Compute PCA surface normal from selected point indices.
 * For each selected index, transforms position to world space, finds neighbors within radius,
 * then computes PCA to find the smallest eigenvector (= surface normal).
 */
export function computePCANormalFromPoints(
    selectedIndices: number[],
    allPositions: Vec3[],
    worldMatrix: Mat4,
    neighborRadius = 0.01
): Vec3 | null {
    if (selectedIndices.length < 3 || allPositions.length === 0) return null;

    // Collect all points from selected indices and their neighbors
    const allPoints: number[][] = [];

    for (const pointIndex of selectedIndices) {
        if (pointIndex < 0 || pointIndex >= allPositions.length) continue;

        const centerPoint = new Vec3();
        worldMatrix.transformPoint(allPositions[pointIndex], centerPoint);

        // Find neighbors within radius
        for (let i = 0; i < allPositions.length; i++) {
            const pointPos = new Vec3();
            worldMatrix.transformPoint(allPositions[i], pointPos);

            const distance = centerPoint.distance(pointPos);
            if (distance <= neighborRadius) {
                allPoints.push([pointPos.x, pointPos.y, pointPos.z]);
            }
        }
    }

    if (allPoints.length < 3) {
        return null;
    }

    // Compute mean
    const mean = [0, 0, 0];
    for (const p of allPoints) {
        mean[0] += p[0];
        mean[1] += p[1];
        mean[2] += p[2];
    }
    mean[0] /= allPoints.length;
    mean[1] /= allPoints.length;
    mean[2] /= allPoints.length;

    // Center the points
    const centered = allPoints.map(p => [
        p[0] - mean[0],
        p[1] - mean[1],
        p[2] - mean[2]
    ]);

    // Compute 3x3 covariance matrix
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of centered) {
        cov[0][0] += p[0] * p[0];
        cov[0][1] += p[0] * p[1];
        cov[0][2] += p[0] * p[2];
        cov[1][0] += p[1] * p[0];
        cov[1][1] += p[1] * p[1];
        cov[1][2] += p[1] * p[2];
        cov[2][0] += p[2] * p[0];
        cov[2][1] += p[2] * p[1];
        cov[2][2] += p[2] * p[2];
    }
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            cov[i][j] /= allPoints.length;
        }
    }

    const maxIter = 50;
    const tolerance = 1e-8;

    let v = [0, 0, 1]; // Initial guess

    // Compute determinant for inverse
    const det = cov[0][0] * (cov[1][1] * cov[2][2] - cov[1][2] * cov[2][1]) -
               cov[0][1] * (cov[1][0] * cov[2][2] - cov[1][2] * cov[2][0]) +
               cov[0][2] * (cov[1][0] * cov[2][1] - cov[1][1] * cov[2][0]);

    if (Math.abs(det) < 1e-10) {
        // Singular matrix fallback: power iteration for largest eigenvector,
        // Gram-Schmidt for second, cross product for normal
        let v1 = [1, 0, 0];
        for (let iter = 0; iter < maxIter; iter++) {
            const vNew = [
                cov[0][0] * v1[0] + cov[0][1] * v1[1] + cov[0][2] * v1[2],
                cov[1][0] * v1[0] + cov[1][1] * v1[1] + cov[1][2] * v1[2],
                cov[2][0] * v1[0] + cov[2][1] * v1[1] + cov[2][2] * v1[2]
            ];
            const len = Math.sqrt(vNew[0] * vNew[0] + vNew[1] * vNew[1] + vNew[2] * vNew[2]);
            if (len < tolerance) break;
            vNew[0] /= len;
            vNew[1] /= len;
            vNew[2] /= len;
            const diff = Math.abs(v1[0] - vNew[0]) + Math.abs(v1[1] - vNew[1]) + Math.abs(v1[2] - vNew[2]);
            v1 = vNew;
            if (diff < tolerance) break;
        }

        // Find second eigenvector (orthogonal to first via Gram-Schmidt)
        const v2 = [0, 1, 0];
        const dot12 = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
        v2[0] -= dot12 * v1[0];
        v2[1] -= dot12 * v1[1];
        v2[2] -= dot12 * v1[2];
        const len2 = Math.sqrt(v2[0] * v2[0] + v2[1] * v2[1] + v2[2] * v2[2]);
        if (len2 > tolerance) {
            v2[0] /= len2;
            v2[1] /= len2;
            v2[2] /= len2;
        }

        // Normal is cross product of first two principal components
        v = [
            v1[1] * v2[2] - v1[2] * v2[1],
            v1[2] * v2[0] - v1[0] * v2[2],
            v1[0] * v2[1] - v1[1] * v2[0]
        ];
    } else {
        // Compute adjugate (cofactor matrix transpose)
        const adj = [
            [cov[1][1] * cov[2][2] - cov[1][2] * cov[2][1],
             cov[0][2] * cov[2][1] - cov[0][1] * cov[2][2],
             cov[0][1] * cov[1][2] - cov[0][2] * cov[1][1]],
            [cov[1][2] * cov[2][0] - cov[1][0] * cov[2][2],
             cov[0][0] * cov[2][2] - cov[0][2] * cov[2][0],
             cov[0][2] * cov[1][0] - cov[0][0] * cov[1][2]],
            [cov[1][0] * cov[2][1] - cov[1][1] * cov[2][0],
             cov[0][1] * cov[2][0] - cov[0][0] * cov[2][1],
             cov[0][0] * cov[1][1] - cov[0][1] * cov[1][0]]
        ];

        // Inverse = adj / det
        const inv = [
            [adj[0][0] / det, adj[0][1] / det, adj[0][2] / det],
            [adj[1][0] / det, adj[1][1] / det, adj[1][2] / det],
            [adj[2][0] / det, adj[2][1] / det, adj[2][2] / det]
        ];

        // Inverse power iteration: converges to smallest eigenvalue eigenvector
        for (let iter = 0; iter < maxIter; iter++) {
            const vNew = [
                inv[0][0] * v[0] + inv[0][1] * v[1] + inv[0][2] * v[2],
                inv[1][0] * v[0] + inv[1][1] * v[1] + inv[1][2] * v[2],
                inv[2][0] * v[0] + inv[2][1] * v[1] + inv[2][2] * v[2]
            ];
            const len = Math.sqrt(vNew[0] * vNew[0] + vNew[1] * vNew[1] + vNew[2] * vNew[2]);
            if (len < tolerance) break;
            vNew[0] /= len;
            vNew[1] /= len;
            vNew[2] /= len;
            const diff = Math.abs(v[0] - vNew[0]) + Math.abs(v[1] - vNew[1]) + Math.abs(v[2] - vNew[2]);
            v = vNew;
            if (diff < tolerance) break;
        }
    }

    // Flip normal so dot(normal, [0,0,1]) >= 0
    const dot = v[0] * 0 + v[1] * 0 + v[2] * 1;
    if (dot < 0) {
        v[0] = -v[0];
        v[1] = -v[1];
        v[2] = -v[2];
    }

    return new Vec3(v[0], v[1], v[2]);
}

/**
 * Compute centroid of an array of world-space positions.
 */
export function computeCentroid(positions: Vec3[]): Vec3 {
    const centroid = new Vec3(0, 0, 0);
    if (positions.length === 0) return centroid;

    for (const p of positions) {
        centroid.add(p);
    }
    centroid.mulScalar(1 / positions.length);
    return centroid;
}
