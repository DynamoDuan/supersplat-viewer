#!/usr/bin/env python3
"""
3D 重建/生成质量评估：体素 IoU

- 输入：两个点云 .ply（预测/源、真值/目标），先体素化再算 IoU
- IoU ∈ [0, 1]，越接近 1 表示两片点云越一致
"""

import argparse
import numpy as np


def voxel_iou(pred_voxels, gt_voxels):
    """
    体素 IoU = intersection / union

    Args:
        pred_voxels: 布尔数组，预测的体素占用 (True=占用)
        gt_voxels: 布尔数组，真实的体素占用

    Returns:
        float: IoU 值，union 为 0 时返回 0
    """
    pred_voxels = np.asarray(pred_voxels, dtype=bool)
    gt_voxels = np.asarray(gt_voxels, dtype=bool)
    if pred_voxels.shape != gt_voxels.shape:
        raise ValueError(
            f"Shape mismatch: pred {pred_voxels.shape} vs gt {gt_voxels.shape}. "
            "Use same resolution and world bounds when voxelizing."
        )
    intersection = np.logical_and(pred_voxels, gt_voxels).sum()
    union = np.logical_or(pred_voxels, gt_voxels).sum()
    return float(intersection / union) if union > 0 else 0.0


def voxel_precision_recall(pred_voxels, gt_voxels):
    """体素精确率与召回率（可选指标）"""
    pred_voxels = np.asarray(pred_voxels, dtype=bool)
    gt_voxels = np.asarray(gt_voxels, dtype=bool)
    intersection = np.logical_and(pred_voxels, gt_voxels).sum()
    pred_sum = pred_voxels.sum()
    gt_sum = gt_voxels.sum()
    precision = intersection / pred_sum if pred_sum > 0 else 0.0
    recall = intersection / gt_sum if gt_sum > 0 else 0.0
    return float(precision), float(recall)


def points_to_voxels(points, resolution=64, xyz_min=None, xyz_max=None):
    """
    将点云 (N, 3) 体素化到 resolution^3 网格。

    Args:
        points: (N, 3) 浮点坐标
        resolution: 每个维度的体素数量
        xyz_min: (3,) 世界范围下界，None 则用 points 的 min
        xyz_max: (3,) 世界范围上界，None 则用 points 的 max

    Returns:
        voxels: (res, res, res) 布尔数组
    """
    points = np.asarray(points, dtype=np.float64)
    if points.ndim != 2 or points.shape[1] != 3:
        raise ValueError("points must be (N, 3)")
    if xyz_min is None:
        xyz_min = points.min(axis=0)
    if xyz_max is None:
        xyz_max = points.max(axis=0)
    xyz_min = np.asarray(xyz_min, dtype=np.float64).reshape(3)
    xyz_max = np.asarray(xyz_max, dtype=np.float64).reshape(3)
    # 避免除零
    span = xyz_max - xyz_min
    span[span <= 0] = 1e-6
    # 归一化到 [0, resolution-1]，再取整
    indices = (points - xyz_min) / span * (resolution - 1e-5)
    indices = indices.astype(np.int32)
    indices = np.clip(indices, 0, resolution - 1)
    voxels = np.zeros((resolution, resolution, resolution), dtype=bool)
    voxels[indices[:, 0], indices[:, 1], indices[:, 2]] = True
    return voxels


def load_ply_points_simple(ply_path, max_points=None):
    """从 PLY 只读 x,y,z，兼容 ascii 和 binary。"""
    import struct
    points = []
    with open(ply_path, "rb") as f:
        is_ascii = False
        num_vertices = 0
        bytes_per_vertex = 12
        while True:
            line = f.readline()
            if b"format ascii" in line:
                is_ascii = True
            elif b"element vertex" in line:
                num_vertices = int(line.split()[-1])
            elif b"property float x" in line or b"property float y" in line:
                pass  # x,y,z 共 12 字节已包含
            elif b"property float nx" in line:
                bytes_per_vertex += 12
            elif b"property uchar red" in line or b"property uchar r" in line:
                bytes_per_vertex += 3
            elif b"end_header" in line:
                break
        if is_ascii:
            for i in range(num_vertices):
                if max_points and len(points) >= max_points:
                    break
                parts = f.readline().decode("utf-8").strip().split()
                if len(parts) >= 3:
                    points.append([float(parts[0]), float(parts[1]), float(parts[2])])
        else:
            for i in range(num_vertices):
                if max_points and len(points) >= max_points:
                    break
                x, y, z = struct.unpack("fff", f.read(12))
                points.append([x, y, z])
                if bytes_per_vertex > 12:
                    f.read(bytes_per_vertex - 12)
    return np.array(points, dtype=np.float64)


def load_points(path):
    """加载点云，支持 .ply；.npy 按体素处理由调用方判断。"""
    if path.endswith(".ply"):
        return load_ply_points_simple(path)
    raise ValueError(f"仅支持 .ply 点云，当前: {path}")


def main():
    parser = argparse.ArgumentParser(description="体素 IoU 评估：输入两个点云，体素化后计算 IoU")
    parser.add_argument("pred", help="预测/源点云 .ply")
    parser.add_argument("gt", help="真值/目标点云 .ply")
    parser.add_argument("--resolution", type=int, default=64, help="体素化分辨率 (默认 64)")
    parser.add_argument("--shared_bounds", action="store_true", default=True, help="用两片点云的并集范围体素化（默认开启）")
    parser.add_argument("--no_shared_bounds", action="store_false", dest="shared_bounds", help="关闭 shared_bounds")
    args = parser.parse_args()

    pred_pts = load_points(args.pred)
    gt_pts = load_points(args.gt)
    print(f"预测点云: {pred_pts.shape[0]} 点  ({args.pred})")
    print(f"真值点云: {gt_pts.shape[0]} 点  ({args.gt})")

    if args.shared_bounds:
        xyz_min = np.minimum(pred_pts.min(axis=0), gt_pts.min(axis=0))
        xyz_max = np.maximum(pred_pts.max(axis=0), gt_pts.max(axis=0))
        pred_voxels = points_to_voxels(pred_pts, args.resolution, xyz_min, xyz_max)
        gt_voxels = points_to_voxels(gt_pts, args.resolution, xyz_min, xyz_max)
    else:
        xyz_min = pred_pts.min(axis=0)
        xyz_max = pred_pts.max(axis=0)
        pred_voxels = points_to_voxels(pred_pts, args.resolution)
        gt_voxels = points_to_voxels(gt_pts, args.resolution, xyz_min, xyz_max)

    iou = voxel_iou(pred_voxels, gt_voxels)
    precision, recall = voxel_precision_recall(pred_voxels, gt_voxels)
    print(f"体素 IoU:       {iou:.4f}  (越接近 1 越好)")
    print(f"体素 Precision:  {precision:.4f}")
    print(f"体素 Recall:     {recall:.4f}")


if __name__ == "__main__":
    main()
