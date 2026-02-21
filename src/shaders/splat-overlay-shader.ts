// Shader for rendering Gaussian splat centers as points
// Adapted from supersplat/src/shaders/splat-overlay-shader.ts

const vertexShader = /* glsl */ `
    uniform mat4 matrix_model;
    uniform mat4 matrix_view;
    uniform mat4 matrix_viewProjection;

    uniform float depthFilterEnabled;

    uniform highp usampler2D splatOrder;            // order texture mapping render order to splat ID
    uniform uint splatTextureSize;                  // width of order texture

    uniform sampler2D splatState;
    uniform highp usampler2D splatPosition;
    uniform sampler2D splatColor;                   // Gaussian color texture (RGBA16F)

    // SH textures (for uncompressed format)
    #if SH_BANDS > 0
    uniform highp usampler2D splatSH_1to3;
    #if SH_BANDS > 1
    uniform highp usampler2D splatSH_4to7;
    uniform highp usampler2D splatSH_8to11;
    #if SH_BANDS > 2
    uniform highp usampler2D splatSH_12to15;
    #endif
    #endif
    #endif

    uniform vec3 view_position;                     // camera position in world space

    uniform uvec2 texParams;

    uniform float splatSize;
    uniform float useGaussianColor;                 // 0.0 = use selection colors, 1.0 = use gaussian color
    uniform vec4 selectedClr;
    uniform vec4 unselectedClr;
    uniform int highlightedId;                      // ID of highlighted point (-1 = none)

    // Cursor highlight uniforms (show only nearest N points)
    uniform float cursorHighlightEnabled;           // Enable/disable cursor highlighting (0.0 = off, 1.0 = on)
    uniform vec3 cursorHighlightColor;              // Color for highlighted points
    uniform int cursorId0;
    uniform int cursorId1;
    uniform int cursorId2;
    uniform int cursorId3;
    uniform int cursorId4;
    uniform int cursorIdCount;                      // Number of valid IDs (0-5)
    uniform sampler2D depthFilterState;              // CPU-computed filter state per splat
    uniform sampler2D depthVisualization;             // Depth values for visualization
    uniform float showDepthVisualization;             // Enable depth color-coding
    uniform float depthMin;                           // Minimum depth for normalization
    uniform float depthMax;                           // Maximum depth for normalization

    varying vec4 varying_color;
    varying float varying_wouldBeFiltered;
    varying float varying_erased;                     // 1.0 = erased by eraser tool
    varying float varying_erasePreview;               // 1.0 = would be erased (hover preview)
    varying float varying_depth;                      // Depth value for visualization

    // calculate the current splat index and uv
    ivec2 calcSplatUV(uint index, uint width) {
        return ivec2(int(index % width), int(index / width));
    }

    #if SH_BANDS > 0

    // include SH evaluation from engine (provides SH_COEFFS, constants, and evalSH)
    #include "gsplatEvalSHVS"

    // unpack signed 11 10 11 bits
    vec3 unpack111011s(uint bits) {
        return vec3((uvec3(bits) >> uvec3(21u, 11u, 0u)) & uvec3(0x7ffu, 0x3ffu, 0x7ffu)) / vec3(2047.0, 1023.0, 2047.0) * 2.0 - 1.0;
    }

    // fetch quantized spherical harmonic coefficients with scale
    void fetchScale(in uvec4 t, out float scale, out vec3 a, out vec3 b, out vec3 c) {
        scale = uintBitsToFloat(t.x);
        a = unpack111011s(t.y);
        b = unpack111011s(t.z);
        c = unpack111011s(t.w);
    }

    // fetch quantized spherical harmonic coefficients
    void fetchSH(in uvec4 t, out vec3 a, out vec3 b, out vec3 c, out vec3 d) {
        a = unpack111011s(t.x);
        b = unpack111011s(t.y);
        c = unpack111011s(t.z);
        d = unpack111011s(t.w);
    }

    void fetchSH1(in uint t, out vec3 a) {
        a = unpack111011s(t);
    }

    #if SH_BANDS == 1
    void readSHData(in ivec2 uv, out vec3 sh[3], out float scale) {
        fetchScale(texelFetch(splatSH_1to3, uv, 0), scale, sh[0], sh[1], sh[2]);
    }
    #elif SH_BANDS == 2
    void readSHData(in ivec2 uv, out vec3 sh[8], out float scale) {
        fetchScale(texelFetch(splatSH_1to3, uv, 0), scale, sh[0], sh[1], sh[2]);
        fetchSH(texelFetch(splatSH_4to7, uv, 0), sh[3], sh[4], sh[5], sh[6]);
        fetchSH1(texelFetch(splatSH_8to11, uv, 0).x, sh[7]);
    }
    #elif SH_BANDS == 3
    void readSHData(in ivec2 uv, out vec3 sh[15], out float scale) {
        fetchScale(texelFetch(splatSH_1to3, uv, 0), scale, sh[0], sh[1], sh[2]);
        fetchSH(texelFetch(splatSH_4to7, uv, 0), sh[3], sh[4], sh[5], sh[6]);
        fetchSH(texelFetch(splatSH_8to11, uv, 0), sh[7], sh[8], sh[9], sh[10]);
        fetchSH(texelFetch(splatSH_12to15, uv, 0), sh[11], sh[12], sh[13], sh[14]);
    }
    #endif

    #endif

    void main(void) {
        // look up splat ID from order texture using gl_VertexID
        ivec2 orderUV = ivec2(gl_VertexID % int(splatTextureSize), gl_VertexID / int(splatTextureSize));
        uint splatId = texelFetch(splatOrder, orderUV, 0).r;

        ivec2 splatUV = calcSplatUV(splatId, texParams.x);
        uint splatState = uint(texelFetch(splatState, splatUV, 0).r * 255.0);

        // check for locked splats (deleted splats are already excluded from order texture)
        if ((splatState & 2u) != 0u) {
            // locked
            gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
            gl_PointSize = 0.0;
        } else {
            mat4 model = matrix_model;

            vec3 center = uintBitsToFloat(texelFetch(splatPosition, splatUV, 0).xyz);

            vec3 gaussianClr;

            if (useGaussianColor > 0.0) {
                // get base gaussian color
                gaussianClr = texelFetch(splatColor, splatUV, 0).xyz;

                #if SH_BANDS > 0
                    // calculate world position and view direction
                    vec3 worldPos = (model * vec4(center, 1.0)).xyz;
                    vec3 viewDir = normalize(worldPos - view_position);
                    // transform view direction to model space
                    vec3 modelViewDir = normalize(viewDir * mat3(model));

                    // read and evaluate SH
                    vec3 sh[SH_COEFFS];
                    float scale;
                    readSHData(splatUV, sh, scale);
                    gaussianClr += evalSH(sh, modelViewDir) * scale;
                #endif
            } else {
                gaussianClr = unselectedClr.xyz;
            }

            // All points are highlighted in viewer mode - use selected color
            vec3 finalColor = selectedClr.xyz;

            // Optionally blend with gaussian color if enabled
            if (useGaussianColor > 0.0) {
                finalColor = mix(gaussianClr, selectedClr.xyz, 0.3);
            }

            // Cursor highlighting - highlight only the nearest N points by ID
            bool isCursorHighlighted = false;
            if (cursorHighlightEnabled > 0.5 && cursorIdCount > 0) {
                int sid = int(splatId);
                if (cursorIdCount > 0 && sid == cursorId0) isCursorHighlighted = true;
                if (cursorIdCount > 1 && sid == cursorId1) isCursorHighlighted = true;
                if (cursorIdCount > 2 && sid == cursorId2) isCursorHighlighted = true;
                if (cursorIdCount > 3 && sid == cursorId3) isCursorHighlighted = true;
                if (cursorIdCount > 4 && sid == cursorId4) isCursorHighlighted = true;
                if (isCursorHighlighted) {
                    finalColor = cursorHighlightColor;
                }
            }

            // Apply highlight if this is the highlighted point (by ID)
            // Only highlight if highlightedId is valid (>= 0) and matches this splat
            // Compare as int to avoid uint conversion issues with -1
            bool isHighlighted = (highlightedId >= 0) && (int(splatId) == highlightedId);
            if (isHighlighted && cursorHighlightEnabled < 0.5) {
                // Bright yellow highlight (only when cursor highlighting is off)
                finalColor = mix(finalColor, vec3(1.0, 0.9, 0.0), 0.7);
            }

            // Read CPU-computed filter state
            varying_wouldBeFiltered = 0.0;
            if (depthFilterEnabled > 0.5) {
                varying_wouldBeFiltered = texelFetch(depthFilterState, splatUV, 0).r;
            }

            // Read eraser state from G/B channels (always active)
            vec4 filterState = texelFetch(depthFilterState, splatUV, 0);
            varying_erased = filterState.g;
            varying_erasePreview = filterState.b;

            // If erased, move offscreen immediately
            if (varying_erased > 0.5) {
                gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                gl_PointSize = 0.0;
                return;
            }

            // If in erase preview, override color to red
            if (varying_erasePreview > 0.5) {
                finalColor = vec3(1.0, 0.2, 0.2);
            }

            // Set varying_color AFTER erase preview check so red override is picked up
            varying_color = vec4(finalColor, unselectedClr.w);

            // Read depth value for visualization (always initialize to 0)
            varying_depth = 0.0;
            // Only read depth texture if visualization is explicitly enabled AND depth range is valid
            if (showDepthVisualization > 0.5) {
                if (depthMax > depthMin && depthMax > 0.0) {
                    // PIXELFORMAT_R8_G8_B8_A8 is normalized: sampler returns [0,1] already
                    float normalizedDepth = texelFetch(depthVisualization, splatUV, 0).r;
                    varying_depth = depthMin + normalizedDepth * (depthMax - depthMin);
                }
            }

            gl_Position = matrix_viewProjection * model * vec4(center, 1.0);

            // Make highlighted/preview/cursor points larger
            float pointSize = splatSize;
            if (isHighlighted) {
                pointSize = splatSize * 2.0;
            }
            if (isCursorHighlighted) {
                pointSize = splatSize * 2.0;
            }
            if (varying_erasePreview > 0.5) {
                pointSize = splatSize * 1.5;
            }
            gl_PointSize = pointSize;
        }
    }
`;

