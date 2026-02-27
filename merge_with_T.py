#!/usr/bin/env python3
"""用 point_cloud_transform.json 里的 T 把 point_cloud 变换后与 zero_leap 合并。"""
import json
import numpy as np
from match_point_clouds_correct import read_ply_points, write_ply_file, downsample_points

def apply_T(points, T):
    """points (N,3), T (4,4). 返回 (N,3)。"""
    pts = np.hstack([points, np.ones((len(points), 1))])  # (N,4)
    out = (np.array(T) @ pts.T).T  # (N,4)
    return out[:, :3]

def main():
    with open("point_cloud_transform.json") as f:
        data = json.load(f)
    T = data["T"]

    print("读取 point_cloud.ply ...")
    pc = read_ply_points("point_clou.ply")
    print("读取 zero_leap.ply ...")
    zl = read_ply_points("zero_leap.ply")

    print("用 T 变换 point_cloud -> zero_leap 坐标系 ...")
    pc_t = apply_T(pc, T)

    # 下采样再合并，便于查看
    n_max = 200000
    pc_ds = downsample_points(pc_t, n_max)
    zl_ds = downsample_points(zl, n_max)

    merged = np.vstack([pc_ds, zl_ds])
    colors = np.vstack([
        np.ones((len(pc_ds), 3)) * [0.0, 1.0, 0.0],  # 绿：变换后的 point_cloud
        np.ones((len(zl_ds), 3)) * [1.0, 0.0, 0.0],  # 红：zero_leap
    ])

    out_path = "merged_with_T.ply"
    write_ply_file(merged, colors, out_path, ascii_format=True)
    print(f"已保存: {out_path}  (绿=point_cloud变换后, 红=zero_leap)")

if __name__ == "__main__":
    main()
