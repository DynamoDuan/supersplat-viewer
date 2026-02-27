#!/usr/bin/env python3
"""
使用对应点匹配两个点云文件
1. 从 point_cloud.ply 中找到 point_cloud.json 中的点
2. 从 zero_leap.ply 中找到 zero_leap.json 中的点
3. 使用这些对应点计算 Umeyama 变换
4. 应用变换到完整的 point_cloud.ply
"""

import json
import numpy as np
import sys
import struct

# 添加 new_tool 路径
sys.path.insert(0, '/home/peiqiduan/new_tool')
from register_json_points import umeyama, apply_transformation

def read_ply_points(ply_path, max_points=None):
    """
    读取 PLY 文件中的点坐标
    返回: points (n, 3) numpy array
    """
    points = []
    
    with open(ply_path, 'rb') as f:
        # 读取头部
        header_lines = []
        is_ascii = False
        num_vertices = 0
        has_normals = False
        has_colors = False
        properties = []
        bytes_per_vertex = 12  # x, y, z (3 * float32)
        
        while True:
            line = f.readline()
            header_lines.append(line)
            
            if b'format ascii' in line:
                is_ascii = True
            elif b'format binary' in line:
                is_ascii = False
            elif b'element vertex' in line:
                num_vertices = int(line.split()[-1])
            elif b'property float nx' in line:
                has_normals = True
                bytes_per_vertex += 12  # nx, ny, nz
            elif b'property uchar red' in line or b'property uchar r' in line:
                has_colors = True
                bytes_per_vertex += 3  # r, g, b
        
            elif b'end_header' in line:
                break
        
        # 读取点数据
        if is_ascii:
            # ASCII 格式
            for i in range(num_vertices):
                if max_points and i >= max_points:
                    break
                line = f.readline().decode('utf-8').strip().split()
                x, y, z = float(line[0]), float(line[1]), float(line[2])
                points.append([x, y, z])
        else:
            # Binary 格式
            for i in range(num_vertices):
                if max_points and i >= max_points:
                    break
                # 读取 x, y, z (float32)
                x, y, z = struct.unpack('fff', f.read(12))
                points.append([x, y, z])
                
                # 跳过其他属性
                if has_normals:
                    f.read(12)  # nx, ny, nz
                if has_colors:
                    f.read(3)  # r, g, b
                # 跳过其他属性（高斯点云的其他属性）
                # 计算需要跳过的字节数
                remaining = bytes_per_vertex - 12 - (12 if has_normals else 0) - (3 if has_colors else 0)
                if remaining > 0:
                    f.read(remaining)
    
    return np.array(points, dtype=np.float64)

def ply_to_world(points):
    """
    将 PLY 模型空间坐标转换为 viewer 世界坐标。

    viewer 加载模型时对 gsplat entity 应用了 setLocalEulerAngles(0, 0, 180)，
    即绕 Z 轴旋转 180°，等价于 x = -x, y = -y, z = z。

    PLY 文件存储的是模型空间坐标，JSON 中选取的点是 viewer 世界坐标。
    所有 PLY 数据在参与匹配前都需要经过此转换。
    """
    # result = points.copy()
    # result[:, 0] = -result[:, 0]
    # result[:, 1] = -result[:, 1]
    return points


def find_closest_points_in_cloud(cloud_points, target_points, tolerance=0.1):
    """
    在点云中找到最接近目标点的点
    
    Args:
        cloud_points: (n, 3) 点云中的所有点
        target_points: (m, 3) 要查找的目标点
        tolerance: 容差
    
    Returns:
        indices: (m,) 找到的点在 cloud_points 中的索引，如果没找到则为 -1
        found_points: (m, 3) 找到的点坐标
    """
    indices = []
    found_points = []
    
    for target_pt in target_points:
        # 计算所有距离
        distances = np.linalg.norm(cloud_points - target_pt, axis=1)
        min_idx = np.argmin(distances)
        min_dist = distances[min_idx]
        
        if min_dist <= tolerance:
            indices.append(min_idx)
            found_points.append(cloud_points[min_idx])
        else:
            indices.append(-1)
            found_points.append(None)
            print(f"  警告: 未找到点 {target_pt}, 最近距离: {min_dist:.6f}")
    
    found_points = np.array([p for p in found_points if p is not None])
    return np.array(indices), found_points

def write_ply_file(points, colors, filename, ascii_format=True):
    """写入 PLY 文件"""
    n_points = len(points)
    
    with open(filename, 'w' if ascii_format else 'wb') as f:
        if ascii_format:
            f.write("ply\n")
            f.write("format ascii 1.0\n")
            f.write(f"element vertex {n_points}\n")
            f.write("property float x\n")
            f.write("property float y\n")
            f.write("property float z\n")
            if colors is not None:
                f.write("property uchar red\n")
                f.write("property uchar green\n")
                f.write("property uchar blue\n")
            f.write("end_header\n")
            
            for i in range(n_points):
                x, y, z = points[i]
                if colors is not None:
                    r, g, b = (colors[i] * 255).astype(np.uint8)
                    f.write(f"{x:.6f} {y:.6f} {z:.6f} {r} {g} {b}\n")
                else:
                    f.write(f"{x:.6f} {y:.6f} {z:.6f}\n")

