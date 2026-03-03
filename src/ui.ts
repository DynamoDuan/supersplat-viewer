import { EventHandler } from 'playcanvas';

import { Tooltip } from './tooltip';
import { Global } from './types';

// Initialize the touch joystick for fly mode camera control
const initJoystick = (
    dom: Record<string, HTMLElement>,
    events: EventHandler,
    state: { cameraMode: string; inputMode: string }
) => {
    // Joystick dimensions (matches SCSS: base height=120, stick size=48)
    const joystickHeight = 120;
    const stickSize = 48;
    const stickCenterY = (joystickHeight - stickSize) / 2; // 36px - top position when centered
    const stickCenterX = (joystickHeight - stickSize) / 2; // 36px - left position when centered (for 2D mode)
    const maxStickTravel = stickCenterY; // can travel 36px up or down from center

    // Fixed joystick position (bottom-left corner with safe area)
    const joystickFixedX = 70;
    const joystickFixedY = () => window.innerHeight - 140;

    // Joystick touch state
    let joystickPointerId: number | null = null;
    let joystickValueX = 0; // -1 to 1, negative = left, positive = right
    let joystickValueY = 0; // -1 to 1, negative = forward, positive = backward

    // Joystick mode: '1d' for vertical only, '2d' for full directional
    let joystickMode: '1d' | '2d' = '2d';

    // Double-tap detection for mode toggle
    let lastTapTime = 0;

    // Update joystick visibility based on camera mode and input mode
    const updateJoystickVisibility = () => {
        // Always hide joystick (no fly mode, matching Three.js OrbitControls)
        dom.joystickBase.classList.add('hidden');
    };

    events.on('cameraMode:changed', updateJoystickVisibility);
    events.on('inputMode:changed', updateJoystickVisibility);
    window.addEventListener('resize', updateJoystickVisibility);

    // Handle joystick touch input directly on the joystick element
    const updateJoystickStick = (clientX: number, clientY: number) => {
        const baseY = joystickFixedY();
        // Calculate Y offset from joystick center (positive = down/backward)
        const offsetY = clientY - baseY;
        // Clamp to max travel and normalize to -1 to 1
        const clampedOffsetY = Math.max(-maxStickTravel, Math.min(maxStickTravel, offsetY));
        joystickValueY = clampedOffsetY / maxStickTravel;

        // Update stick visual Y position
        dom.joystick.style.top = `${stickCenterY + clampedOffsetY}px`;

        // Handle X axis in 2D mode
        if (joystickMode === '2d') {
            const baseX = joystickFixedX;
            const offsetX = clientX - baseX;
            const clampedOffsetX = Math.max(-maxStickTravel, Math.min(maxStickTravel, offsetX));
            joystickValueX = clampedOffsetX / maxStickTravel;

            // Update stick visual X position
            dom.joystick.style.left = `${stickCenterX + clampedOffsetX}px`;
        } else {
            joystickValueX = 0;
        }

        // Fire input event for the input controller
        events.fire('joystickInput', { x: joystickValueX, y: joystickValueY });
    };

    dom.joystickBase.addEventListener('pointerdown', (event: PointerEvent) => {
        // Double-tap detection for mode toggle
        const now = Date.now();
        if (now - lastTapTime < 300) {
            joystickMode = joystickMode === '1d' ? '2d' : '1d';
            updateJoystickVisibility();
            lastTapTime = 0;
        } else {
            lastTapTime = now;
        }

        if (joystickPointerId !== null) return; // Already tracking a touch

        joystickPointerId = event.pointerId;
        dom.joystickBase.setPointerCapture(event.pointerId);

        updateJoystickStick(event.clientX, event.clientY);
        event.preventDefault();
        event.stopPropagation();
    });

    dom.joystickBase.addEventListener('pointermove', (event: PointerEvent) => {
        if (event.pointerId !== joystickPointerId) return;

        updateJoystickStick(event.clientX, event.clientY);
        event.preventDefault();
    });

    const endJoystickTouch = (event: PointerEvent) => {
        if (event.pointerId !== joystickPointerId) return;

        joystickPointerId = null;
        joystickValueX = 0;
        joystickValueY = 0;

        // Reset stick to center
        dom.joystick.style.top = `${stickCenterY}px`;
        if (joystickMode === '2d') {
            dom.joystick.style.left = `${stickCenterX}px`;
        }

        // Fire input event with zero values
        events.fire('joystickInput', { x: 0, y: 0 });

        dom.joystickBase.releasePointerCapture(event.pointerId);
    };

    dom.joystickBase.addEventListener('pointerup', endJoystickTouch);
    dom.joystickBase.addEventListener('pointercancel', endJoystickTouch);
};

