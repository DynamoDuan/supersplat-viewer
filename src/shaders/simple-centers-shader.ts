// Simplified shader for rendering Gaussian splat centers as points
// Uses vertex buffer data instead of textures

const vertexShader = /* glsl */ `
    attribute vec3 vertex_position;
    attribute vec4 vertex_color;

    uniform mat4 matrix_model;
    uniform mat4 matrix_viewProjection;
    uniform float splatSize;

    varying vec4 varying_color;

    void main(void) {
        varying_color = vertex_color;
        gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0);
        gl_PointSize = splatSize;
    }
`;

const fragmentShader = /* glsl */ `
    varying vec4 varying_color;

    void main(void) {
        gl_FragColor = varying_color;
    }
`;

export { vertexShader, fragmentShader };