def downsample_points(points, max_points=100000):
    """下采样点云"""
    if len(points) <= max_points:
        return points
    indices = np.linspace(0, len(points) - 1, max_points, dtype=int)
    return points[indices]

def main():
    print("=" * 60)
    print("使用对应点匹配两个点云文件")
    print("=" * 60)
    print()
    
    # 读取匹配映射
    print("读取匹配映射...")
    with open('match_mapping.json', 'r') as f:
        match_data = json.load(f)
    
    matches = match_data['matches']
    print(f"  匹配的点对数: {len(matches)}")
    
    # 提取对应点
    source_json_points = np.array([m['source_point'] for m in matches], dtype=np.float64)
    target_json_points = np.array([m['target_point'] for m in matches], dtype=np.float64)
    
    print(f"  源点 (point_cloud.json): {len(source_json_points)} 个点")
    print(f"  目标点 (zero_leap.json): {len(target_json_points)} 个点")
    print()
    
    # 读取完整点云
    print("读取 point_cloud.ply...")
    try:
        # 只读取部分点来查找对应点（加速）
        cloud1_sample = read_ply_points('point_cloud.ply', max_points=1000000)
        print(f"  读取点数: {len(cloud1_sample)}")
    except Exception as e:
        print(f"错误: 无法读取 point_cloud.ply: {e}")
        return
    
    print("读取 zero_leap.ply...")
    try:
        cloud2_sample_raw = read_ply_points('zero_leap.ply', max_points=1000000)
        print(f"  读取点数: {len(cloud2_sample_raw)}")
    except Exception as e:
        print(f"错误: 无法读取 zero_leap.ply: {e}")
        return

    # JSON 和 PLY 都是模型空间坐标
    # 统一做 -x, -y 转换到世界坐标系（viewer 的 entity 绕 Z 轴旋转了 180°）
    print()
    print("统一做 -x, -y 转换到世界坐标系...")
    source_json_points = ply_to_world(source_json_points)
    target_json_points = ply_to_world(target_json_points)
    cloud1_sample = ply_to_world(cloud1_sample)
    cloud2_sample = ply_to_world(cloud2_sample_raw)
    print("  JSON 和 PLY 数据均已转换")

    # 使用 JSON 对应点计算 Umeyama 变换
    print()
    print("使用 Umeyama 方法计算变换...")
    X = source_json_points.T
    Y = target_json_points.T
    c, R, t = umeyama(X, Y)
    t = t.flatten()

    print()
    print("=" * 60)
    print("变换参数:")
    print("=" * 60)
    print(f"旋转矩阵 R:")
    print(R)
    print(f"\n平移向量 T: {t}")
    print(f"缩放因子 s: {c}")

    # 验证变换
    transformed_X = apply_transformation(source_json_points, R, t, c)
    errors = np.linalg.norm(transformed_X - target_json_points, axis=1)
    rms = np.sqrt(np.mean(errors ** 2))
    print(f"\nRMS 误差: {rms:.6f}")
    print(f"  最小误差: {np.min(errors):.6f}")
    print(f"  最大误差: {np.max(errors):.6f}")
    print(f"  平均误差: {np.mean(errors):.6f}")

    # 读取完整点云，转换坐标，应用 Umeyama
    print()
    print("读取完整点云并应用变换...")
    print("  读取 point_cloud.ply (完整)...")
    full_cloud1 = read_ply_points('point_cloud.ply')
    print(f"  点数: {len(full_cloud1)}")
    full_cloud1 = ply_to_world(full_cloud1)

    print("  应用 Umeyama 变换...")
    transformed_cloud1 = apply_transformation(full_cloud1, R, t, c)
    
    # 保存结果
    print()
    print("保存结果...")
    
    # 1. 变换后的点云1（红色）- 下采样
    transformed_cloud1_ds = downsample_points(transformed_cloud1, 200000)
    red_colors = np.ones((len(transformed_cloud1_ds), 3)) * [1.0, 0.0, 0.0]
    write_ply_file(transformed_cloud1_ds, red_colors, 'point_cloud_transformed.ply', ascii_format=True)
    print("  已保存: point_cloud_transformed.ply (红色 - 变换后的 point_cloud.ply)")

    # 读取完整的 zero_leap.ply 并转换坐标
    print("  读取 zero_leap.ply (完整)...")
    full_cloud2 = read_ply_points('zero_leap.ply')
    print(f"  点数: {len(full_cloud2)}")
    full_cloud2 = ply_to_world(full_cloud2)

    # 2. 目标点云2（绿色）- 使用完整的已变换点云，下采样
    cloud2_ds = downsample_points(full_cloud2, 200000)
    green_colors = np.ones((len(cloud2_ds), 3)) * [0.0, 1.0, 0.0]
    write_ply_file(cloud2_ds, green_colors, 'zero_leap_colored.ply', ascii_format=True)
    print("  已保存: zero_leap_colored.ply (绿色 - zero_leap.ply, 已转换到 viewer 坐标系)")

    # 3. 合并点云（添加匹配点标记为小球）
    # 变换后的匹配点（黄色）- 使用变换后的源点
    transformed_matched_points = apply_transformation(source_json_points, R, t, c)

    # 在 zero_leap.ply (已变换) 中查找目标匹配点（使用最近的点）
    print("  在 zero_leap.ply (已变换) 中查找目标匹配点...")
    target_matched_points = []
    for target_pt in target_json_points:
        # 计算所有距离，找到最近的点
        distances = np.linalg.norm(full_cloud2 - target_pt, axis=1)
        min_idx = np.argmin(distances)
        closest_point = full_cloud2[min_idx]
        target_matched_points.append(closest_point)
        min_dist = distances[min_idx]
        if min_dist > 0.01:
            print(f"    警告: 点 {target_pt} 最近距离: {min_dist:.6f}")

    target_matched_points = np.array(target_matched_points, dtype=np.float64)
    print(f"  找到 {len(target_matched_points)} 个目标匹配点")
    
    # 生成小球形状的点云（在匹配点周围生成多个点）
    def create_sphere_points(center_points, radius=0.01, points_per_sphere=50):
        """在中心点周围生成小球形状的点"""
        sphere_points = []
        for center in center_points:
            # 生成球面上的点
            for i in range(points_per_sphere):
                # 使用球面坐标生成均匀分布的点
                theta = 2 * np.pi * np.random.random()  # 方位角
                phi = np.arccos(2 * np.random.random() - 1)  # 极角
                r = radius * np.random.random() ** (1/3)  # 半径（均匀分布在球体内）
                
                x = center[0] + r * np.sin(phi) * np.cos(theta)
                y = center[1] + r * np.sin(phi) * np.sin(theta)
                z = center[2] + r * np.cos(phi)
                sphere_points.append([x, y, z])
        return np.array(sphere_points, dtype=np.float64)
    
    # 为匹配点生成小球
    sphere_radius = 0.01  # 小球半径
    points_per_sphere = 50  # 每个小球包含的点数
    transformed_sphere_points = create_sphere_points(transformed_matched_points, sphere_radius, points_per_sphere)
    target_sphere_points = create_sphere_points(target_matched_points, sphere_radius, points_per_sphere)
    
    # 合并：变换后的点云1（绿色）+ 目标点云2（红色）+ 匹配点小球（黄色和蓝色）
    # 注意：所有数据现在都在同一个坐标系（viewer 世界坐标系）中
    merged_points = np.vstack([
        transformed_cloud1_ds,      # 变换后的 point_cloud（绿色）
        cloud2_ds,                  # zero_leap（红色，已转换到 viewer 坐标系）
        transformed_sphere_points,  # 变换后的匹配点小球（黄色）
        target_sphere_points        # 目标匹配点小球（蓝色）
    ])
    merged_colors = np.vstack([
        np.ones((len(transformed_cloud1_ds), 3)) * [0.0, 1.0, 0.0],  # 绿色：变换后的 point_cloud
        np.ones((len(cloud2_ds), 3)) * [1.0, 0.0, 0.0],              # 红色：zero_leap
        np.ones((len(transformed_sphere_points), 3)) * [1.0, 1.0, 0.0],  # 黄色：变换后的匹配点小球
        np.ones((len(target_sphere_points), 3)) * [0.0, 0.0, 1.0]   # 蓝色：目标匹配点小球
    ])
    write_ply_file(merged_points, merged_colors, 'point_clouds_merged.ply', ascii_format=True)
    print("  已保存: point_clouds_merged.ply")
    print("    绿色=变换后的point_cloud, 红色=zero_leap (viewer坐标系)")
    print(f"    黄色=变换后的匹配点小球({len(transformed_sphere_points)}个点), 蓝色=目标匹配点小球({len(target_sphere_points)}个点)")
    print("    所有数据均在 viewer 世界坐标系中")
    
    # 4. 保存变换参数
    transform_result = {
        'method': 'Umeyama (using corresponding points)',
        'rotation': R.tolist(),
        'translation': t.tolist(),
        'scale': float(c),
        'num_correspondences': len(matches),
        'rms_error': float(rms) if 'rms' in locals() else None
    }
    
    with open('point_cloud_transform.json', 'w') as f:
        json.dump(transform_result, f, indent=2)
    print("  已保存: point_cloud_transform.json (变换参数)")
    
    print()
    print("=" * 60)
    print("完成！")
    print("=" * 60)

if __name__ == '__main__':
    main()

