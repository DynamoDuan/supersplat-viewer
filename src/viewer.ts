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

        // Create point marker (scene will be set in attach method)
        this.pointMarker = new PointMarker(app);
        
        // Create point list UI (will be initialized after DOM is ready)
        this.pointListUI = null as any;

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

            // Attach point marker to gsplat entity
            this.pointMarker.attach(results[0]);

            // Initialize point list UI after DOM is ready
            if (!config.noui && !this.pointListUI) {
                const uiContainer = document.getElementById('ui');
                if (uiContainer) {
                    const pointListContainer = document.createElement('div');
                    pointListContainer.id = 'pointListContainer';
                    // Leave bottom space for settingsPanel (bottom: 86px + padding)
                    pointListContainer.style.cssText = 'position: fixed; right: 0; top: 0; width: 300px; height: calc(100vh - 200px); z-index: 999; pointer-events: none;';
                    const innerContainer = document.createElement('div');
                    innerContainer.style.cssText = 'pointer-events: auto; height: 100%;';
                    pointListContainer.appendChild(innerContainer);
                    uiContainer.appendChild(pointListContainer);
                    this.pointListUI = new PointListUI(innerContainer, this.pointMarker);
                }
            }

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

            // Setup mouse move for precise real-time cursor highlighting AFTER cameraManager is initialized
            const canvas = graphicsDevice.canvas;
            let picker: any = null;
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
                    // Use picker to get precise world position under cursor (actual point position, not fixed distance)
                    // Similar to annotation.html: ray-based point selection without depth buffer
                    if (!picker) {
                        const { Picker } = await import('./picker');
                        picker = new Picker(app, camera, results[0]); // Pass gsplatEntity
                    }

                    const worldPos = await picker.pick(x, y);
                    if (worldPos) {
                        // Set precise cursor position for highlighting (actual point position from picker)
                        // Use a larger radius to highlight approximately 10 nearest points
                        // The radius will be dynamically adjusted based on point density
                        this.centersOverlay.setCursorHighlightRadius(0.01); // Larger radius for ~10 points
                        this.centersOverlay.setCursorPosition(worldPos, true);
                    } else {
                        // No point found under cursor
                        this.centersOverlay.setCursorPosition(null, false);
                    }
                    
                    // Request immediate render
                    app.renderNextFrame = true;
                } catch (error) {
                    // Silently handle errors
                    console.debug('Highlight error:', error);
                    this.centersOverlay.setCursorPosition(null, false);
                } finally {
                    isUpdating = false;
                    // Process any pending update
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
                    this.centersOverlay.setCursorPosition(null, false);
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
                this.centersOverlay.setCursorPosition(null, false);
                app.renderNextFrame = true;
            });

            // Setup click handler for point selection
            const selectModeState = { enabled: false };
            canvas.addEventListener('click', async (e: MouseEvent) => {
                console.log('Canvas clicked, selectModeState.enabled:', selectModeState.enabled, 'state.showCenters:', state.showCenters, 'centersOverlay.isEnabled:', this.centersOverlay.isEnabled);
                if (!selectModeState.enabled) {
                    console.log('Click ignored - selectModeState.enabled is false');
                    return;
                }
                if (!state.showCenters || !this.centersOverlay.isEnabled) {
                    console.log('Click ignored - showCenters or overlay not enabled. showCenters:', state.showCenters, 'overlay.isEnabled:', this.centersOverlay.isEnabled);
                    // Try to enable it
                    state.showCenters = true;
                    this.centersOverlay.setEnabled(true);
                    events.fire('showCenters:changed', true);
                    console.log('Auto-enabled showCenters, retrying...');
                    // Don't return, continue with the click
                }
                
                console.log('Processing point selection...');
                const rect = canvas.getBoundingClientRect();
                const x = (e.clientX - rect.left) / rect.width;
                const y = (e.clientY - rect.top) / rect.height;
                console.log('Normalized coordinates:', x, y);

                try {
                    if (!picker) {
                        console.log('Initializing picker...');
                        const { Picker } = await import('./picker');
                        picker = new Picker(app, camera, results[0]);
                    }

                    console.log('Getting closest point...');
                    const result = await picker.getClosestPointIndex(x, y);
                    console.log('Picker result:', result);
                    if (result && this.pointMarker) {
                        // Get original color (default white)
                        const originalColor = new Color(1, 1, 1);
                        console.log('Selecting point:', result.index, result.position);
                        this.pointMarker.selectPoint(result.index, result.position, originalColor);
                        app.renderNextFrame = true;
                        console.log('Point selected successfully');
                    } else {
                        console.log('No point found or pointMarker not available');
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
                        const jsonData = this.pointMarker.exportToJSON();
                        if (jsonData.length === 0) {
                            alert('No points selected');
                            return;
                        }
                        const jsonString = JSON.stringify(jsonData, null, 2);
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
                        console.log('Toggle button clicked, current state:', selectModeState.enabled);
                        console.log('Before toggle - state.showCenters:', state.showCenters, 'centersOverlay.isEnabled:', this.centersOverlay.isEnabled);
                        selectModeState.enabled = !selectModeState.enabled;
                        if (selectModeState.enabled) {
                            selectBtn.classList.add('active');
                            state.showCenters = true;
                            this.centersOverlay.setEnabled(true);
                            events.fire('showCenters:changed', true);
                            console.log('Select mode enabled');
                            console.log('After toggle - state.showCenters:', state.showCenters, 'centersOverlay.isEnabled:', this.centersOverlay.isEnabled);
                        } else {
                            selectBtn.classList.remove('active');
                            console.log('Select mode disabled');
                        }
                        console.log('New selectModeState.enabled:', selectModeState.enabled);
                    });
                    buttonsContainer.appendChild(selectBtn);

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
                            
                            if (!Array.isArray(jsonData)) {
                                alert('Invalid JSON format. Expected array of [x, y, z] arrays.');
                                return;
                            }

                            // Find points callback - find closest point in point cloud
                            const findPointCallback = async (x: number, y: number, z: number) => {
                                if (!picker || !results[0]) {
                                    const { Picker } = await import('./picker');
                                    picker = new Picker(app, camera, results[0]);
                                }

                                // Access picker's cached positions to find closest point
                                const targetPos = new Vec3(x, y, z);
                                
                                // Wait for positions to be loaded
                                if (!picker.positionCacheValid) {
                                    // Wait a bit for async loading
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

                                // Search through cached positions
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

                            const loadedCount = await this.pointMarker.importFromJSON(jsonData, findPointCallback);
                            alert(`Loaded ${loadedCount} of ${jsonData.length} points`);
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
