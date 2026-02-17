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
            <div style="padding: 1rem; background: #252525; border-left: 1px solid #404040; height: 100%; overflow-y: auto;">
                <h2 style="font-size: 1.1rem; margin-bottom: 0.5rem; color: #fff;">
                    Normal Direction Points (<span id="normalPointCount">0</span>)
                </h2>
                <div style="font-size: 0.8rem; color: #888; margin-bottom: 0.75rem;">
                    Select at least 3 points, then click Compute
                </div>
                <div id="normalPointsList" style="max-height: calc(100vh - 350px); overflow-y: auto; margin-bottom: 0.75rem;"></div>
                <button id="computePCABtn" style="
                    width: 100%;
                    padding: 8px 12px;
                    background: #007acc;
                    color: #fff;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 0.9rem;
                    margin-bottom: 0.75rem;
                    transition: background 0.2s;
                ">Compute PCA Normal</button>
                <div id="normalResult" style="font-size: 0.85rem; color: #ccc; padding: 0.5rem; background: #1a1a1a; border-radius: 4px; display: none;"></div>
            </div>
        `;

        this.pointCountElement = this.container.querySelector('#normalPointCount')!;
        this.listElement = this.container.querySelector('#normalPointsList')!;
        this.resultElement = this.container.querySelector('#normalResult')!;

        const computeBtn = this.container.querySelector('#computePCABtn') as HTMLButtonElement;
        computeBtn.addEventListener('mouseenter', () => {
            computeBtn.style.background = '#005f99';
        });
        computeBtn.addEventListener('mouseleave', () => {
            computeBtn.style.background = '#007acc';
        });
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
            .normal-point-item {
                padding: 0.5rem;
                background: #1a1a1a;
                border-radius: 4px;
                margin-bottom: 0.5rem;
                font-size: 0.85rem;
                display: flex;
                align-items: center;
                gap: 0.5rem;
                transition: background 0.2s;
            }
            .normal-point-item:hover {
                background: #2a2a2a;
            }
            .normal-color-dot {
                width: 12px;
                height: 12px;
                border-radius: 50%;
                background: #00ff00;
                flex-shrink: 0;
            }
            .normal-point-info {
                flex: 1;
                color: #999;
            }
            .normal-delete-btn {
                background: transparent;
                border: none;
                color: #999;
                cursor: pointer;
                font-size: 1.2rem;
                padding: 0.25rem 0.5rem;
                border-radius: 4px;
                transition: all 0.2s;
                opacity: 1;
                min-width: 28px;
                min-height: 28px;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .normal-delete-btn:hover {
                color: #f44336;
                background: rgba(244, 67, 54, 0.1);
            }
            #normalPointsList::-webkit-scrollbar {
                width: 6px;
            }
            #normalPointsList::-webkit-scrollbar-track {
                background: #1a1a1a;
            }
            #normalPointsList::-webkit-scrollbar-thumb {
                background: #404040;
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
        this.resultElement.innerHTML = `<strong style="color:#4fc3f7;">Normal:</strong> (${normal.x.toFixed(4)}, ${normal.y.toFixed(4)}, ${normal.z.toFixed(4)})`;
    }

    clearResult(): void {
        this.resultElement.style.display = 'none';
        this.resultElement.innerHTML = '';
    }

    destroy(): void {
        this.container.innerHTML = '';
    }
}
