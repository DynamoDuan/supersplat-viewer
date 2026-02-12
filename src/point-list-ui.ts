import { PointMarker, type MarkedPoint } from './point-marker';

export class PointListUI {
    private container: HTMLElement;
    private listElement: HTMLElement;
    private pointCountElement: HTMLElement;
    private pointMarker: PointMarker;
    private draggedItemIndex: number | null = null;
    private draggedOverItemIndex: number | null = null;

    constructor(container: HTMLElement, pointMarker: PointMarker) {
        this.container = container;
        this.pointMarker = pointMarker;
        
        // Create UI structure
        this.container.innerHTML = `
            <div style="padding: 1rem; background: #252525; border-left: 1px solid #404040; height: 100%; overflow-y: auto;">
                <h2 style="font-size: 1.1rem; margin-bottom: 1rem; color: #fff;">
                    Selected Points (<span id="pointCount">0</span>)
                </h2>
                <div id="annotationsList" style="max-height: calc(100vh - 150px); overflow-y: auto;"></div>
            </div>
        `;
        
        this.pointCountElement = document.getElementById('pointCount')!;
        this.listElement = document.getElementById('annotationsList')!;
        
        // Setup drag handlers
        this.setupDragHandlers();
        
        // Listen to point marker changes
        pointMarker.onPointsChanged = () => this.updateList();
        pointMarker.onHoverChanged = (index) => {
            // Update hover state in UI
            this.updateList();
        };
        
        // Inject styles
        this.injectStyles();
    }

