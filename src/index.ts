import '@playcanvas/web-components';
import {
    Asset,
    Entity,
    EventHandler,
    platform,
    type Texture,
    type AppBase,
    revision as engineRevision,
    version as engineVersion
} from 'playcanvas';

import { observe } from './core/observe';
import { importSettings } from './settings';
import type { Config, Global } from './types';
import { initPoster, initUI } from './ui';
import { Viewer } from './viewer';
import { initXr } from './xr';
import { version as appVersion } from '../package.json';
import { preprocessPLY, type PreprocessResult } from './ply-preprocessor';

// 标记是否为点云模式（非高斯PLY），供viewer使用
let _isPointCloudMode = false;
export const isPointCloudMode = () => _isPointCloudMode;

const loadGsplat = async (app: AppBase, config: Config, progressCallback: (progress: number) => void) => {
    const { contents, contentUrl, unified, aa } = config;
    const filename = new URL(contentUrl, location.href).pathname.split('/').pop();

    const data = filename.toLowerCase() === 'meta.json' ? await (await contents).json() : undefined;

    // 对于 PLY 文件，检测并预处理
    if (filename && filename.toLowerCase().endsWith('.ply')) {
        try {
            const response = await contents;
            const arrayBuffer = await response.arrayBuffer();
            const result = await preprocessPLY(arrayBuffer);

            if (result === null) {
                throw new Error('PLY文件无法处理');
            }

            _isPointCloudMode = result.isPointCloud;

            // 包装成Response给PlyParser流式读取
            const c = new Response(result.buffer);
            return loadGsplatAsset(app, filename, contentUrl, c, data, unified, aa, progressCallback);
        } catch (error) {
            console.warn('PLY处理失败，尝试原始加载:', error);
            const c = fetch(contentUrl);
            return loadGsplatAsset(app, filename, contentUrl, c, data, unified, aa, progressCallback);
        }
    }

    // 非PLY文件，直接传原始fetch promise
    return loadGsplatAsset(app, filename, contentUrl, contents, data, unified, aa, progressCallback);
};

const loadGsplatAsset = (app: AppBase, filename: string, contentUrl: string, c: any, data: any, unified: boolean, aa: boolean, progressCallback: (progress: number) => void) => {
    const asset = new Asset(filename, 'gsplat', { url: contentUrl, filename, contents: c }, data);

    return new Promise<Entity>((resolve, reject) => {
        asset.on('load', () => {
            const entity = new Entity('gsplat');
            entity.setLocalEulerAngles(0, 0, 180);
            entity.addComponent('gsplat', {
                unified: unified || filename.toLowerCase().endsWith('lod-meta.json'),
                asset
            });
            const material = entity.gsplat.unified ? app.scene.gsplat.material : entity.gsplat.material;
            material.setDefine('GSPLAT_AA', aa);
            material.setParameter('alphaClip', 1 / 255);
            app.root.addChild(entity);
            resolve(entity);
        });

        let watermark = 0;
        asset.on('progress', (received, length) => {
            const progress = Math.min(1, received / length) * 100;
            if (progress > watermark) {
                watermark = progress;
                progressCallback(Math.trunc(watermark));
            }
        });

        asset.on('error', (err) => {
            console.log(err);
            reject(err);
        });

        app.assets.add(asset);
        app.assets.load(asset);
    });
};

const loadSkybox = (app: AppBase, url: string) => {
    return new Promise<Asset>((resolve, reject) => {
        const asset = new Asset('skybox', 'texture', {
            url
        }, {
            type: 'rgbp',
            mipmaps: false,
            addressu: 'repeat',
            addressv: 'clamp'
        });

        asset.on('load', () => {
            resolve(asset);
        });

        asset.on('error', (err) => {
            console.log(err);
            reject(err);
        });

        app.assets.add(asset);
        app.assets.load(asset);
    });
};

const main = (app: AppBase, camera: Entity, settingsJson: any, config: Config) => {
    const events = new EventHandler();

    const state = observe(events, {
        readyToRender: false,
        renderMode: 'high',
        progress: 0,
        inputMode: platform.mobile ? 'touch' : 'desktop',
        cameraMode: 'orbit',
        hasAnimation: false,
        animationDuration: 0,
        animationTime: 0,
        animationPaused: true,
        hasAR: false,
        hasVR: false,
        isFullscreen: false,
        controlsHidden: false,
        showCenters: false,
        centersPointSize: 5
    });

    const global: Global = {
        app,
        settings: importSettings(settingsJson),
        config,
        state,
        events,
        camera
    };

    // Initialize the load-time poster
    if (config.poster) {
        initPoster(events);
    }

    camera.addComponent('camera');

    // Initialize XR support
    initXr(global);

    // Initialize user interface
    initUI(global);

    // Load model
    const gsplatLoad = loadGsplat(
        app,
        config,
        (progress: number) => {
            state.progress = progress;
        }
    );

    // Load skybox
    const skyboxLoad = config.skyboxUrl &&
        loadSkybox(app, config.skyboxUrl).then((asset) => {
            app.scene.envAtlas = asset.resource as Texture;
        });

    // Load and play sound
    if (global.settings.soundUrl) {
        const sound = new Audio(global.settings.soundUrl);
        sound.crossOrigin = 'anonymous';
        document.body.addEventListener('click', () => {
            if (sound) {
                sound.play();
            }
        }, {
            capture: true,
            once: true
        });
    }

    // Create the viewer
    return new Viewer(global, gsplatLoad, skyboxLoad);
};

console.log(`SuperSplat Viewer v${appVersion} | Engine v${engineVersion} (${engineRevision})`);

export { main };