// update the poster image to start blurry and then resolve to sharp during loading
const initPoster = (events: EventHandler) => {
    const poster = document.getElementById('poster');

    events.on('firstFrame', () => {
        poster.style.display = 'none';
        document.documentElement.style.setProperty('--canvas-opacity', '1');
    });

    const blur = (progress: number) => {
        poster.style.filter = `blur(${Math.floor((100 - progress) * 0.4)}px)`;
    };

    events.on('progress:changed', blur);
};

const initUI = (global: Global) => {
    const { config, events, state } = global;

    // Acquire Elements
    const docRoot = document.documentElement;
    const dom = [
        'ui',
        'frameTop', 'resetTop', 'centersToggle', 'filterToggle',
        'centersCheck', 'filterCheck',
        'controlsWrap',
        'arMode', 'vrMode',
        'enterFullscreen', 'exitFullscreen',
        'info', 'infoPanel', 'desktopTab', 'touchTab', 'desktopInfoPanel', 'touchInfoPanel',
        'settings', 'settingsPanel',
        'hqCheck', 'hqOption', 'lqCheck', 'lqOption', 'offCheck', 'offOption', 'depthCheck', 'depthOption',
        'showFilteredCheck', 'showFilteredOption', 'filterStatsRow', 'filterStatsTotal', 'filterStatsVisible', 'filterStatsFiltered',
        'centersSettings', 'filterSettings',
        'centersSizeSlider', 'centersSizeValue',
        'depthFilterSlider', 'depthFilterValue',
        'saveResetView', 'restoreDefaultView',
        'loadingText', 'loadingBar',
        'joystickBase', 'joystick',
        'tooltip'
    ].reduce((acc: Record<string, HTMLElement>, id) => {
        acc[id] = document.getElementById(id);
        return acc;
    }, {}) as Record<string, HTMLElement> & {
        centersSizeSlider: HTMLInputElement;
        depthFilterSlider: HTMLInputElement;
        centersSettings: HTMLElement;
        filterSettings: HTMLElement;
        showFilteredCheck: HTMLElement;
        showFilteredOption: HTMLElement;
        filterStatsRow: HTMLElement;
        filterStatsTotal: HTMLElement;
        filterStatsVisible: HTMLElement;
        filterStatsFiltered: HTMLElement;
        centersToggle: HTMLElement;
        filterToggle: HTMLElement;
        centersCheck: HTMLElement;
        filterCheck: HTMLElement;
        frameTop: HTMLElement;
        resetTop: HTMLElement;
    };

    // Handle loading progress updates
    events.on('progress:changed', (progress) => {
        dom.loadingText.textContent = `${progress}%`;
        if (progress < 100) {
            dom.loadingBar.style.backgroundImage = `linear-gradient(90deg, #3b82f6 0%, #3b82f6 ${progress}%, #334155 ${progress}%, #334155 100%)`;
        } else {
            dom.loadingBar.style.backgroundImage = 'linear-gradient(90deg, #3b82f6 0%, #3b82f6 100%)';
        }
    });

    // Hide loading bar once first frame is rendered
    events.on('firstFrame', () => {
        document.getElementById('loadingWrap').classList.add('hidden');
    });

    // Fullscreen support
    const hasFullscreenAPI = docRoot.requestFullscreen && document.exitFullscreen;

    const requestFullscreen = () => {
        if (hasFullscreenAPI) {
            docRoot.requestFullscreen();
        } else {
            window.parent.postMessage('requestFullscreen', '*');
            state.isFullscreen = true;
        }
    };

    const exitFullscreen = () => {
        if (hasFullscreenAPI) {
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
            }
        } else {
            window.parent.postMessage('exitFullscreen', '*');
            state.isFullscreen = false;
        }
    };

    if (hasFullscreenAPI) {
        document.addEventListener('fullscreenchange', () => {
            state.isFullscreen = !!document.fullscreenElement;
        });
    }

    dom.enterFullscreen.addEventListener('click', requestFullscreen);
    dom.exitFullscreen.addEventListener('click', exitFullscreen);

    // toggle fullscreen when user switches between landscape portrait
    // orientation
    screen?.orientation?.addEventListener('change', (event) => {
        if (['landscape-primary', 'landscape-secondary'].includes(screen.orientation.type)) {
            requestFullscreen();
        } else {
            exitFullscreen();
        }
    });

    // update UI when fullscreen state changes
    events.on('isFullscreen:changed', (value) => {
        dom.enterFullscreen.classList[value ? 'add' : 'remove']('hidden');
        dom.exitFullscreen.classList[value ? 'remove' : 'add']('hidden');
    });

    // Render mode
    dom.hqOption.addEventListener('click', () => {
        state.renderMode = 'high';
    });
    dom.lqOption.addEventListener('click', () => {
        state.renderMode = 'low';
    });
    dom.offOption.addEventListener('click', () => {
        state.renderMode = 'off';
    });
    dom.depthOption.addEventListener('click', () => {
        state.renderMode = 'depth';
    });

    const updateRenderMode = () => {
        dom.hqCheck.classList[state.renderMode === 'high' ? 'add' : 'remove']('active');
        dom.lqCheck.classList[state.renderMode === 'low' ? 'add' : 'remove']('active');
        dom.offCheck.classList[state.renderMode === 'off' ? 'add' : 'remove']('active');
        dom.depthCheck.classList[state.renderMode === 'depth' ? 'add' : 'remove']('active');
    };
    events.on('renderMode:changed', () => {
        updateRenderMode();
    });
    updateRenderMode();

    // AR/VR
    const arChanged = () => dom.arMode.classList[state.hasAR ? 'remove' : 'add']('hidden');
    const vrChanged = () => dom.vrMode.classList[state.hasVR ? 'remove' : 'add']('hidden');

    dom.arMode.addEventListener('click', () => events.fire('startAR'));
    dom.vrMode.addEventListener('click', () => events.fire('startVR'));

    events.on('hasAR:changed', arChanged);
    events.on('hasVR:changed', vrChanged);

    arChanged();
    vrChanged();

    // Info panel
    const updateInfoTab = (tab: 'desktop' | 'touch') => {
        if (tab === 'desktop') {
            dom.desktopTab.classList.add('active');
            dom.touchTab.classList.remove('active');
            dom.desktopInfoPanel.classList.remove('hidden');
            dom.touchInfoPanel.classList.add('hidden');
        } else {
            dom.desktopTab.classList.remove('active');
            dom.touchTab.classList.add('active');
            dom.desktopInfoPanel.classList.add('hidden');
            dom.touchInfoPanel.classList.remove('hidden');
        }
    };

    dom.desktopTab.addEventListener('click', () => {
        updateInfoTab('desktop');
    });

    dom.touchTab.addEventListener('click', () => {
        updateInfoTab('touch');
    });

    dom.info.addEventListener('click', () => {
        updateInfoTab(state.inputMode);
        dom.infoPanel.classList.toggle('hidden');
    });

    dom.infoPanel.addEventListener('pointerdown', () => {
        dom.infoPanel.classList.add('hidden');
    });

    events.on('inputEvent', (event) => {
        if (event === 'cancel') {
            // close info panel on cancel
            dom.infoPanel.classList.add('hidden');
            dom.settingsPanel.classList.add('hidden');

            // close fullscreen on cancel
            if (state.isFullscreen) {
                exitFullscreen();
            }
        } else if (event === 'interrupt') {
            dom.settingsPanel.classList.add('hidden');
        }
    });

    // fade ui controls after 5 seconds of inactivity
    events.on('controlsHidden:changed', (value) => {
        dom.controlsWrap.className = value ? 'faded-out' : 'faded-in';
    });

    // show the ui and start a timer to hide it again
    let uiTimeout: ReturnType<typeof setTimeout> | null = null;
    const showUI = () => {
        if (uiTimeout) {
            clearTimeout(uiTimeout);
        }
        state.controlsHidden = false;
        uiTimeout = setTimeout(() => {
            uiTimeout = null;
            state.controlsHidden = true;
        }, 4000);
    };
    showUI();

    events.on('inputEvent', showUI);

    dom.settings.addEventListener('click', () => {
        dom.settingsPanel.classList.toggle('hidden');
    });

    // Centers point size slider
    dom.centersSizeSlider.addEventListener('input', (e: Event) => {
        const value = parseFloat((e.target as HTMLInputElement).value);
        state.centersPointSize = value;
        dom.centersSizeValue.textContent = value.toFixed(2);
        events.fire('centersPointSize:changed', value);
    });

    events.on('centersPointSize:changed', (value: number) => {
        dom.centersSizeSlider.value = value.toString();
        dom.centersSizeValue.textContent = value.toFixed(2);
    });

    // Depth filter slider
    dom.depthFilterSlider.addEventListener('input', (e: Event) => {
        const value = parseFloat((e.target as HTMLInputElement).value);
        dom.depthFilterValue.textContent = value.toFixed(4);
        events.fire('depthFilter:changed', value);
    });

    // Keyboard control for depth filter slider (arrow keys and +/- keys)
    dom.depthFilterSlider.addEventListener('keydown', (e: KeyboardEvent) => {
        const slider = e.target as HTMLInputElement;
        const currentValue = parseFloat(slider.value);
        const min = parseFloat(slider.min);
        const max = parseFloat(slider.max);
        const step = 0.001; // Keyboard step size
        let newValue = currentValue;

        // Handle arrow keys and +/- keys
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === '+' || e.key === '=') {
            e.preventDefault();
            newValue = Math.min(currentValue + step, max);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === '-') {
            e.preventDefault();
            newValue = Math.max(currentValue - step, min);
        } else {
            return; // Not a key we handle
        }

        // Update slider value
        slider.value = newValue.toFixed(4);
        dom.depthFilterValue.textContent = newValue.toFixed(4);
        events.fire('depthFilter:changed', newValue);
    });

    // Make slider focusable for keyboard control
    dom.depthFilterSlider.setAttribute('tabindex', '0');

    // Track show filtered points state locally for UI visibility logic
    let showFilteredPoints = false;

    // Show filtered points toggle
    dom.showFilteredOption.addEventListener('click', () => {
        events.fire('showFilteredPoints:toggle');
    });

    // Update show filtered points checkmark when state changes
    events.on('showFilteredPoints:changed', (value: boolean) => {
        showFilteredPoints = value;
        dom.showFilteredCheck.classList[value ? 'add' : 'remove']('active');
        // Show/hide filter statistics based on Show Filtered Points state
        dom.filterStatsRow.style.display = (value && depthFilterEnabled) ? 'flex' : 'none';
    });

    // Update filter statistics
    events.on('filterStats:changed', (stats: { total: number; visible: number; filtered: number }) => {
        dom.filterStatsTotal.textContent = stats.total.toLocaleString();
        dom.filterStatsVisible.textContent = stats.visible.toLocaleString();
        dom.filterStatsFiltered.textContent = stats.filtered.toLocaleString();
    });

    // Top toolbar - Camera tools
    dom.frameTop.addEventListener('click', (event) => {
        events.fire('inputEvent', 'frame', event);
    });

    dom.resetTop.addEventListener('click', (event) => {
        events.fire('inputEvent', 'reset', event);
    });

    // Top toolbar - Centers toggle
    dom.centersToggle.addEventListener('click', () => {
        state.showCenters = !state.showCenters;
    });

    events.on('showCenters:changed', (value: boolean) => {
        dom.centersCheck.classList[value ? 'add' : 'remove']('active');
        dom.centersSettings.style.display = value ? 'block' : 'none';
    });

    // Initialize Centers
    dom.centersCheck.classList[state.showCenters ? 'add' : 'remove']('active');
    dom.centersSettings.style.display = state.showCenters ? 'block' : 'none';

    // Camera Gizmo toggle (keyboard shortcut 'G')
    events.on('keyboard:g', () => {
        state.showCameraGizmo = !state.showCameraGizmo;
        events.fire('showCameraGizmo:changed', state.showCameraGizmo);
        console.log('Camera gizmo visibility:', state.showCameraGizmo);
    });

    // Filter toggle
    dom.filterToggle.addEventListener('click', () => {
        events.fire('depthFilter:toggle');
    });

    // Track depth filter state for UI
    let depthFilterEnabled = false;
    events.on('depthFilterEnabled:changed', (value: boolean) => {
        depthFilterEnabled = value;
        dom.filterCheck.classList[value ? 'add' : 'remove']('active');
        dom.filterSettings.style.display = value ? 'block' : 'none';
    });

    // Initialize Filter
    dom.filterCheck.classList.remove('active');
    dom.filterSettings.style.display = 'none';

    // Fly camera button removed (only orbit mode, matching Three.js OrbitControls)
    // dom.flyCamera.addEventListener('click', () => {
    //     state.cameraMode = 'fly';
    // });

    dom.saveResetView.addEventListener('click', () => {
        events.fire('saveResetView');
    });

    dom.restoreDefaultView.addEventListener('click', () => {
        events.fire('restoreDefaultResetView');
    });

    // Initialize touch joystick for fly mode
    initJoystick(dom, events, state);

    // Hide all UI (poster, loading bar, controls)
    if (config.noui) {
        dom.ui.classList.add('hidden');
    }

    // tooltips
    const tooltip = new Tooltip(dom.tooltip);

    tooltip.register(dom.saveResetView, 'Save Current View as Default Reset Position', 'bottom');
    tooltip.register(dom.restoreDefaultView, 'Restore Factory Default View', 'bottom');
    tooltip.register(dom.settings, 'Settings', 'top');
    tooltip.register(dom.info, 'Help', 'top');
    tooltip.register(dom.arMode, 'Enter AR', 'top');
    tooltip.register(dom.vrMode, 'Enter VR', 'top');
    tooltip.register(dom.enterFullscreen, 'Fullscreen', 'top');
    tooltip.register(dom.exitFullscreen, 'Fullscreen', 'top');
};

export { initPoster, initUI };