    private injectStyles(): void {
        const styleId = 'point-list-ui-styles';
        if (document.getElementById(styleId)) return;
        
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            .annotation-item {
                padding: 0.5rem;
                background: #1a1a1a;
                border-radius: 4px;
                margin-bottom: 0.5rem;
                font-size: 0.85rem;
                display: flex;
                align-items: center;
                gap: 0.5rem;
                cursor: move;
                transition: background 0.2s, opacity 0.2s, transform 0.1s;
                position: relative;
            }
            .annotation-item:hover {
                background: #2a2a2a;
            }
            .annotation-item.dragging {
                opacity: 0.8;
                background: #2a2a2a;
                transform: rotate(2deg);
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.5);
                z-index: 1000;
            }
            .annotation-item.drag-over {
                border-top: 2px solid #007acc;
                margin-top: 2px;
            }
            .annotation-item.drag-over::before {
                content: '';
                position: absolute;
                top: -2px;
                left: 0;
                right: 0;
                height: 2px;
                background: #007acc;
                box-shadow: 0 0 4px #007acc;
            }
            .drag-handle {
                cursor: grab;
                color: #666;
                font-size: 1rem;
                user-select: none;
                padding: 0.25rem;
                display: flex;
                align-items: center;
            }
            .drag-handle:active {
                cursor: grabbing;
            }
            .annotation-item:hover .drag-handle {
                color: #999;
            }
            .annotation-item-content {
                flex: 1;
                display: flex;
                align-items: center;
                gap: 0.5rem;
            }
            .color-indicator {
                width: 16px;
                height: 16px;
                border-radius: 50%;
                border: 2px solid #404040;
                flex-shrink: 0;
            }
            .annotation-item .point-info {
                color: #999;
            }
            .delete-btn {
                background: transparent;
                border: none;
                color: #999;
                cursor: pointer;
                font-size: 1rem;
                padding: 0.25rem 0.5rem;
                border-radius: 4px;
                transition: all 0.2s;
                opacity: 0.6;
            }
            .delete-btn:hover {
                color: #f44336;
                background: rgba(244, 67, 54, 0.1);
                opacity: 1;
            }
            .annotation-item:hover .delete-btn {
                opacity: 1;
            }
            #annotationsList::-webkit-scrollbar {
                width: 6px;
            }
            #annotationsList::-webkit-scrollbar-track {
                background: #1a1a1a;
            }
            #annotationsList::-webkit-scrollbar-thumb {
                background: #404040;
                border-radius: 3px;
            }
            #annotationsList::-webkit-scrollbar-thumb:hover {
                background: #505050;
            }
        `;
        document.head.appendChild(style);
    }

    private setupDragHandlers(): void {
        this.listElement.addEventListener('dragover', (e) => {
            if (this.draggedItemIndex === null) return;
            
            const mouseY = e.clientY;
            const lastItem = this.listElement.lastElementChild;
            
            if (lastItem) {
                const lastRect = lastItem.getBoundingClientRect();
                if (mouseY > lastRect.bottom) {
                    e.preventDefault();
                    (e as DragEvent).dataTransfer!.dropEffect = 'move';
                    this.draggedOverItemIndex = this.pointMarker.selectedPoints.length;
                    document.querySelectorAll('.annotation-item').forEach(el => {
                        el.classList.remove('drag-over');
                    });
                    return;
                }
            }
        });

        this.listElement.addEventListener('drop', (e) => {
            if (this.draggedItemIndex !== null && this.draggedOverItemIndex !== null && 
                this.draggedOverItemIndex === this.pointMarker.selectedPoints.length && 
                this.draggedItemIndex !== this.draggedOverItemIndex) {
                e.preventDefault();
                this.pointMarker.reorderPoints(this.draggedItemIndex, this.draggedOverItemIndex);
                this.draggedItemIndex = null;
                this.draggedOverItemIndex = null;
            }
        });
    }

    updateList(): void {
        const points = this.pointMarker.selectedPoints;
        this.pointCountElement.textContent = points.length.toString();
        this.listElement.innerHTML = '';

        points.forEach((point, idx) => {
            const item = document.createElement('div');
            item.className = 'annotation-item';
            item.draggable = true;
            item.dataset.index = idx.toString();
            
            // Create delete button
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'delete-btn';
            deleteBtn.innerHTML = '×';
            deleteBtn.title = 'Delete this point';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.pointMarker.deletePointByIndex(idx);
            });
            
            // Get color
            const pointColor = this.pointMarker.getPointColor(point.colorId);
            const colorCSS = this.pointMarker.colorToCSS(pointColor);
            
            item.innerHTML = `
                <div class="drag-handle" title="Drag to reorder">⋮⋮</div>
                <div class="color-indicator" style="background-color: ${colorCSS};"></div>
                <div class="annotation-item-content">
                    <div class="point-info">
                        (${point.position.x.toFixed(3)}, ${point.position.y.toFixed(3)}, ${point.position.z.toFixed(3)})
                    </div>
                </div>
            `;
            
            item.appendChild(deleteBtn);
            
            // Mouse hover events
            item.addEventListener('mouseenter', () => {
                if (this.draggedItemIndex !== null) return;
                this.pointMarker.setHoveredListItem(idx);
            });
            
            item.addEventListener('mouseleave', () => {
                if (this.draggedItemIndex !== null) return;
                this.pointMarker.setHoveredListItem(null);
            });
            
            // Drag event listeners
            item.addEventListener('dragstart', (e) => {
                this.draggedItemIndex = idx;
                item.classList.add('dragging');
                if (this.pointMarker.hoveredListItemIndex === idx) {
                    this.pointMarker.setHoveredListItem(null);
                }
                (e as DragEvent).dataTransfer!.effectAllowed = 'move';
                
                // Create custom drag image
                const dragImage = item.cloneNode(true) as HTMLElement;
                dragImage.style.position = 'absolute';
                dragImage.style.top = '-1000px';
                dragImage.style.width = item.offsetWidth + 'px';
                document.body.appendChild(dragImage);
                (e as DragEvent).dataTransfer!.setDragImage(dragImage, e.offsetX, e.offsetY);
                setTimeout(() => document.body.removeChild(dragImage), 0);
            });
            
            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
                document.querySelectorAll('.annotation-item').forEach(el => {
                    el.classList.remove('drag-over');
                });
                this.draggedItemIndex = null;
                this.draggedOverItemIndex = null;
            });
            
            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
                (e as DragEvent).dataTransfer!.dropEffect = 'move';
                
                if (this.draggedItemIndex === null || this.draggedItemIndex === idx) return;
                
                document.querySelectorAll('.annotation-item').forEach(el => {
                    el.classList.remove('drag-over');
                });
                
                const rect = item.getBoundingClientRect();
                const mouseY = e.clientY;
                const itemMiddle = rect.top + rect.height / 2;
                
                item.classList.add('drag-over');
                
                if (mouseY > itemMiddle) {
                    this.draggedOverItemIndex = idx + 1;
                } else {
                    this.draggedOverItemIndex = idx;
                }
            });
            
            item.addEventListener('drop', (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                if (this.draggedItemIndex !== null && this.draggedOverItemIndex !== null && 
                    this.draggedItemIndex !== this.draggedOverItemIndex) {
                    this.pointMarker.reorderPoints(this.draggedItemIndex, this.draggedOverItemIndex);
                }
                
                item.classList.remove('drag-over');
                this.draggedItemIndex = null;
                this.draggedOverItemIndex = null;
            });
            
            item.addEventListener('dragleave', (e) => {
                if (!item.contains(e.relatedTarget as Node)) {
                    item.classList.remove('drag-over');
                }
            });
            
            this.listElement.appendChild(item);
        });
    }

    destroy(): void {
        this.container.innerHTML = '';
    }
}


