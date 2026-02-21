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
        
        // Prevent wheel events from bubbling to canvas (which would trigger zoom)
        this.container.addEventListener('wheel', (e) => {
            e.stopPropagation();
        }, true);
        
        // Prevent mouse events from bubbling past container (bubble phase so children fire first)
        ['mousedown', 'mouseup', 'click', 'contextmenu'].forEach(eventType => {
            this.container.addEventListener(eventType, (e) => {
                e.stopPropagation();
            });
        });
        
        // Setup drag handlers
        this.setupDragHandlers();
        
        // Listen to point marker changes
        pointMarker.onPointsChanged = () => this.updateList();
        pointMarker.onHoverChanged = () => {
            this.updateMagnifyButtons();
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
                cursor: default;
                transition: background 0.2s, opacity 0.2s, transform 0.1s;
                position: relative;
            }
            .annotation-item .drag-handle {
                cursor: move;
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
            .magnify-btn {
                background: transparent;
                border: none;
                cursor: pointer;
                font-size: 0.85rem;
                padding: 0.2rem 0.35rem;
                border-radius: 4px;
                transition: all 0.2s;
                opacity: 0.5;
                user-select: none;
                -webkit-user-select: none;
            }
            .magnify-btn:hover {
                opacity: 1;
                background: rgba(255, 255, 255, 0.1);
            }
            .magnify-btn.active {
                opacity: 1;
                background: rgba(0, 122, 204, 0.3);
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
                position: relative;
                z-index: 10;
                pointer-events: auto;
                user-select: none;
                -webkit-user-select: none;
            }
            .delete-btn:hover {
                color: #f44336;
                background: rgba(244, 67, 54, 0.1);
                opacity: 1;
            }
            .delete-btn:active {
                transform: scale(0.95);
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
            item.draggable = false; // Disable default dragging, we'll handle it manually
            item.dataset.index = idx.toString();
            
            // Get color
            const pointColor = this.pointMarker.getPointColor(point.colorId);
            const colorCSS = this.pointMarker.colorToCSS(pointColor);
            
            item.innerHTML = `
                <div class="drag-handle" title="Drag to reorder" draggable="true">⋮⋮</div>
                <div class="color-indicator" style="background-color: ${colorCSS};"></div>
                <div class="annotation-item-content">
                    <div class="point-info">
                        (${point.position.x.toFixed(3)}, ${point.position.y.toFixed(3)}, ${point.position.z.toFixed(3)})
                    </div>
                </div>
            `;
            
            // Get drag handle element after innerHTML
            const dragHandle = item.querySelector('.drag-handle') as HTMLElement;
            
            // Create delete button (after innerHTML to avoid being removed)
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'delete-btn';
            deleteBtn.innerHTML = '×';
            deleteBtn.title = 'Delete this point';
            deleteBtn.type = 'button'; // Prevent form submission
            deleteBtn.style.userSelect = 'none';
            deleteBtn.style.webkitUserSelect = 'none';
            
            // Store index on button for reliable access
            deleteBtn.dataset.pointIndex = idx.toString();
            
            // Handle click with capture phase to ensure it fires first
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.stopImmediatePropagation();
                e.preventDefault();
                const pointIndex = parseInt(deleteBtn.dataset.pointIndex || idx.toString(), 10);
                if (pointIndex >= 0 && pointIndex < this.pointMarker.selectedPoints.length) {
                    this.pointMarker.deletePointByIndex(pointIndex);
                }
                return false;
            }, true); // Capture phase
            
            // Prevent all drag-related events on delete button
            ['mousedown', 'mouseup', 'dragstart', 'drag', 'dragend'].forEach(eventType => {
                deleteBtn.addEventListener(eventType, (e) => {
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    if (eventType === 'dragstart' || eventType === 'drag') {
                        e.preventDefault();
                        return false;
                    }
                }, true);
            });
            
            // Prevent wheel events on delete button (zoom interference)
            deleteBtn.addEventListener('wheel', (e) => {
                e.stopPropagation();
                e.stopImmediatePropagation();
                e.preventDefault();
                return false;
            }, true);
            
            // Also prevent context menu on delete button
            deleteBtn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                return false;
            });
            
            // Create magnify toggle button
            const magnifyBtn = document.createElement('button');
            magnifyBtn.className = 'magnify-btn';
            magnifyBtn.innerHTML = '🔍';
            magnifyBtn.title = 'Toggle enlarge sphere';
            magnifyBtn.type = 'button';
            magnifyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const isActive = this.pointMarker.hoveredListItemIndex === idx;
                this.pointMarker.setHoveredListItem(isActive ? null : idx);
                this.updateMagnifyButtons();
            });
            ['mousedown', 'dragstart'].forEach(evt => {
                magnifyBtn.addEventListener(evt, (e) => { e.stopPropagation(); }, true);
            });

            item.appendChild(magnifyBtn);
            item.appendChild(deleteBtn);
            
            // Drag event listeners - only on drag handle
            if (dragHandle) {
                dragHandle.addEventListener('dragstart', (e) => {
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
            }
            
            if (dragHandle) {
                dragHandle.addEventListener('dragend', () => {
                    item.classList.remove('dragging');
                    document.querySelectorAll('.annotation-item').forEach(el => {
                        el.classList.remove('drag-over');
                    });
                    this.draggedItemIndex = null;
                    this.draggedOverItemIndex = null;
                });
            }
            
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

    private updateMagnifyButtons(): void {
        const buttons = this.listElement.querySelectorAll('.magnify-btn');
        buttons.forEach((btn, idx) => {
            if (this.pointMarker.hoveredListItemIndex === idx) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }

    destroy(): void {
        this.container.innerHTML = '';
    }
}


