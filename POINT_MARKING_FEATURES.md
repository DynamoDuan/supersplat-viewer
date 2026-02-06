# 标记点功能清单 (Point Marking Features)

基于 `new_tool/annotation.html` 的标记点功能整理

## 核心功能

### 1. 点选择系统
- [x] 射线-点距离计算（已实现，picker.ts）
- [x] 鼠标点击选择点（已实现，viewer.ts）
- [x] 点高亮显示（已实现，centers-overlay.ts）
- [ ] **点数据结构**：存储选中点的信息
  ```typescript
  interface MarkedPoint {
    index: number;        // 点在点云中的索引
    position: Vec3;       // 世界坐标位置
    colorId: number;      // 固定颜色ID（0-19）
    originalColor: Color; // 原始颜色
  }
  ```

### 2. 颜色系统
- [ ] **固定颜色ID**：每个点分配固定的颜色ID（0-19），颜色永不改变
- [ ] **预计算颜色**：20种高对比度颜色（HSL色彩空间）
- [ ] **颜色应用到点**：根据colorId给点着色
- [ ] **颜色应用到球体**：球体标记使用相同颜色

### 3. 球体标记可视化
- [ ] **创建球体**：为每个选中的点创建3D球体标记
- [ ] **更新球体**：位置、颜色、大小同步更新
- [ ] **删除球体**：删除点时移除对应球体
- [ ] **悬停放大**：鼠标悬停在列表项时，对应球体放大2倍

### 4. 点列表UI
- [ ] **列表容器**：显示所有选中点的列表
- [ ] **列表项**：每个点显示为一行
  - 拖拽手柄（⋮⋮）
  - 颜色指示器（圆形）
  - 坐标信息 (x, y, z)
  - 删除按钮（×）
- [ ] **拖拽排序**：支持拖拽重新排序点
- [ ] **悬停效果**：鼠标悬停时高亮，对应球体放大

### 5. 点管理操作
- [ ] **选择点**：`selectPoint(index)` - 添加点到列表
- [ ] **删除单个点**：`deletePointByIndex(arrayIndex)` - 删除指定点
- [ ] **删除最后点**：`deleteLastPoint()` - 删除最后一个点
- [ ] **清空所有**：`clearAllAnnotations()` - 清空所有标记
- [ ] **重新排序**：`reorderPoints(fromIndex, toIndex)` - 拖拽排序

### 6. JSON 保存/加载
- [ ] **保存JSON**：`saveAsJSON()` - 保存为 `[[x,y,z], ...]` 格式
- [ ] **加载JSON**：`loadJSONFile(file)` - 从文件加载标注
- [ ] **URL加载**：支持从URL参数加载JSON文件
- [ ] **坐标匹配**：加载时通过坐标匹配找到对应的点（容差0.001）

### 7. 状态管理
- [ ] **selectedPoints数组**：存储所有选中的点
- [ ] **nextColorId计数器**：下一个要分配的颜色ID
- [ ] **pointSpheres Map**：colorId -> 球体对象的映射
- [ ] **hoveredListItemIndex**：当前悬停的列表项索引

## 实现步骤

### Step 1: 创建点标记管理器类
创建 `src/point-marker.ts`：
- 管理选中点列表
- 处理点的增删改查
- 管理颜色系统
- 管理球体标记

### Step 2: 创建UI组件
创建 `src/point-list-ui.ts`：
- 渲染点列表
- 处理拖拽排序
- 处理删除操作
- 处理悬停效果

### Step 3: 集成到viewer
在 `viewer.ts` 中：
- 初始化点标记管理器
- 连接点击事件到选择功能
- 连接UI到数据

### Step 4: 添加JSON功能
- 实现保存JSON
- 实现加载JSON
- 添加文件上传UI

## 数据结构

```typescript
// 标记点数据结构
interface MarkedPoint {
  index: number;           // 点在点云中的索引
  position: Vec3;          // 世界坐标位置
  colorId: number;         // 固定颜色ID (0-19)
  originalColor: Color;    // 原始颜色
}

// 状态
let selectedPoints: MarkedPoint[] = [];
let nextColorId = 0;
let pointSpheres = new Map<number, Mesh>(); // colorId -> sphere
let hoveredListItemIndex: number | null = null;
```

## UI布局

```
┌─────────────────────────────────────────┐
│  Header: [Save JSON] [Delete Last]     │
├──────────┬──────────────────┬───────────┤
│          │                  │           │
│ Controls │   3D Canvas      │ Point List│
│          │                  │           │
│ - Upload │                  │ Point 1   │
│ - Mode   │                  │ Point 2   │
│ - Size   │                  │ Point 3   │
│          │                  │ ...       │
└──────────┴──────────────────┴───────────┘
```

## 关键函数签名

```typescript
// 选择点
function selectPoint(index: number): void

// 删除点
function deletePointByIndex(arrayIndex: number): void
function deleteLastPoint(): void
function clearAllAnnotations(): void

// 颜色管理
function getPointColor(colorId: number): Color
function applyColorToPoint(pointIndex: number, colorId: number): void

// 球体管理
function createOrUpdateSphere(colorId: number, updateSize?: boolean, hoverSize?: boolean): void
function removeSphere(colorId: number): void
function removeAllSpheres(): void

// 列表管理
function updateAnnotationsList(): void
function reorderPoints(fromIndex: number, toIndex: number): void

// JSON操作
function saveAsJSON(): Promise<void>
function loadJSONFile(file: File): void
function loadJSONFromURL(url: string): Promise<void>
```

## 参考实现

参考文件：`/home/peiqiduan/new_tool/annotation.html`
- 行 1220-1284: selectPoint 函数
- 行 1298-1351: deletePointByIndex 函数
- 行 1388-1446: saveAsJSON 函数
- 行 1448-1531: loadJSONFile 函数
- 行 1584-1760: updateAnnotationsList 函数
- 行 1537-1582: reorderPoints 函数