const fragmentShader = /* glsl */ `
    uniform float depthFilterEnabled;
    uniform float showFilteredPoints;
    uniform vec3 filteredPointColor;
    uniform float showDepthVisualization;
    uniform float depthMin;
    uniform float depthMax;

    varying vec4 varying_color;
    varying float varying_wouldBeFiltered;
    varying float varying_erased;
    varying float varying_erasePreview;
    varying float varying_depth;

    // Depth colormap: blue (near) -> cyan -> green -> yellow -> red (far)
    vec3 depthColormap(float t) {
        t = clamp(t, 0.0, 1.0);
        if (t < 0.25) {
            float s = t / 0.25;
            return mix(vec3(0.0, 0.0, 1.0), vec3(0.0, 1.0, 1.0), s);
        } else if (t < 0.5) {
            float s = (t - 0.25) / 0.25;
            return mix(vec3(0.0, 1.0, 1.0), vec3(0.0, 1.0, 0.0), s);
        } else if (t < 0.75) {
            float s = (t - 0.5) / 0.25;
            return mix(vec3(0.0, 1.0, 0.0), vec3(1.0, 1.0, 0.0), s);
        } else {
            float s = (t - 0.75) / 0.25;
            return mix(vec3(1.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0), s);
        }
    }

    void main(void) {
        // Discard erased points
        if (varying_erased > 0.5) discard;

        vec4 color = varying_color;

        // Apply depth visualization if enabled and depth is valid
        if (showDepthVisualization > 0.5 && varying_depth > 0.0 && depthMax > depthMin && depthMax > 0.0) {
            float normalizedDepth = (varying_depth - depthMin) / (depthMax - depthMin + 1e-10);
            normalizedDepth = clamp(normalizedDepth, 0.0, 1.0);
            vec3 depthColor = depthColormap(normalizedDepth);
            color = vec4(depthColor, varying_color.a);
        }

        if (depthFilterEnabled > 0.5 && varying_wouldBeFiltered > 0.5) {
            if (showFilteredPoints > 0.5) {
                color = vec4(filteredPointColor, varying_color.a * 0.5);
            } else {
                discard;
            }
        }

        gl_FragColor = color;
    }
`;

export { vertexShader, fragmentShader };
