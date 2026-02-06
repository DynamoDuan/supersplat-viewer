import {
    BoundingBox,
    CameraFrame,
    type CameraComponent,
    Color,
    type Entity,
    type Layer,
    RenderTarget,
    Mat4,
    MiniStats,
    ShaderChunks,
    type TextureHandler,
    PIXELFORMAT_RGBA16F,
    PIXELFORMAT_RGBA32F,
    TONEMAP_NONE,
    TONEMAP_LINEAR,
    TONEMAP_FILMIC,
    TONEMAP_HEJL,
    TONEMAP_ACES,
    TONEMAP_ACES2,
    TONEMAP_NEUTRAL,
    Vec3,
    GSplatComponent,
    platform
} from 'playcanvas';

import { Annotations } from './annotations';
import { CameraManager } from './camera-manager';
import { Camera } from './cameras/camera';
import { nearlyEquals } from './core/math';
import { InputController } from './input-controller';
import type { ExperienceSettings, PostEffectSettings } from './settings';
import type { Global } from './types';
import { CentersOverlay } from './centers-overlay';


// override global pick to pack depth instead of meshInstance id
const pickDepthGlsl = /* glsl */ `
uniform vec4 camera_params;     // 1/far, far, near, isOrtho
vec4 getPickOutput() {
    float linearDepth = 1.0 / gl_FragCoord.w;
    float normalizedDepth = (linearDepth - camera_params.z) / (camera_params.y - camera_params.z);
    return vec4(gaussianColor.a * normalizedDepth, 0.0, 0.0, gaussianColor.a);
}
`;

const gammaChunk = `
vec3 prepareOutputFromGamma(vec3 gammaColor) {
    return gammaColor;
}
`;

const pickDepthWgsl = /* wgsl */ `
    uniform camera_params: vec4f;       // 1/far, far, near, isOrtho
    fn getPickOutput() -> vec4f {
        let linearDepth = 1.0 / pcPosition.w;
        let normalizedDepth = (linearDepth - uniform.camera_params.z) / (uniform.camera_params.y - uniform.camera_params.z);
        return vec4f(gaussianColor.a * normalizedDepth, 0.0, 0.0, gaussianColor.a);
    }
`;

const tonemapTable: Record<string, number> = {
    none: TONEMAP_NONE,
    linear: TONEMAP_LINEAR,
    filmic: TONEMAP_FILMIC,
    hejl: TONEMAP_HEJL,
    aces: TONEMAP_ACES,
    aces2: TONEMAP_ACES2,
    neutral: TONEMAP_NEUTRAL
};

const applyPostEffectSettings = (cameraFrame: CameraFrame, settings: PostEffectSettings) => {
    if (settings.sharpness.enabled) {
        cameraFrame.rendering.sharpness = settings.sharpness.amount;
    } else {
        cameraFrame.rendering.sharpness = 0;
    }

    const { bloom } = cameraFrame;
    if (settings.bloom.enabled) {
        bloom.intensity = settings.bloom.intensity;
        bloom.blurLevel = settings.bloom.blurLevel;
    } else {
        bloom.intensity = 0;
    }

    const { grading } = cameraFrame;
    if (settings.grading.enabled) {
        grading.enabled = true;
        grading.brightness = settings.grading.brightness;
        grading.contrast = settings.grading.contrast;
        grading.saturation = settings.grading.saturation;
        grading.tint = new Color().fromArray(settings.grading.tint);
    } else {
        grading.enabled = false;
    }

    const { vignette } = cameraFrame;
    if (settings.vignette.enabled) {
        vignette.intensity = settings.vignette.intensity;
        vignette.inner = settings.vignette.inner;
        vignette.outer = settings.vignette.outer;
        vignette.curvature = settings.vignette.curvature;
    } else {
        vignette.intensity = 0;
    }

    const { fringing } = cameraFrame;
    if (settings.fringing.enabled) {
        fringing.intensity = settings.fringing.intensity;
    } else {
        fringing.intensity = 0;
    }
};

const anyPostEffectEnabled = (settings: PostEffectSettings): boolean => {
    return (settings.sharpness.enabled && settings.sharpness.amount > 0) ||
        (settings.bloom.enabled && settings.bloom.intensity > 0) ||
        (settings.grading.enabled) ||
        (settings.vignette.enabled && settings.vignette.intensity > 0) ||
        (settings.fringing.enabled && settings.fringing.intensity > 0);
};

const vec = new Vec3();

class Viewer {
    global: Global;

