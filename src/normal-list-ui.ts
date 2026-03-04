import { NormalMarker } from './normal-marker';

export class NormalListUI {
    private container: HTMLElement;
    private listElement: HTMLElement;
    private pointCountElement: HTMLElement;
    private resultElement: HTMLElement;
    private normalMarker: NormalMarker;

    onComputeClick?: () => void;

    constructor(container: HTMLElement, normalMarker: NormalMarker) {
        this.container = container;
        this.normalMarker = normalMarker;

        this.container.innerHTML = `
            <div class="normal-list-panel">
                <h2 class="normal-list-title">Normal Points (<span id="normalPointCount">0</span>)</h2>
                <p class="normal-list-hint">Select ≥3 points, then Compute</p>
                <div id="normalPointsList" class="normal-list-items"></div>
                <button id="computePCABtn" class="normal-compute-btn">Compute PCA Normal</button>
                <div id="normalResult" class="normal-result"></div>
            </div>
        `;

        this.pointCountElement = this.container.querySelector('#normalPointCount')!;
        this.listElement = this.container.querySelector('#normalPointsList')!;
        this.resultElement = this.container.querySelector('#normalResult')!;

        const computeBtn = this.container.querySelector('#computePCABtn') as HTMLButtonElement;
        computeBtn.addEventListener('click', () => {
            this.onComputeClick?.();
        });

        normalMarker.onPointsChanged = () => this.updateList();

        this.injectStyles();
    }

    private injectStyles(): void {
        const styleId = 'normal-list-ui-styles';
        if (document.getElementById(styleId)) return;

        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            .normal-list-panel {
                padding: 12px 16px;
                background: rgba(15, 23, 42, 0.95);
                border-left: 1px solid rgba(255,255,255,0.08);
                height: 100%;
                overflow-y: auto;
            }
            .normal-list-title {
                font-size: 20px;
                font-weight: 600;
                color: #e8e6e3;
                margin-bottom: 6px;
            }
            .normal-list-hint {
                font-size: 16px;
                color: #64748b;
                margin-bottom: 10px;
            }
            .normal-list-items {
                max-height: calc(100vh - 320px);
                overflow-y: auto;
                margin-bottom: 10px;
            }
            .normal-point-item {
                padding: 8px 10px;
                background: rgba(51, 65, 85, 0.5);
                border-radius: 8px;
                margin-bottom: 6px;
                font-size: 14px;
                display: flex;
                align-items: center;
                gap: 8px;
                transition: background 0.15s;
            }
            .normal-point-item:hover {
                background: rgba(51, 65, 85, 0.8);
            }
            .normal-color-dot {
                width: 10px;
                height: 10px;
                border-radius: 50%;
                background: #22c55e;
                flex-shrink: 0;
            }
            .normal-point-info {
                flex: 1;
                color: #94a3b8;
                font-family: ui-monospace, monospace;
                font-size: 13px;
            }
            .normal-delete-btn {
                background: transparent;
                border: none;
                color: #64748b;
                cursor: pointer;
                font-size: 20px;
                padding: 4px 8px;
                border-radius: 6px;
                transition: all 0.15s;
            }
            .normal-delete-btn:hover {
                color: #ef4444;
                background: rgba(239, 68, 68, 0.15);
            }
            .normal-compute-btn {
                width: 100%;
                padding: 10px 14px;
                background: #3b82f6;
                color: #fff;
                border: none;
                border-radius: 8px;
                font-size: 15px;
                font-weight: 500;
                cursor: pointer;
                transition: background 0.15s;
            }
            .normal-compute-btn:hover {
                background: #60a5fa;
            }
            .normal-result {
                margin-top: 10px;
                padding: 10px 12px;
                font-size: 14px;
                color: #94a3b8;
                background: rgba(51, 65, 85, 0.5);
                border-radius: 8px;
                display: none;
            }
            .normal-result strong { color: #60a5fa; }
            .normal-list-items::-webkit-scrollbar { width: 6px; }
            .normal-list-items::-webkit-scrollbar-thumb {
                background: rgba(100, 116, 139, 0.5);
                border-radius: 3px;
            }
        `;
        document.head.appendChild(style);
    }

    updateList(): void {
        const points = this.normalMarker.points;
        this.pointCountElement.textContent = points.length.toString();
        this.listElement.innerHTML = '';

        points.forEach((point, idx) => {
            const item = document.createElement('div');
            item.className = 'normal-point-item';

            const dot = document.createElement('div');
            dot.className = 'normal-color-dot';

            const info = document.createElement('div');
            info.className = 'normal-point-info';
            info.textContent = `(${point.position.x.toFixed(3)}, ${point.position.y.toFixed(3)}, ${point.position.z.toFixed(3)})`;

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'normal-delete-btn';
            deleteBtn.innerHTML = '&times;';
            deleteBtn.title = 'Delete this point';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                console.log('Normal delete clicked, idx:', idx, 'total points:', this.normalMarker.points.length);
                this.normalMarker.deletePointByIndex(idx);
            });

            item.appendChild(dot);
            item.appendChild(info);
            item.appendChild(deleteBtn);
            this.listElement.appendChild(item);
        });
    }

    showNormalResult(normal: { x: number; y: number; z: number }): void {
        this.resultElement.style.display = 'block';
        this.resultElement.innerHTML = `<strong>Normal:</strong> (${normal.x.toFixed(4)}, ${normal.y.toFixed(4)}, ${normal.z.toFixed(4)})`;
    }

    clearResult(): void {
        this.resultElement.style.display = 'none';
        this.resultElement.innerHTML = '';
    }

    destroy(): void {
        this.container.innerHTML = '';
    }
}
