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
import { PointMarker } from './point-marker';
import { PointListUI } from './point-list-ui';
import { NormalMarker } from './normal-marker';
import { NormalListUI } from './normal-list-ui';
import { computePCANormalFromPoints, computeCentroid } from './pca-normal';
import { depthGsplatVS, depthGsplatVS_WGSL } from './shaders/depth-shader';

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

    pointMarker: PointMarker;

    pointListUI: PointListUI;

    normalMarker: NormalMarker;

    normalListUI: NormalListUI;

    forceRenderNextFrame = false;

    eraserActive = false;

    private _gsplatMaterial: any = null;

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
        glsl.set('gsplatVS', depthGsplatVS);

        const wgsl = ShaderChunks.get(graphicsDevice, 'wgsl');
        wgsl.set('skyboxPS', wgsl.get('skyboxPS').replace('mapRoughnessUv(uv, uniform.mipLevel)', 'uv'));
        wgsl.set('pickPS', pickDepthWgsl);
        wgsl.set('gsplatVS', depthGsplatVS_WGSL);

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
            if (state.renderMode === 'high' || state.renderMode === 'depth') {
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
                // Skip camera input when actively erasing to prevent rotation
                if (!this.eraserActive) {
                    this.inputController.update(deltaTime, this.cameraManager.camera.distance);
                }

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

        // Create point marker (scene will be set in attach method)
        this.pointMarker = new PointMarker(app);

        // Create normal marker
        this.normalMarker = new NormalMarker(app);

        // Create point list UI (will be initialized after DOM is ready)
        this.pointListUI = null as any;
        this.normalListUI = null as any;

        // Listen for showCenters state changes
        events.on('showCenters:changed', (value: boolean) => {
            this.centersOverlay.setEnabled(value);
            console.log('showCenters changed to:', value, 'overlay enabled:', this.centersOverlay.isEnabled);
        });

        // Listen for centers point size changes
        events.on('centersPointSize:changed', (value: number) => {
            this.centersOverlay.setPointSize(value);
        });

        // Depth filter
        let depthFilterEnabled = false;
        let filterComputeTimeout: ReturnType<typeof setTimeout> | null = null;

        const updateFilterStats = () => {
            const stats = this.centersOverlay.getFilterStats();
            events.fire('filterStats:changed', stats);
        };

        // Debounced filter computation - runs after camera stops moving
        const scheduleFilterComputation = () => {
            if (filterComputeTimeout) clearTimeout(filterComputeTimeout);
            filterComputeTimeout = setTimeout(async () => {
                filterComputeTimeout = null;
                if (!depthFilterEnabled) return;

                // Get picker positions (picker is initialized in Promise.all below)
                const pickerRef = (this as any)._picker;
                if (!pickerRef) return;

                // Wait for positions to be loaded
                if (!pickerRef.positionCacheValid) {
                    await new Promise<void>(r => setTimeout(r, 500));
                    if (!pickerRef.positionCacheValid) return;
                }

                const positions = pickerRef.cachedPositions;
                if (!positions || positions.length === 0) return;

                this.centersOverlay.computeFiltering(positions, camera, pickerRef.cachedOpacities);
                updateFilterStats();
                app.renderNextFrame = true;
            }, 300);
        };

        events.on('depthFilter:toggle', () => {
            depthFilterEnabled = !depthFilterEnabled;
            this.centersOverlay.setDepthFilterEnabled(depthFilterEnabled);
            events.fire('depthFilterEnabled:changed', depthFilterEnabled);
            if (depthFilterEnabled) {
                scheduleFilterComputation();
            } else {
                this.centersOverlay.clearFilterState();
                updateFilterStats();
            }
            app.renderNextFrame = true;
        });
        events.on('depthFilter:changed', (value: number) => {
            this.centersOverlay.setDepthThreshold(value);
            if (depthFilterEnabled) {
                scheduleFilterComputation();
            }
            app.renderNextFrame = true;
        });

        // Show filtered points toggle
        let showFilteredPoints = false;
        events.on('showFilteredPoints:toggle', () => {
            showFilteredPoints = !showFilteredPoints;
            this.centersOverlay.setShowFilteredPoints(showFilteredPoints);
            events.fire('showFilteredPoints:changed', showFilteredPoints);
            app.renderNextFrame = true;
        });

        // Show depth visualization toggle
        let showDepthVisualization = false;
        events.on('showDepthVisualization:toggle', () => {
            showDepthVisualization = !showDepthVisualization;
            this.centersOverlay.setShowDepthVisualization(showDepthVisualization);
            events.fire('showDepthVisualization:changed', showDepthVisualization);
            app.renderNextFrame = true;
        });

        // Freeze depth toggle - back-project alpha-blended depth as a 3D point cloud
        let depthFrozen = false;
        events.on('freezeDepth:toggle', async () => {
            depthFrozen = !depthFrozen;
            if (depthFrozen) {
                const pickerRef = (this as any)._picker;
                if (pickerRef && pickerRef.positionCacheValid && pickerRef.cachedPositions) {
                    this.centersOverlay.freezeDepth(pickerRef.cachedPositions, camera, pickerRef.cachedOpacities);
                }
            } else {
                this.centersOverlay.unfreezeDepth();
            }
            events.fire('freezeDepth:changed', depthFrozen);
            app.renderNextFrame = true;
        });

        // Freeze filter toggle - back-project filtered points as a 3D red point cloud
        let filterFrozen = false;
        events.on('freezeFilter:toggle', () => {
            filterFrozen = !filterFrozen;
            if (filterFrozen) {
                const pickerRef = (this as any)._picker;
                if (pickerRef && pickerRef.positionCacheValid && pickerRef.cachedPositions) {
                    this.centersOverlay.freezeFilter(pickerRef.cachedPositions);
                }
            } else {
                this.centersOverlay.unfreezeFilter();
            }
            events.fire('freezeFilter:changed', filterFrozen);
            app.renderNextFrame = true;
        });

        // Recompute filter when camera moves (debounced)
        // Also recompute depth visualization if enabled
        let lastCameraData: Float32Array | null = null;
        app.on('framerender', () => {
            if (!depthFilterEnabled && !showDepthVisualization) return;
            const world = camera.getWorldTransform();
            if (!lastCameraData) {
                lastCameraData = new Float32Array(world.data);
                scheduleFilterComputation();
            } else {
                let changed = false;
                for (let i = 0; i < 16; i++) {
                    if (Math.abs(world.data[i] - lastCameraData[i]) > 1e-6) {
                        changed = true;
                        break;
                    }
                }
                if (changed) {
                    lastCameraData.set(world.data);
                    if (!depthFrozen) {
                        scheduleFilterComputation();
                    }

                    // Also update depth visualization if enabled (but NOT if frozen)
                    if (showDepthVisualization && !depthFrozen) {
                        const pickerRef = (this as any)._picker;
                        if (pickerRef && pickerRef.positionCacheValid && pickerRef.cachedPositions) {
                            this.centersOverlay.computeDepthVisualization(pickerRef.cachedPositions, camera, pickerRef.cachedOpacities);
                        }
                    }
                }
            }
        });

        // Initialize point size from state
        this.centersOverlay.setPointSize(state.centersPointSize);

        // wait for the model to load
        Promise.all([gsplatLoad, skyboxLoad]).then((results) => {
            const gsplat = results[0]?.gsplat as GSplatComponent | null;

            if (gsplat) {
                // Attach centers overlay to gsplat entity
                this.centersOverlay.attach(results[0]);

                // Initialize picker eagerly for depth filtering and point selection
                import('./picker').then(({ Picker }) => {
                    const pickerInstance = new Picker(app, camera, results[0]);
                    (this as any)._picker = pickerInstance;
                });

                // Update filter statistics after gsplat loads
                setTimeout(() => {
                    const stats = this.centersOverlay.getFilterStats();
                    events.fire('filterStats:changed', stats);
                }, 500);

                // Attach point marker to gsplat entity
                this.pointMarker.attach(results[0]);

                // Attach normal marker to gsplat entity
                this.normalMarker.attach(results[0]);

                // 点云模式：自动开启 show centers
                import('./index').then(({ isPointCloudMode }) => {
                    if (isPointCloudMode()) {
                        state.showCenters = true;
                        state.centersPointSize = 3;
                    }
                });
            }

            // Initialize point list UI after DOM is ready
            let pointListContainer: HTMLElement | null = null;
            let normalListContainer: HTMLElement | null = null;
            if (!config.noui && !this.pointListUI) {
                const uiContainer = document.getElementById('ui');
                if (uiContainer) {
                    pointListContainer = document.createElement('div');
                    pointListContainer.id = 'pointListContainer';
                    // Leave bottom space for settingsPanel (bottom: 86px + padding)
                    pointListContainer.style.cssText = 'position: fixed; right: 0; top: 0; width: 300px; height: calc(100vh - 200px); z-index: 999; pointer-events: none;';
                    const innerContainer = document.createElement('div');
                    innerContainer.style.cssText = 'pointer-events: auto; height: 100%;';
                    pointListContainer.appendChild(innerContainer);
                    uiContainer.appendChild(pointListContainer);
                    this.pointListUI = new PointListUI(innerContainer, this.pointMarker);

                    // Create normal list container (hidden by default)
                    normalListContainer = document.createElement('div');
                    normalListContainer.id = 'normalListContainer';
                    normalListContainer.style.cssText = 'position: fixed; right: 0; top: 0; width: 300px; height: calc(100vh - 200px); z-index: 999; pointer-events: none; display: none;';
                    const normalInner = document.createElement('div');
                    normalInner.style.cssText = 'pointer-events: auto; height: 100%;';
                    normalListContainer.appendChild(normalInner);
                    uiContainer.appendChild(normalListContainer);
                    this.normalListUI = new NormalListUI(normalInner, this.normalMarker);
                }
            }

            // get scene bounding box
            if (gsplat) {
                const gsplatBbox = gsplat.customAabb;
                if (gsplatBbox) {
                    sceneBound.setFromTransformedAabb(gsplatBbox, results[0].getWorldTransform());
                }
            }

            if (!config.noui) {
                this.annotations = new Annotations(global, this.cameraFrame != null);
            }

            this.inputController = new InputController(global);

            this.cameraManager = new CameraManager(global, sceneBound);
            applyCamera(this.cameraManager.camera);

            // Setup mouse move for precise real-time cursor highlighting AFTER cameraManager is initialized
            const canvas = graphicsDevice.canvas;
            let picker: any = (this as any)._picker || null;
            let pendingUpdate: { x: number; y: number } | null = null;
            let isUpdating = false;
            let rafId: number | null = null;

            const updateHighlight = async (x: number, y: number) => {
                if (!state.showCenters || !this.centersOverlay.isEnabled) {
                    isUpdating = false;
                    return;
                }

                isUpdating = true;
                try {
                    if (!picker) {
                        picker = (this as any)._picker;
                    }
                    if (!picker) {
                        const { Picker } = await import('./picker');
                        picker = new Picker(app, camera, results[0]);
                        (this as any)._picker = picker;
                    }

                    // Find the 5 nearest points to the cursor ray
                    const nearest = await picker.pickNearest(x, y, 5);
                    if (nearest.length > 0) {
                        this.centersOverlay.setCursorHighlightIds(nearest.map((n: { index: number }) => n.index));
                    } else {
                        this.centersOverlay.setCursorHighlightIds([]);
                    }

                    app.renderNextFrame = true;
                } catch (error) {
                    console.debug('Highlight error:', error);
                    this.centersOverlay.setCursorHighlightIds([]);
                } finally {
                    isUpdating = false;
                    if (pendingUpdate) {
                        const nextUpdate = pendingUpdate;
                        pendingUpdate = null;
                        rafId = requestAnimationFrame(() => {
                            rafId = null;
                            updateHighlight(nextUpdate.x, nextUpdate.y);
                        });
                    }
                }
            };

            canvas.addEventListener('mousemove', (e: MouseEvent) => {
                if (!state.showCenters || !this.centersOverlay.isEnabled) {
                    if (rafId !== null) {
                        cancelAnimationFrame(rafId);
                        rafId = null;
                    }
                    pendingUpdate = null;
                    this.centersOverlay.setCursorHighlightIds([]);
                    return;
                }

                const rect = canvas.getBoundingClientRect();
                const x = (e.clientX - rect.left) / rect.width;
                const y = (e.clientY - rect.top) / rect.height;

                // Store the latest mouse position
                pendingUpdate = { x, y };

                // If not currently updating, start a new update
                if (!isUpdating && rafId === null) {
                    rafId = requestAnimationFrame(() => {
                        rafId = null;
                        if (pendingUpdate) {
                            const update = pendingUpdate;
                            pendingUpdate = null;
                            updateHighlight(update.x, update.y);
                        }
                    });
                }
            });

            canvas.addEventListener('mouseleave', () => {
                if (rafId !== null) {
                    cancelAnimationFrame(rafId);
                    rafId = null;
                }
                pendingUpdate = null;
                this.centersOverlay.setCursorHighlightIds([]);
                app.renderNextFrame = true;
            });

            // Setup click handler for point selection
            const selectModeState = { enabled: false };
            const annotationMode = { isNormal: false };
            canvas.addEventListener('click', async (e: MouseEvent) => {
                // Ignore clicks that originated from UI elements overlaying the canvas
                if (e.target !== canvas) {
                    return;
                }
                if (!selectModeState.enabled) {
                    return;
                }
                if (!state.showCenters || !this.centersOverlay.isEnabled) {
                    state.showCenters = true;
                    this.centersOverlay.setEnabled(true);
                    events.fire('showCenters:changed', true);
                }

                const rect = canvas.getBoundingClientRect();
                const x = (e.clientX - rect.left) / rect.width;
                const y = (e.clientY - rect.top) / rect.height;

                try {
                    if (!picker) {
                        picker = (this as any)._picker;
                    }
                    if (!picker) {
                        const { Picker } = await import('./picker');
                        picker = new Picker(app, camera, results[0]);
                        (this as any)._picker = picker;
                    }

                    const result = await picker.getClosestPointIndex(x, y);
                    if (result) {
                        if (annotationMode.isNormal) {
                            // Normal mode: add green point
                            this.normalMarker.addPoint(result.index, result.position);
                        } else {
                            // Regular mode: colored point
                            const originalColor = new Color(1, 1, 1);
                            this.pointMarker.selectPoint(result.index, result.position, originalColor);
                        }
                        app.renderNextFrame = true;
                    }
                } catch (error) {
                    console.error('Point selection error:', error);
                }
            });

            // Setup keyboard shortcuts and UI buttons for point marking
            if (!config.noui) {
                // Add UI buttons
                const buttonsContainer = document.getElementById('buttonsContainer');
                if (buttonsContainer) {
                    // Save JSON button
                    const saveBtn = document.createElement('button');
                    saveBtn.id = 'savePointsBtn';
                    saveBtn.className = 'controlButton';
                    saveBtn.title = 'Save Points as JSON';
                    saveBtn.innerHTML = '💾';
                    saveBtn.style.cssText = 'font-size: 20px; padding: 8px;';
                    saveBtn.addEventListener('click', () => {
                        const pointsData = this.pointMarker.exportToJSON();
                        const normalData = this.normalMarker.exportToJSON();
                        const hasNormalData = normalData.points.length > 0 || normalData.normal !== null;

                        if (pointsData.length === 0 && !hasNormalData) {
                            alert('No points selected');
                            return;
                        }

                        let exportData: any;
                        if (hasNormalData) {
                            exportData = {
                                points: pointsData,
                                normal_direction: normalData
                            };
                        } else {
                            exportData = pointsData;
                        }

                        const jsonString = JSON.stringify(exportData, null, 2);
                        const blob = new Blob([jsonString], { type: 'application/json' });
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement('a');
                        link.href = url;
                        link.download = `points_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
                        document.body.appendChild(link);
                        link.click();
                        document.body.removeChild(link);
                        URL.revokeObjectURL(url);
                    });
                    buttonsContainer.appendChild(saveBtn);

                    // Toggle select mode button
                    const selectBtn = document.createElement('button');
                    selectBtn.id = 'toggleSelectBtn';
                    selectBtn.className = 'controlButton toggle right';
                    selectBtn.title = 'Toggle Point Selection Mode';
                    selectBtn.innerHTML = '📍';
                    selectBtn.style.cssText = 'font-size: 20px; padding: 8px; cursor: pointer;';
                    selectBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        selectModeState.enabled = !selectModeState.enabled;
                        if (selectModeState.enabled) {
                            selectBtn.classList.add('active');
                            state.showCenters = true;
                            this.centersOverlay.setEnabled(true);
                            events.fire('showCenters:changed', true);
                        } else {
                            selectBtn.classList.remove('active');
                        }
                    });
                    buttonsContainer.appendChild(selectBtn);

                    // Normal Direction toggle button
                    const normalBtn = document.createElement('button');
                    normalBtn.id = 'toggleNormalBtn';
                    normalBtn.className = 'controlButton';
                    normalBtn.title = 'Toggle Normal Direction Mode';
                    normalBtn.innerHTML = '&#x2197;'; // ↗ arrow
                    normalBtn.style.cssText = 'font-size: 20px; padding: 8px; cursor: pointer;';
                    normalBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        annotationMode.isNormal = !annotationMode.isNormal;
                        if (annotationMode.isNormal) {
                            normalBtn.classList.add('active');
                            normalBtn.style.background = '#007acc';
                            normalBtn.style.color = '#fff';
                            // Switch panels
                            if (pointListContainer) pointListContainer.style.display = 'none';
                            if (normalListContainer) normalListContainer.style.display = '';
                            // Hide regular spheres, show normal spheres
                            this.pointMarker.setAllSpheresVisible(false);
                            this.normalMarker.show();
                        } else {
                            normalBtn.classList.remove('active');
                            normalBtn.style.background = '';
                            normalBtn.style.color = '';
                            // Switch panels back
                            if (pointListContainer) pointListContainer.style.display = '';
                            if (normalListContainer) normalListContainer.style.display = 'none';
                            // Show regular spheres, hide normal spheres
                            this.pointMarker.setAllSpheresVisible(true);
                            this.normalMarker.hide();
                        }
                        app.renderNextFrame = true;
                    });
                    buttonsContainer.appendChild(normalBtn);

                    // Eraser tool button
                    const eraserBtn = document.createElement('button');
                    eraserBtn.id = 'toggleEraserBtn';
                    eraserBtn.className = 'controlButton';
                    eraserBtn.title = 'Toggle Eraser Mode (brush-erase splats)';
                    eraserBtn.innerHTML = '&#x1F9F9;'; // 🧹 broom
                    eraserBtn.style.cssText = 'font-size: 20px; padding: 8px; cursor: pointer;';
                    // Box select state (declared early for mutual exclusion with eraser)
                    const boxSelectState = { enabled: false, isDrawing: false, startX: 0, startY: 0, prevRenderMode: 'high' as 'high' | 'low' | 'off' | 'depth', rectDiv: null as HTMLDivElement | null };
                    let boxSelectBtn: HTMLButtonElement | null = null;

                    // brushScale: multiplied by cameraDistance to get world-space brush radius
                    const eraserModeState = { enabled: false, isErasing: false, brushScale: 0.0002, prevRenderMode: 'high' as 'high' | 'low' | 'off' | 'depth' };
                    const updateEraserCursor = () => {
                        canvas.style.cursor = 'crosshair';
                    };
                    eraserBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        eraserModeState.enabled = !eraserModeState.enabled;
                        this.eraserActive = eraserModeState.enabled;
                        if (eraserModeState.enabled) {
                            // Deactivate box select if active
                            if (boxSelectState.enabled) {
                                boxSelectState.enabled = false;
                                if (boxSelectBtn) {
                                    boxSelectBtn.classList.remove('active');
                                    boxSelectBtn.style.background = '';
                                    boxSelectBtn.style.color = '';
                                }
                                canvas.style.cursor = '';
                            }
                            // Enter eraser mode: hide Gaussians, show centers only
                            eraserModeState.prevRenderMode = state.renderMode;
                            state.renderMode = 'off';
                            events.fire('renderMode:changed', 'off');
                            state.showCenters = true;
                            this.centersOverlay.setEnabled(true);
                            events.fire('showCenters:changed', true);

                            eraserBtn.classList.add('active');
                            eraserBtn.style.background = '#cc3300';
                            eraserBtn.style.color = '#fff';
                            eraserSliderContainer.style.display = 'flex';
                            updateEraserCursor();
                        } else {
                            // Exit eraser mode: restore Gaussian rendering
                            const prev = eraserModeState.prevRenderMode;
                            state.renderMode = prev;
                            events.fire('renderMode:changed', prev);

                            eraserBtn.classList.remove('active');
                            eraserBtn.style.background = '';
                            eraserBtn.style.color = '';
                            eraserSliderContainer.style.display = 'none';
                            canvas.style.cursor = '';
                        }
                        app.renderNextFrame = true;
                    });
                    // Scroll wheel to adjust brush scale in eraser mode
                    canvas.addEventListener('wheel', (e: WheelEvent) => {
                        if (!eraserModeState.enabled) return;
                        e.preventDefault();
                        const factor = e.deltaY > 0 ? 0.8 : 1.25;
                        eraserModeState.brushScale = Math.max(0.0001, Math.min(0.0005, eraserModeState.brushScale * factor));
                        eraserSlider.value = String(eraserModeState.brushScale);
                        eraserSliderValue.textContent = eraserModeState.brushScale.toFixed(4);
                    }, { passive: false });
                    buttonsContainer.appendChild(eraserBtn);

                    // Eraser brush size slider (hidden until eraser mode)
                    const eraserSliderContainer = document.createElement('div');
                    eraserSliderContainer.id = 'eraserSliderContainer';
                    eraserSliderContainer.style.cssText = 'display:none; align-items:center; gap:6px; padding:4px 8px; background:#333; border-radius:4px;';
                    const eraserSliderLabel = document.createElement('span');
                    eraserSliderLabel.textContent = 'Brush';
                    eraserSliderLabel.style.cssText = 'font-size:12px; color:#ccc; white-space:nowrap;';
                    const eraserSlider = document.createElement('input');
                    eraserSlider.type = 'range';
                    eraserSlider.min = '0.0001';
                    eraserSlider.max = '0.0005';
                    eraserSlider.step = '0.00001';
                    eraserSlider.value = '0.0002';
                    eraserSlider.style.cssText = 'width:120px; cursor:pointer;';
                    const eraserSliderValue = document.createElement('span');
                    eraserSliderValue.textContent = '0.0002';
                    eraserSliderValue.style.cssText = 'font-size:12px; color:#ccc; min-width:50px;';
                    eraserSlider.addEventListener('input', () => {
                        eraserModeState.brushScale = parseFloat(eraserSlider.value);
                        eraserSliderValue.textContent = eraserModeState.brushScale.toFixed(4);
                    });
                    eraserSliderContainer.appendChild(eraserSliderLabel);
                    eraserSliderContainer.appendChild(eraserSlider);
                    eraserSliderContainer.appendChild(eraserSliderValue);
                    buttonsContainer.appendChild(eraserSliderContainer);

                    // Undo eraser button
                    const undoEraserBtn = document.createElement('button');
                    undoEraserBtn.id = 'undoEraserBtn';
                    undoEraserBtn.className = 'controlButton';
                    undoEraserBtn.title = 'Undo All Erased Points';
                    undoEraserBtn.innerHTML = '&#x21A9;'; // ↩
                    undoEraserBtn.style.cssText = 'font-size: 20px; padding: 8px; cursor: pointer;';
                    undoEraserBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        this.centersOverlay.uneraseSplats();
                        app.renderNextFrame = true;
                    });
                    buttonsContainer.appendChild(undoEraserBtn);

                    // Apply erased points button — permanently removes erased splats from scene
                    const applyEraseBtn = document.createElement('button');
                    applyEraseBtn.id = 'applyEraseBtn';
                    applyEraseBtn.className = 'controlButton';
                    applyEraseBtn.title = 'Apply: permanently remove erased points from scene';
                    applyEraseBtn.innerHTML = '&#x2714;'; // ✔
                    applyEraseBtn.style.cssText = 'font-size: 20px; padding: 8px; cursor: pointer;';
                    applyEraseBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();

                        const erasedCount = this.centersOverlay.getErasedCount();
                        if (erasedCount === 0) {
                            alert('No points have been erased.');
                            return;
                        }

                        // Get the filterStateTexture to pass to gsplat material
                        const eraserTexture = this.centersOverlay.getFilterStateTexture();
                        if (!eraserTexture) {
                            alert('Eraser state texture not available.');
                            return;
                        }

                        // Set eraser define + texture on gsplat material
                        const mat = this._gsplatMaterial;
                        if (mat) {
                            mat.setDefine('GSPLAT_ERASER', true);
                            mat.setParameter('eraserState', eraserTexture);
                            mat.update();
                            console.log(`Applied GSPLAT_ERASER with ${erasedCount} erased splats`);
                        } else {
                            console.warn('gsplat material not available yet');
                        }

                        // Restore Gaussian rendering
                        const prev = eraserModeState.prevRenderMode;
                        state.renderMode = prev;
                        events.fire('renderMode:changed', prev);

                        // Exit eraser mode
                        eraserModeState.enabled = false;
                        eraserModeState.isErasing = false;
                        this.eraserActive = false;
                        eraserBtn.classList.remove('active');
                        eraserBtn.style.background = '';
                        eraserBtn.style.color = '';
                        eraserSliderContainer.style.display = 'none';
                        canvas.style.cursor = '';
                        this.centersOverlay.clearErasePreview();

                        app.renderNextFrame = true;
                    });
                    buttonsContainer.appendChild(applyEraseBtn);

                    // Box select button
                    boxSelectBtn = document.createElement('button');
                    boxSelectBtn.id = 'boxSelectBtn';
                    boxSelectBtn.className = 'controlButton';
                    boxSelectBtn.title = 'Box Select: draw rectangle to keep only enclosed points';
                    boxSelectBtn.innerHTML = '&#x25A1;';
                    boxSelectBtn.style.cssText = 'font-size: 20px; padding: 8px; cursor: pointer;';
                    boxSelectBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        boxSelectState.enabled = !boxSelectState.enabled;
                        if (boxSelectState.enabled) {
                            // Deactivate eraser if active
                            if (eraserModeState.enabled) {
                                eraserModeState.enabled = false;
                                eraserModeState.isErasing = false;
                                this.eraserActive = false;
                                eraserBtn.classList.remove('active');
                                eraserBtn.style.background = '';
                                eraserBtn.style.color = '';
                                eraserSliderContainer.style.display = 'none';
                            }
                            // Enter box select mode
                            boxSelectState.prevRenderMode = state.renderMode;
                            state.renderMode = 'off';
                            events.fire('renderMode:changed', 'off');
                            state.showCenters = true;
                            this.centersOverlay.setEnabled(true);
                            events.fire('showCenters:changed', true);
                            this.eraserActive = true;

                            boxSelectBtn.classList.add('active');
                            boxSelectBtn.style.background = '#0066cc';
                            boxSelectBtn.style.color = '#fff';
                            canvas.style.cursor = 'crosshair';
                        } else {
                            // Exit box select mode
                            const prev = boxSelectState.prevRenderMode;
                            state.renderMode = prev;
                            events.fire('renderMode:changed', prev);
                            this.eraserActive = false;

                            boxSelectBtn.classList.remove('active');
                            boxSelectBtn.style.background = '';
                            boxSelectBtn.style.color = '';
                            canvas.style.cursor = '';
                        }
                        app.renderNextFrame = true;
                    });
                    buttonsContainer.appendChild(boxSelectBtn);

                    // Compute world-space brush radius
                    const getWorldRadius = () => {
                        const camDist = this.cameraManager ? this.cameraManager.camera.distance : 100;
                        return eraserModeState.brushScale * camDist;
                    };

                    // Get normalized mouse coords for ray
                    const getNormalized = (clientX: number, clientY: number) => {
                        const rect = canvas.getBoundingClientRect();
                        return {
                            nx: (clientX - rect.left) / rect.width,
                            ny: (clientY - rect.top) / rect.height
                        };
                    };

                    // Find indices near ray
                    const findIndices = (clientX: number, clientY: number) => {
                        const pickerRef = (this as any)._picker;
                        if (!pickerRef || !pickerRef.positionCacheValid) return [];
                        const { nx, ny } = getNormalized(clientX, clientY);
                        return pickerRef.getSplatsNearRay(nx, ny, getWorldRadius());
                    };

                    // Eraser pointer events
                    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
                        if (!eraserModeState.enabled || e.button !== 0) return;
                        e.preventDefault();
                        e.stopPropagation();
                        eraserModeState.isErasing = true;
                        // Clear preview, do actual erase
                        this.centersOverlay.clearErasePreview();
                        const indices = findIndices(e.clientX, e.clientY);
                        if (indices.length > 0) {
                            this.centersOverlay.eraseSplats(indices);
                            app.renderNextFrame = true;
                        }
                    });

                    canvas.addEventListener('pointermove', (e: PointerEvent) => {
                        if (!eraserModeState.enabled) return;

                        if (eraserModeState.isErasing) {
                            e.preventDefault();
                            // Erasing: actually erase points
                            const indices = findIndices(e.clientX, e.clientY);
                            if (indices.length > 0) {
                                this.centersOverlay.eraseSplats(indices);
                                app.renderNextFrame = true;
                            }
                        } else {
                            // Hovering: preview which points would be erased (red highlight)
                            this.centersOverlay.clearErasePreview();
                            const indices = findIndices(e.clientX, e.clientY);
                            this.centersOverlay.previewErase(indices);
                            app.renderNextFrame = true;
                        }
                    });

                    const stopErasing = () => {
                        eraserModeState.isErasing = false;
                    };
                    canvas.addEventListener('pointerup', stopErasing);
                    canvas.addEventListener('pointerleave', () => {
                        eraserModeState.isErasing = false;
                        this.centersOverlay.clearErasePreview();
                        app.renderNextFrame = true;
                    });

                    // Box select pointer events
                    canvas.addEventListener('pointerdown', (e: PointerEvent) => {
                        if (!boxSelectState.enabled || e.button !== 0) return;
                        e.preventDefault();
                        boxSelectState.isDrawing = true;
                        boxSelectState.startX = e.clientX;
                        boxSelectState.startY = e.clientY;
                        canvas.setPointerCapture(e.pointerId);

                        const div = document.createElement('div');
                        div.style.cssText = 'position:fixed; border:2px dashed #00aaff; background:rgba(0,170,255,0.1); pointer-events:none; z-index:10000;';
                        div.style.left = `${e.clientX}px`;
                        div.style.top = `${e.clientY}px`;
                        div.style.width = '0px';
                        div.style.height = '0px';
                        document.body.appendChild(div);
                        boxSelectState.rectDiv = div;
                    });

                    canvas.addEventListener('pointermove', (e: PointerEvent) => {
                        if (!boxSelectState.isDrawing || !boxSelectState.rectDiv) return;
                        const left = Math.min(boxSelectState.startX, e.clientX);
                        const top = Math.min(boxSelectState.startY, e.clientY);
                        const width = Math.abs(e.clientX - boxSelectState.startX);
                        const height = Math.abs(e.clientY - boxSelectState.startY);
                        boxSelectState.rectDiv.style.left = `${left}px`;
                        boxSelectState.rectDiv.style.top = `${top}px`;
                        boxSelectState.rectDiv.style.width = `${width}px`;
                        boxSelectState.rectDiv.style.height = `${height}px`;
                    });

                    canvas.addEventListener('pointerup', (e: PointerEvent) => {
                        if (!boxSelectState.isDrawing) return;
                        boxSelectState.isDrawing = false;

                        if (boxSelectState.rectDiv) {
                            boxSelectState.rectDiv.remove();
                            boxSelectState.rectDiv = null;
                        }

                        const rect = canvas.getBoundingClientRect();
                        const nx1 = (Math.min(boxSelectState.startX, e.clientX) - rect.left) / rect.width;
                        const ny1 = (Math.min(boxSelectState.startY, e.clientY) - rect.top) / rect.height;
                        const nx2 = (Math.max(boxSelectState.startX, e.clientX) - rect.left) / rect.width;
                        const ny2 = (Math.max(boxSelectState.startY, e.clientY) - rect.top) / rect.height;

                        // Guard minimum rect size (5px)
                        const pixelWidth = Math.abs(e.clientX - boxSelectState.startX);
                        const pixelHeight = Math.abs(e.clientY - boxSelectState.startY);
                        if (pixelWidth < 5 || pixelHeight < 5) return;

                        const pickerRef = (this as any)._picker;
                        if (!pickerRef || !pickerRef.positionCacheValid) return;

                        const keepIndices = pickerRef.getPointsInScreenRect(nx1, ny1, nx2, ny2);
                        if (keepIndices.length === 0) return;

                        this.centersOverlay.eraseAllExcept(new Set(keepIndices));
                        app.renderNextFrame = true;
                    });

                    // Wire compute button in normalListUI
                    if (this.normalListUI) {
                        this.normalListUI.onComputeClick = () => {
                            const normalPoints = this.normalMarker.points;
                            if (normalPoints.length < 3) {
                                alert('Select at least 3 points to compute normal');
                                return;
                            }

                            if (!picker) {
                                picker = (this as any)._picker;
                            }
                            if (!picker || !picker.cachedPositions || picker.cachedPositions.length === 0) {
                                alert('Point cloud data not loaded yet');
                                return;
                            }

                            const indices = normalPoints.map(p => p.index);
                            const worldMatrix = results[0].getWorldTransform();
                            const normal = computePCANormalFromPoints(indices, picker.cachedPositions, worldMatrix);

                            if (normal) {
                                // Compute centroid of selected points
                                const centroid = computeCentroid(normalPoints.map(p => p.position));
                                this.normalMarker.setComputedNormal(normal, centroid);
                                this.normalListUI.showNormalResult(normal);
                            } else {
                                alert('Failed to compute normal. Try selecting more spread-out points.');
                            }
                            app.renderNextFrame = true;
                        };
                    }

                    // Delete last point button
                    const deleteBtn = document.createElement('button');
                    deleteBtn.id = 'deleteLastPointBtn';
                    deleteBtn.className = 'controlButton';
                    deleteBtn.title = 'Delete Last Point';
                    deleteBtn.innerHTML = '⌫';
                    deleteBtn.style.cssText = 'font-size: 20px; padding: 8px;';
                    deleteBtn.addEventListener('click', () => {
                        this.pointMarker.deleteLastPoint();
                        app.renderNextFrame = true;
                    });
                    buttonsContainer.appendChild(deleteBtn);

                    // Clear all button
                    const clearBtn = document.createElement('button');
                    clearBtn.id = 'clearAllPointsBtn';
                    clearBtn.className = 'controlButton';
                    clearBtn.title = 'Clear All Points';
                    clearBtn.innerHTML = '🗑️';
                    clearBtn.style.cssText = 'font-size: 20px; padding: 8px;';
                    clearBtn.addEventListener('click', () => {
                        if (confirm('Clear all marked points?')) {
                            this.pointMarker.clearAll();
                            this.normalMarker.clearAll();
                            if (this.normalListUI) this.normalListUI.clearResult();
                            app.renderNextFrame = true;
                        }
                    });
                    buttonsContainer.appendChild(clearBtn);

                    // Load JSON button (hidden file input)
                    const loadInput = document.createElement('input');
                    loadInput.type = 'file';
                    loadInput.accept = '.json';
                    loadInput.style.display = 'none';
                    loadInput.addEventListener('change', async (e) => {
                        const file = (e.target as HTMLInputElement).files?.[0];
                        if (!file) return;

                        try {
                            const text = await file.text();
                            const jsonData = JSON.parse(text);

                            // Find points callback - find closest point in point cloud
                            const findPointCallback = async (x: number, y: number, z: number) => {
                                if (!picker || !results[0]) {
                                    const { Picker } = await import('./picker');
                                    picker = new Picker(app, camera, results[0]);
                                }

                                const targetPos = new Vec3(x, y, z);

                                if (!picker.positionCacheValid) {
                                    await new Promise(resolve => setTimeout(resolve, 500));
                                }

                                if (!picker.cachedPositions || picker.cachedPositions.length === 0) {
                                    return null;
                                }

                                const gsplat = results[0].gsplat as GSplatComponent;
                                if (!gsplat) return null;

                                const worldMatrix = results[0].getWorldTransform();
                                let closestIndex = -1;
                                let minDistance = Infinity;
                                let closestPosition: Vec3 | null = null;

                                const maxPointsToCheck = 100000;
                                const step = picker.cachedPositions.length > maxPointsToCheck
                                    ? Math.ceil(picker.cachedPositions.length / maxPointsToCheck)
                                    : 1;

                                for (let i = 0; i < picker.cachedPositions.length; i += step) {
                                    const localPos = picker.cachedPositions[i];
                                    const worldPos = new Vec3();
                                    worldMatrix.transformPoint(localPos, worldPos);

                                    const distance = worldPos.distance(targetPos);
                                    if (distance < minDistance) {
                                        minDistance = distance;
                                        closestIndex = i;
                                        closestPosition = worldPos;
                                    }
                                }

                                if (closestIndex >= 0 && closestPosition && minDistance <= 0.001) {
                                    return {
                                        index: closestIndex,
                                        position: closestPosition,
                                        color: new Color(1, 1, 1)
                                    };
                                }

                                return null;
                            };

                            if (Array.isArray(jsonData)) {
                                // Old format: plain array of [x,y,z]
                                const loadedCount = await this.pointMarker.importFromJSON(jsonData, findPointCallback);
                                alert(`Loaded ${loadedCount} of ${jsonData.length} points`);
                            } else if (jsonData && typeof jsonData === 'object') {
                                // New format: { points: [...], normal_direction: {...} }
                                if (jsonData.points && Array.isArray(jsonData.points)) {
                                    const loadedCount = await this.pointMarker.importFromJSON(jsonData.points, findPointCallback);
                                    console.log(`Loaded ${loadedCount} regular points`);
                                }
                                if (jsonData.normal_direction) {
                                    const nd = jsonData.normal_direction;
                                    this.normalMarker.clearAll();
                                    if (nd.points && Array.isArray(nd.points)) {
                                        for (const pt of nd.points) {
                                            if (Array.isArray(pt) && pt.length >= 3) {
                                                // Find the closest point in the cloud
                                                const result = await findPointCallback(pt[0], pt[1], pt[2]);
                                                if (result) {
                                                    this.normalMarker.addPoint(result.index, result.position);
                                                }
                                            }
                                        }
                                    }
                                    if (nd.normal && nd.centroid) {
                                        const normal = new Vec3(nd.normal[0], nd.normal[1], nd.normal[2]);
                                        const centroid = new Vec3(nd.centroid[0], nd.centroid[1], nd.centroid[2]);
                                        this.normalMarker.setComputedNormal(normal, centroid);
                                        if (this.normalListUI) {
                                            this.normalListUI.showNormalResult(normal);
                                        }
                                    }
                                    const totalLoaded = (jsonData.points?.length || 0) + (nd.points?.length || 0);
                                    alert(`Loaded points and normal direction data`);
                                } else {
                                    alert('Invalid JSON format');
                                }
                            } else {
                                alert('Invalid JSON format');
                            }
                            app.renderNextFrame = true;
                        } catch (error) {
                            alert(`Failed to load JSON: ${error}`);
                        }
                    });
                    document.body.appendChild(loadInput);

                    const loadBtn = document.createElement('button');
                    loadBtn.id = 'loadPointsBtn';
                    loadBtn.className = 'controlButton';
                    loadBtn.title = 'Load Points from JSON';
                    loadBtn.innerHTML = '📂';
                    loadBtn.style.cssText = 'font-size: 20px; padding: 8px;';
                    loadBtn.addEventListener('click', () => loadInput.click());
                    buttonsContainer.appendChild(loadBtn);
                }
            }

            const { instance } = gsplat;
            if (instance) {
                // kick off gsplat sorting immediately now that camera is in position
                instance.sort(camera);

                // get the gsplat material for depth viz toggling
                const gsplatMaterial = gsplat.unified ? app.scene.gsplat.material : gsplat.material;
                this._gsplatMaterial = gsplatMaterial;

                // handle render mode changes for non-LOD splats
                const updateSplatRendering = () => {
                    // Enable/disable gsplat component based on render mode
                    gsplat.enabled = state.renderMode !== 'off';

                    // toggle depth visualization define on the material
                    if (gsplatMaterial) {
                        gsplatMaterial.setDefine('GSPLAT_DEPTH_VIZ', state.renderMode === 'depth');
                        gsplatMaterial.update();
                    }

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

                        // get the LOD gsplat material for depth viz toggling
                        const lodMaterial = gsplat.material;
                        this._gsplatMaterial = lodMaterial;

                        // handle quality mode changes
                        const updateLod = () => {
                            if (state.renderMode === 'off') {
                                // disable LOD rendering by setting budget to 0
                                results[0].gsplat.splatBudget = 0;
                            } else {
                                const splatBudget = (state.renderMode === 'high' || state.renderMode === 'depth') ? quality.high : quality.low;
                                results[0].gsplat.splatBudget = splatBudget * 1000000;
                            }

                            // toggle depth visualization define on the material
                            if (lodMaterial) {
                                lodMaterial.setDefine('GSPLAT_DEPTH_VIZ', state.renderMode === 'depth');
                                lodMaterial.update();
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