    cameraFrame: CameraFrame;

    inputController: InputController;

    cameraManager: CameraManager;

    annotations: Annotations;

    centersOverlay: CentersOverlay;

    forceRenderNextFrame = false;

    constructor(global: Global, gsplatLoad: Promise<Entity>, skyboxLoad: Promise<void>) {
        this.global = global;

        const { app, settings, config, events, state, camera } = global;
        const { graphicsDevice } = app;

        // enable anonymous CORS for image loading in safari
        (app.loader.getHandler('texture') as TextureHandler).imgParser.crossOrigin = 'anonymous';

        // render skybox as plain equirect
        const glsl = ShaderChunks.get(graphicsDevice, 'glsl');
        glsl.set('skyboxPS', glsl.get('skyboxPS').replace('mapRoughnessUv(uv, mipLevel)', 'uv'));
        glsl.set('pickPS', pickDepthGlsl);

        const wgsl = ShaderChunks.get(graphicsDevice, 'wgsl');
        wgsl.set('skyboxPS', wgsl.get('skyboxPS').replace('mapRoughnessUv(uv, uniform.mipLevel)', 'uv'));
        wgsl.set('pickPS', pickDepthWgsl);

        // disable auto render, we'll render only when camera changes
        app.autoRender = false;

        // apply camera animation settings
        camera.camera.aspectRatio = graphicsDevice.width / graphicsDevice.height;

        // configure the camera
        this.configureCamera(settings);

        // reconfigure camera when entering/exiting XR
        app.xr.on('start', () => this.configureCamera(settings));
        app.xr.on('end', () => this.configureCamera(settings));

        // handle horizontal fov on canvas resize
        const updateHorizontalFov = () => {
            camera.camera.horizontalFov = graphicsDevice.width > graphicsDevice.height;
            app.renderNextFrame = true;
        };
        graphicsDevice.on('resizecanvas', updateHorizontalFov);
        updateHorizontalFov();

        // handle render mode changes
        const updateRenderMode = () => {
            // limit the backbuffer to 4k on desktop and HD on mobile
            // we use the shorter dimension so ultra-wide (or high) monitors still work correctly.
            const maxRatio = (platform.mobile ? 1080 : 2160) / Math.min(screen.width, screen.height);

            // adjust pixel ratio based on render mode
            // Note: We don't set maxPixelRatio to 0 in 'off' mode to allow centers overlay to render
            if (state.renderMode === 'high') {
                // full pixel resolution
                graphicsDevice.maxPixelRatio = 1.0 * Math.min(maxRatio, window.devicePixelRatio);
            } else {
                // half pixel resolution for low quality and off mode
                graphicsDevice.maxPixelRatio = 0.5 * Math.min(maxRatio, window.devicePixelRatio);
            }

            app.renderNextFrame = true;
        };
        events.on('renderMode:changed', updateRenderMode);
        updateRenderMode();

        // construct debug ministats
        if (config.ministats) {
            const options = MiniStats.getDefaultOptions() as any;
            options.cpu.enabled = false;
            options.stats = options.stats.filter((s: any) => s.name !== 'DrawCalls');
            options.stats.push({
                name: 'VRAM',
                stats: ['vram.tex'],
                decimalPlaces: 1,
                multiplier: 1 / (1024 * 1024),
                unitsName: 'MB',
                watermark: 1024
            }, {
                name: 'Splats',
                stats: ['frame.gsplats'],
                decimalPlaces: 3,
                multiplier: 1 / 1000000,
                unitsName: 'M',
                watermark: 5
            });

            // eslint-disable-next-line no-new
            new MiniStats(app, options);
        }

        const prevProj = new Mat4();
        const prevWorld = new Mat4();
        const sceneBound = new BoundingBox();

        // track the camera state and trigger a render when it changes
        app.on('framerender', () => {
            const world = camera.getWorldTransform();
            const proj = camera.camera.projectionMatrix;

            if (!app.renderNextFrame) {
                if (config.ministats ||
                    !nearlyEquals(world.data, prevWorld.data) ||
                    !nearlyEquals(proj.data, prevProj.data)) {
                    app.renderNextFrame = true;
                }
            }

            // suppress rendering till we're ready
            if (!state.readyToRender) {
                app.renderNextFrame = false;
            }

            if (this.forceRenderNextFrame) {
                app.renderNextFrame = true;
            }

            if (app.renderNextFrame) {
                prevWorld.copy(world);
                prevProj.copy(proj);
            }

            // Update centers overlay
            if (this.centersOverlay) {
                this.centersOverlay.update();
            }
        });

        const applyCamera = (camera: Camera) => {
            const cameraEntity = global.camera;

            cameraEntity.setPosition(camera.position);
            cameraEntity.setEulerAngles(camera.angles);
            cameraEntity.camera.fov = camera.fov;

            // fit clipping planes to bounding box
            const boundRadius = sceneBound.halfExtents.length();

            // calculate the forward distance between the camera to the bound center
            vec.sub2(sceneBound.center, camera.position);
            const dist = vec.dot(cameraEntity.forward);

            const far = Math.max(dist + boundRadius, 1e-2);
            const near = Math.max(dist - boundRadius, far / (1024 * 16));

            cameraEntity.camera.farClip = far;
            cameraEntity.camera.nearClip = near;
        };

        // handle application update
        app.on('update', (deltaTime) => {
            // in xr mode we leave the camera alone
            if (app.xr.active) {
                return;
            }

            if (this.inputController && this.cameraManager) {
                // update inputs
                this.inputController.update(deltaTime, this.cameraManager.camera.distance);

                // update cameras
                this.cameraManager.update(deltaTime, this.inputController.frame);

                // apply to the camera entity
                applyCamera(this.cameraManager.camera);
            }
        });

        // unpause the animation on first frame
        events.on('firstFrame', () => {
            state.animationPaused = !!config.noanim;
        });

        // Create centers overlay
        this.centersOverlay = new CentersOverlay(app);

        // Listen for showCenters state changes
        events.on('showCenters:changed', (value: boolean) => {
            this.centersOverlay.setEnabled(value);
            console.log('showCenters changed to:', value, 'overlay enabled:', this.centersOverlay.isEnabled);
        });

        // Listen for centers point size changes
        events.on('centersPointSize:changed', (value: number) => {
            this.centersOverlay.setPointSize(value);
        });

        // Initialize point size from state
        this.centersOverlay.setPointSize(state.centersPointSize);

        // wait for the model to load
        Promise.all([gsplatLoad, skyboxLoad]).then((results) => {
            const gsplat = results[0].gsplat as GSplatComponent;

            // Attach centers overlay to gsplat entity
            this.centersOverlay.attach(results[0]);

            // get scene bounding box
            const gsplatBbox = gsplat.customAabb;
            if (gsplatBbox) {
                sceneBound.setFromTransformedAabb(gsplatBbox, results[0].getWorldTransform());
            }

            if (!config.noui) {
                this.annotations = new Annotations(global, this.cameraFrame != null);
            }

            this.inputController = new InputController(global);

            this.cameraManager = new CameraManager(global, sceneBound);
            applyCamera(this.cameraManager.camera);

            // Setup mouse move for real-time cursor highlighting AFTER cameraManager is initialized
            const canvas = graphicsDevice.canvas;

            canvas.addEventListener('mousemove', (e: MouseEvent) => {
                if (!state.showCenters || !this.centersOverlay.isEnabled) {
                    return;
                }

                const cameraEntity = global.camera;

                // Calculate ray from camera through mouse position
                const rayOrigin = cameraEntity.getPosition();
                const rayDir = new Vec3();

                // Get the point at depth=1.0 (on the far plane)
                cameraEntity.camera.screenToWorld(
                    e.offsetX,
                    e.offsetY,
                    1.0,
                    rayDir
                );

                // Calculate direction from camera to that point
                rayDir.sub(rayOrigin).normalize();

                // Project to the center of the scene (use camera target distance)
                let distance = 2.0; // Default fallback distance

                if (this.cameraManager && this.cameraManager.camera && this.cameraManager.camera.distance) {
                    distance = this.cameraManager.camera.distance;
                }

                const worldPos = rayOrigin.clone().add(rayDir.clone().mulScalar(distance));

                // Enable cursor proximity highlighting at this position
                this.centersOverlay.setCursorPosition(worldPos, true);

                // Request immediate render
                app.renderNextFrame = true;
            });

            canvas.addEventListener('mouseleave', () => {
                this.centersOverlay.setCursorPosition(null, false);
                app.renderNextFrame = true;
            });

            const { instance } = gsplat;
            if (instance) {
                // kick off gsplat sorting immediately now that camera is in position
                instance.sort(camera);

                // handle render mode changes for non-LOD splats
                const updateSplatRendering = () => {
                    // Enable/disable gsplat component based on render mode
                    gsplat.enabled = state.renderMode !== 'off';
                    app.renderNextFrame = true;
                };
                events.on('renderMode:changed', updateSplatRendering);
                updateSplatRendering();

                // listen for sorting updates to trigger first frame events
                instance.sorter?.on('updated', () => {
                    // request frame render when sorting changes
                    app.renderNextFrame = true;

                    if (!state.readyToRender) {
                        // we're ready to render once the first sort has completed
                        state.readyToRender = true;

                        // wait for the first valid frame to complete rendering
                        app.once('frameend', () => {
                            events.fire('firstFrame');

                            // emit first frame event on window
                            window.firstFrame?.();
                        });
                    }
                });
            } else {

                const { gsplat } = app.scene;

                // quality ranges
                const ranges = {
                    mobile: {
                        low: 1,
                        high: 2
                    },
                    desktop: {
                        low: 3,
                        high: 6
                    }
                };

                const quality = platform.mobile ? ranges.mobile : ranges.desktop;

                // start in low quality mode so we can get user interacting asap
                results[0].gsplat.splatBudget = quality.low * 1000000;

                // these two allow LOD behind camera to drop, saves lots of splats
                gsplat.lodUpdateAngle = 90;
                gsplat.lodBehindPenalty = 5;

                // same performance, but rotating on slow devices does not give us unsorted splats on sides
                gsplat.radialSorting = true;

                const eventHandler = app.systems.gsplat;

                // we must force continuous rendering with streaming & lod system
                this.forceRenderNextFrame = true;

                let current = 0;
                let watermark = 1;
                const readyHandler = (_camera: CameraComponent, _layer: Layer, ready: boolean, loading: number) => {
                    if (ready && loading === 0) {
                        // scene is done loading
                        eventHandler.off('frame:ready', readyHandler);

                        state.readyToRender = true;

                        // handle quality mode changes
                        const updateLod = () => {
                            if (state.renderMode === 'off') {
                                // disable LOD rendering by setting budget to 0
                                results[0].gsplat.splatBudget = 0;
                            } else {
                                const splatBudget = state.renderMode === 'high' ? quality.high : quality.low;
                                results[0].gsplat.splatBudget = splatBudget * 1000000;
                            }
                        };
                        events.on('renderMode:changed', updateLod);
                        updateLod();

                        // debug colorize lods
                        gsplat.colorizeLod = config.colorize;

                        // wait for the first valid frame to complete rendering
                        app.once('frameend', () => {
                            events.fire('firstFrame');

                            // emit first frame event on window
                            window.firstFrame?.();
                        });
                    }

                    // update loading status
                    if (loading !== current) {
                        watermark = Math.max(watermark, loading);
                        current = watermark - loading;
                        state.progress = Math.trunc(current / watermark * 100);
                    }
                };
                eventHandler.on('frame:ready', readyHandler);
            }
        });
    }

    // configure camera based on application mode and post process settings
    configureCamera(settings: ExperienceSettings) {
        const { global } = this;
        const { app, camera } = global;
        const { postEffectSettings } = settings;
        const { background } = settings;

        const enableCameraFrame = !app.xr.active && (anyPostEffectEnabled(postEffectSettings) || settings.highPrecisionRendering);

        if (enableCameraFrame) {
            // create instance
            if (!this.cameraFrame) {
                this.cameraFrame = new CameraFrame(app, camera.camera);
            }

            const { cameraFrame } = this;
            cameraFrame.enabled = true;
            cameraFrame.rendering.toneMapping = tonemapTable[settings.tonemapping];
            cameraFrame.rendering.renderFormats = settings.highPrecisionRendering ? [PIXELFORMAT_RGBA16F, PIXELFORMAT_RGBA32F] : [];
            applyPostEffectSettings(cameraFrame, postEffectSettings);
            cameraFrame.update();

            // force gsplat shader to write gamma-space colors
            ShaderChunks.get(app.graphicsDevice, 'glsl').set('gsplatOutputVS', gammaChunk);

            // ensure the final blit doesn't perform linear->gamma conversion
            RenderTarget.prototype.isColorBufferSrgb = function () {
                return true;
            };

            camera.camera.clearColor = new Color(background.color);
        } else {
            // no post effects needed, destroy camera frame if it exists
            if (this.cameraFrame) {
                this.cameraFrame.destroy();
                this.cameraFrame = null;
            }

            if (!app.xr.active) {
                camera.camera.toneMapping = tonemapTable[settings.tonemapping];
                camera.camera.clearColor = new Color(background.color);
            }
        }
    }
}

export { Viewer };
