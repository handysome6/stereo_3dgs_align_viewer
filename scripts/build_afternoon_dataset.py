#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path

import numpy as np


TYPE_MAP = {
    "char": "i1",
    "uchar": "u1",
    "short": "<i2",
    "ushort": "<u2",
    "int": "<i4",
    "uint": "<u4",
    "float": "<f4",
    "double": "<f8",
}


@dataclass(frozen=True)
class PlyHeader:
    vertex_count: int
    properties: list[tuple[str, str]]
    offset: int
    data_format: str


def parse_ply_header(path: Path) -> PlyHeader:
    with path.open("rb") as handle:
        offset = 0
        vertex_count = 0
        properties: list[tuple[str, str]] = []
        data_format = ""
        in_vertex = False

        while True:
            line = handle.readline()
            if not line:
                raise ValueError(f"Incomplete PLY header: {path}")
            offset += len(line)
            text = line.decode("ascii", errors="replace").strip()
            parts = text.split()

            if text == "end_header":
                break
            if len(parts) >= 2 and parts[0] == "format":
                data_format = parts[1]
            elif len(parts) >= 3 and parts[0] == "element":
                in_vertex = parts[1] == "vertex"
                if in_vertex:
                    vertex_count = int(parts[2])
            elif in_vertex and len(parts) >= 3 and parts[0] == "property":
                properties.append((parts[1], parts[2]))

    if data_format != "binary_little_endian":
        raise ValueError(f"Only binary_little_endian PLY is supported: {path}")
    if vertex_count <= 0:
        raise ValueError(f"PLY has no vertices: {path}")
    return PlyHeader(vertex_count, properties, offset, data_format)


def ply_dtype(header: PlyHeader) -> np.dtype:
    return np.dtype([(name, TYPE_MAP[prop_type]) for prop_type, name in header.properties])


def read_ply_memmap(path: Path) -> tuple[np.memmap, PlyHeader]:
    header = parse_ply_header(path)
    dtype = ply_dtype(header)
    names = dtype.names or ()
    for required in ("x", "y", "z"):
        if required not in names:
            raise ValueError(f"PLY lacks {required}: {path}")
    data = np.memmap(path, dtype=dtype, mode="r", offset=header.offset, shape=(header.vertex_count,))
    return data, header


def quaternion_wxyz_to_matrix(q: list[float]) -> np.ndarray:
    w, x, y, z = (float(value) for value in q)
    norm = (w * w + x * x + y * y + z * z) ** 0.5
    if norm == 0:
        raise ValueError("Zero-length quaternion")
    w, x, y, z = w / norm, x / norm, y / norm, z / norm
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ],
        dtype=np.float64,
    )


def camera_to_world(points: np.ndarray, position: list[float], quaternion_wxyz_c2w: list[float]) -> np.ndarray:
    rotation = quaternion_wxyz_to_matrix(quaternion_wxyz_c2w)
    translation = np.asarray(position, dtype=np.float64)
    return points @ rotation.T + translation


def point_bounds(points: np.ndarray) -> dict[str, list[float]]:
    points32 = points.astype(np.float32, copy=False)
    return {
        "min": points32.min(axis=0).astype(float).tolist(),
        "max": points32.max(axis=0).astype(float).tolist(),
    }


def camera_frustum_points(
    position: list[float],
    quaternion_wxyz_c2w: list[float],
    intrinsics: dict[str, float],
    depth: float,
) -> list[list[float]]:
    width = float(intrinsics["width"])
    height = float(intrinsics["height"])
    fx = float(intrinsics["fx"])
    fy = float(intrinsics["fy"])
    cx = float(intrinsics["cx"])
    cy = float(intrinsics["cy"])

    # Stereo/OpenCV camera coordinates: +X right, +Y down, +Z from sensor toward scene.
    corners = np.array(
        [
            [0.0, 0.0, depth],
            [((0.0 - cx) / fx) * depth, ((0.0 - cy) / fy) * depth, depth],
            [((width - cx) / fx) * depth, ((0.0 - cy) / fy) * depth, depth],
            [((width - cx) / fx) * depth, ((height - cy) / fy) * depth, depth],
            [((0.0 - cx) / fx) * depth, ((height - cy) / fy) * depth, depth],
        ],
        dtype=np.float64,
    )
    world = camera_to_world(corners, position, quaternion_wxyz_c2w)
    origin = np.asarray(position, dtype=np.float64)
    return [origin.tolist(), *world[1:].tolist()]


def sample_indices(count: int, max_points: int) -> np.ndarray:
    if count <= max_points:
        return np.arange(count, dtype=np.int64)
    return np.linspace(0, count - 1, max_points, dtype=np.int64)


def stable_seed(text: str) -> int:
    digest = hashlib.blake2s(text.encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, byteorder="little", signed=False)


def sample_random_indices(indices: np.ndarray, max_points: int, seed: int) -> np.ndarray:
    if len(indices) <= max_points:
        return indices
    rng = np.random.default_rng(seed)
    sampled = rng.choice(indices, size=max_points, replace=False)
    sampled.sort()
    return sampled


def sample_stratified_image_indices(
    indices: np.ndarray,
    header: PlyHeader,
    intrinsics: dict[str, float],
    max_points: int,
    seed: int,
) -> np.ndarray:
    width = int(intrinsics["width"])
    height = int(intrinsics["height"])
    if header.vertex_count != width * height or len(indices) <= max_points:
        return sample_random_indices(indices, max_points, seed)

    tile_size = max(1, int(np.floor(np.sqrt(header.vertex_count / max_points))))
    tile_columns = int(np.ceil(width / tile_size))
    x = indices % width
    y = indices // width
    tile_ids = (y // tile_size) * tile_columns + (x // tile_size)

    rng = np.random.default_rng(seed)
    priorities = rng.random(len(indices), dtype=np.float32)
    tile_count = int(tile_ids.max()) + 1
    best_priorities = np.full(tile_count, np.inf, dtype=np.float32)
    np.minimum.at(best_priorities, tile_ids, priorities)
    sampled = indices[priorities == best_priorities[tile_ids]]

    if len(sampled) > max_points:
        sampled = rng.choice(sampled, size=max_points, replace=False)
    elif len(sampled) < max_points:
        remaining = indices[~np.isin(indices, sampled, assume_unique=False)]
        fill_count = min(max_points - len(sampled), len(remaining))
        if fill_count:
            sampled = np.concatenate([sampled, rng.choice(remaining, size=fill_count, replace=False)])

    sampled.sort()
    return sampled


def voxel_representative_indices(data: np.memmap, indices: np.ndarray, voxel_size: float, seed: int) -> np.ndarray:
    if voxel_size <= 0:
        raise ValueError("--cloud-voxel-size must be greater than 0")

    x = np.asarray(data["x"][indices], dtype=np.float32)
    y = np.asarray(data["y"][indices], dtype=np.float32)
    z = np.asarray(data["z"][indices], dtype=np.float32)
    min_x = float(x.min())
    min_y = float(y.min())
    min_z = float(z.min())

    qx = np.floor((x - min_x) / voxel_size).astype(np.int32)
    qy = np.floor((y - min_y) / voxel_size).astype(np.int32)
    qz = np.floor((z - min_z) / voxel_size).astype(np.int32)
    dim_y = int(qy.max()) + 1
    dim_z = int(qz.max()) + 1
    voxel_keys = (qx.astype(np.int64) * dim_y + qy.astype(np.int64)) * dim_z + qz.astype(np.int64)

    unique_keys, inverse = np.unique(voxel_keys, return_inverse=True)
    rng = np.random.default_rng(seed)
    priorities = rng.random(len(indices), dtype=np.float32)
    best_priorities = np.full(len(unique_keys), np.inf, dtype=np.float32)
    np.minimum.at(best_priorities, inverse, priorities)
    sampled = indices[priorities == best_priorities[inverse]]
    sampled.sort()
    return sampled


def sample_voxel_indices(
    data: np.memmap,
    indices: np.ndarray,
    header: PlyHeader,
    intrinsics: dict[str, float],
    max_points: int,
    voxel_size: float,
    seed: int,
) -> np.ndarray:
    sampled = voxel_representative_indices(data, indices, voxel_size, seed)
    if len(sampled) <= max_points:
        return sampled
    return sample_stratified_image_indices(sampled, header, intrinsics, max_points, seed + 1)


def sample_hybrid_indices(
    data: np.memmap,
    indices: np.ndarray,
    header: PlyHeader,
    intrinsics: dict[str, float],
    max_points: int,
    voxel_size: float,
    seed: int,
) -> np.ndarray:
    voxel_sampled = voxel_representative_indices(data, indices, voxel_size, seed)
    if len(voxel_sampled) >= max_points:
        return sample_stratified_image_indices(voxel_sampled, header, intrinsics, max_points, seed + 1)

    stratified_sampled = sample_stratified_image_indices(indices, header, intrinsics, max_points, seed + 2)
    fill = stratified_sampled[~np.isin(stratified_sampled, voxel_sampled, assume_unique=False)]
    needed = max_points - len(voxel_sampled)
    if len(fill) > needed:
        rng = np.random.default_rng(seed + 3)
        fill = rng.choice(fill, size=needed, replace=False)
    sampled = np.concatenate([voxel_sampled, fill])

    if len(sampled) < max_points:
        remaining = np.setdiff1d(indices, sampled, assume_unique=False)
        extra = sample_random_indices(remaining, max_points - len(sampled), seed + 4)
        sampled = np.concatenate([sampled, extra])

    sampled.sort()
    return sampled


def sample_cloud_indices(
    data: np.memmap,
    indices: np.ndarray,
    header: PlyHeader,
    intrinsics: dict[str, float],
    max_points: int,
    seed: int,
    mode: str,
    voxel_size: float,
) -> np.ndarray:
    if mode == "linear":
        return indices[sample_indices(len(indices), max_points)]
    if mode == "random":
        return sample_random_indices(indices, max_points, seed)
    if mode == "stratified":
        return sample_stratified_image_indices(indices, header, intrinsics, max_points, seed)
    if mode == "voxel":
        return sample_voxel_indices(data, indices, header, intrinsics, max_points, voxel_size, seed)
    if mode == "hybrid":
        return sample_hybrid_indices(data, indices, header, intrinsics, max_points, voxel_size, seed)
    raise ValueError(f"Unsupported cloud sampling mode: {mode}")


def write_xyzrgb_binary_ply(path: Path, points: np.ndarray, colors: np.ndarray | None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if colors is None:
        colors = np.full((len(points), 3), 220, dtype=np.uint8)
    colors = colors.astype(np.uint8, copy=False)
    points = points.astype("<f4", copy=False)
    output = np.empty(
        len(points),
        dtype=np.dtype(
            [
                ("x", "<f4"),
                ("y", "<f4"),
                ("z", "<f4"),
                ("red", "u1"),
                ("green", "u1"),
                ("blue", "u1"),
            ]
        ),
    )
    output["x"] = points[:, 0]
    output["y"] = points[:, 1]
    output["z"] = points[:, 2]
    output["red"] = colors[:, 0]
    output["green"] = colors[:, 1]
    output["blue"] = colors[:, 2]
    header = (
        "ply\n"
        "format binary_little_endian 1.0\n"
        f"element vertex {len(points)}\n"
        "property float x\n"
        "property float y\n"
        "property float z\n"
        "property uchar red\n"
        "property uchar green\n"
        "property uchar blue\n"
        "end_header\n"
    )
    with path.open("wb") as handle:
        handle.write(header.encode("ascii"))
        output.tofile(handle)


def link_or_copy(source: Path, target: Path, copy: bool) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() or target.is_symlink():
        if target.is_symlink() and Path(os.readlink(target)) == source:
            return
        target.unlink()
    if copy:
        shutil.copy2(source, target)
    else:
        target.symlink_to(source)


def build_occlusion_proxy(splat_path: Path, output_path: Path, max_points: int) -> dict[str, object]:
    data, header = read_ply_memmap(splat_path)
    indices = sample_indices(header.vertex_count, max_points)
    points = np.column_stack([data["x"][indices], data["y"][indices], data["z"][indices]]).astype("<f4", copy=False)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    points.tofile(output_path)
    mins = points.min(axis=0).astype(float).tolist()
    maxs = points.max(axis=0).astype(float).tolist()
    return {
        "url": "/data/afternoon/occlusion_proxy.bin",
        "count": int(len(points)),
        "format": "float32-xyz",
        "bounds": {"min": mins, "max": maxs},
    }


def build_cloud_asset(
    source_path: Path,
    output_path: Path,
    position: list[float],
    quaternion_wxyz_c2w: list[float],
    intrinsics: dict[str, float],
    max_points: int,
    min_depth: float,
    sampling_mode: str,
    voxel_size: float,
) -> dict[str, object]:
    data, header = read_ply_memmap(source_path)
    z = np.asarray(data["z"])
    valid = np.flatnonzero(np.isfinite(z) & (z > min_depth))
    if len(valid) == 0:
        raise ValueError(f"No valid depth points in {source_path}")
    sampled = sample_cloud_indices(
        data,
        valid,
        header,
        intrinsics,
        max_points,
        stable_seed(source_path.parent.name),
        sampling_mode,
        voxel_size,
    )
    points_camera = np.column_stack([data["x"][sampled], data["y"][sampled], data["z"][sampled]]).astype(np.float64)
    points_world = camera_to_world(points_camera, position, quaternion_wxyz_c2w)

    names = [name for _, name in header.properties]
    colors = None
    if all(name in names for name in ("red", "green", "blue")):
        colors = np.column_stack([data["red"][sampled], data["green"][sampled], data["blue"][sampled]]).astype(np.uint8)

    write_xyzrgb_binary_ply(output_path, points_camera, colors)
    return {
        "count": int(len(points_camera)),
        "bounds": point_bounds(points_camera),
        "worldBounds": point_bounds(points_world),
        "samplingMode": sampling_mode,
        "voxelSize": voxel_size if sampling_mode in ("voxel", "hybrid") else None,
    }


def manifest_intrinsics(raw: dict[str, object]) -> dict[str, float]:
    intrinsics_by_id = raw.get("new_camera_intrinsics_refined", {})
    if not isinstance(intrinsics_by_id, dict) or not intrinsics_by_id:
        raise ValueError("Pose JSON lacks new_camera_intrinsics_refined")
    first = next(iter(intrinsics_by_id.values()))
    if not isinstance(first, dict):
        raise ValueError("Invalid intrinsics block")
    params = first["params"]
    return {
        "width": int(first["width"]),
        "height": int(first["height"]),
        "fx": float(params[0]),
        "fy": float(params[1]),
        "cx": float(params[2]),
        "cy": float(params[3]),
    }


def build_manifest(args: argparse.Namespace) -> dict[str, object]:
    afternoon_dir = args.afternoon_dir.expanduser().resolve()
    stereo_dir = args.stereo_dir.expanduser().resolve()
    output_dir = args.output_dir.expanduser().resolve()
    cloud_output_dir = output_dir / "clouds"
    thumb_output_dir = output_dir / "thumbs"

    splat_source = afternoon_dir / "AFTERNOON_ONLY.ply"
    frustum_splat_source = afternoon_dir / "stereo_camera_frustums.ply"
    pose_source = afternoon_dir / "stereo_camera_poses.json"
    if not splat_source.is_file():
        raise FileNotFoundError(splat_source)
    if not frustum_splat_source.is_file():
        raise FileNotFoundError(frustum_splat_source)
    if not pose_source.is_file():
        raise FileNotFoundError(pose_source)

    output_dir.mkdir(parents=True, exist_ok=True)
    link_or_copy(splat_source, output_dir / "AFTERNOON_ONLY.ply", args.copy_large_assets)
    link_or_copy(frustum_splat_source, output_dir / "stereo_camera_frustums.ply", args.copy_large_assets)

    raw = json.loads(pose_source.read_text(encoding="utf-8"))
    frames_raw = raw.get("frames", {})
    if not isinstance(frames_raw, dict) or not frames_raw:
        raise ValueError("Pose JSON contains no frames")
    intrinsics = manifest_intrinsics(raw)
    occlusion = build_occlusion_proxy(splat_source, output_dir / "occlusion_proxy.bin", args.occlusion_points)

    frames = []
    missing_clouds = []
    for index, (frame_name, pose) in enumerate(sorted(frames_raw.items()), start=1):
        frame_id = Path(frame_name).stem
        frame_dir = stereo_dir / frame_id
        cloud_source = frame_dir / "cloud.ply"
        if not cloud_source.is_file():
            missing_clouds.append(str(cloud_source))
            continue

        cloud_target = cloud_output_dir / f"{frame_id}.camera.decimated.ply"
        position = pose["position"]
        quaternion = pose["quaternion_wxyz_c2w"]
        cloud_info = build_cloud_asset(
            cloud_source,
            cloud_target,
            position,
            quaternion,
            intrinsics,
            args.max_cloud_points,
            args.min_depth,
            args.cloud_sampling_mode,
            args.cloud_voxel_size,
        )

        thumb_source = frame_dir / "rect_left.jpg"
        if not thumb_source.is_file():
            thumb_source = frame_dir / "img0.jpg"
        thumb_url = None
        if thumb_source.is_file():
            thumb_target = thumb_output_dir / f"{frame_id}.jpg"
            link_or_copy(thumb_source, thumb_target, args.copy_large_assets)
            thumb_url = f"/data/afternoon/thumbs/{frame_id}.jpg"

        frame = {
            "id": frame_id,
            "sourceFrame": frame_name,
            "index": index,
            "label": f"{index:02d}",
            "position": [round(float(value), 8) for value in position],
            "quaternion_wxyz_c2w": [round(float(value), 12) for value in quaternion],
            "cloudUrl": f"/data/afternoon/clouds/{frame_id}.camera.decimated.ply",
            "cloudCoordinateFrame": "stereo-camera-opencv",
            "thumbnailUrl": thumb_url,
            "pointCount": cloud_info["count"],
            "cloudSamplingMode": cloud_info["samplingMode"],
            "cloudVoxelSize": cloud_info["voxelSize"],
            "cloudBounds": cloud_info["bounds"],
            "worldCloudBounds": cloud_info["worldBounds"],
            "frustum": [
                [round(float(v), 8) for v in point]
                for point in camera_frustum_points(position, quaternion, intrinsics, args.frustum_depth)
            ],
        }
        frames.append(frame)
        print(f"{index:02d}/{len(frames_raw)} {frame_id}: {cloud_info['count']:,} points")

    if missing_clouds:
        raise FileNotFoundError("Missing registered cloud files:\n" + "\n".join(missing_clouds))

    manifest = {
        "version": 1,
        "dataset": "afternoon",
        "source": {
            "coordinateFrame": raw.get("coordinate_frame"),
            "convention": raw.get("convention"),
            "registeredFrames": raw.get("n_registered"),
        },
        "stereoCloudCoordinateFrame": {
            "name": "stereo-camera-opencv",
            "axes": {
                "x": "+X points right in the image",
                "y": "+Y points down in the image",
                "z": "+Z points from the image sensor toward the outside scene",
            },
        },
        "assets": {
            "splatUrl": "/data/afternoon/AFTERNOON_ONLY.ply",
            "frustumSplatUrl": "/data/afternoon/stereo_camera_frustums.ply",
            "occlusionProxyUrl": occlusion["url"],
            "occlusionProxy": occlusion,
        },
        "intrinsics": intrinsics,
        "cloudSampling": {
            "mode": args.cloud_sampling_mode,
            "maxPointsPerCloud": args.max_cloud_points,
            "voxelSize": args.cloud_voxel_size if args.cloud_sampling_mode in ("voxel", "hybrid") else None,
        },
        "frames": frames,
    }
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Wrote {manifest_path}")
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build web assets for the afternoon 3DGS stereo camera viewer.")
    parser.add_argument("--afternoon-dir", type=Path, default=Path("/Users/andyliu/Downloads/afternoon_data"))
    parser.add_argument("--stereo-dir", type=Path, default=Path("/Users/andyliu/Downloads/20260612_littlehouse_stereo"))
    parser.add_argument("--output-dir", type=Path, default=Path("public/data/afternoon"))
    parser.add_argument("--max-cloud-points", type=int, default=1_000_000)
    parser.add_argument(
        "--cloud-sampling-mode",
        choices=("linear", "random", "stratified", "voxel", "hybrid"),
        default="hybrid",
    )
    parser.add_argument(
        "--cloud-voxel-size",
        type=float,
        default=0.006,
        help="Voxel size in stereo cloud units for voxel/hybrid sampling. The afternoon clouds are meter-scale.",
    )
    parser.add_argument("--occlusion-points", type=int, default=140_000)
    parser.add_argument("--min-depth", type=float, default=0.05)
    parser.add_argument("--frustum-depth", type=float, default=0.45)
    parser.add_argument("--copy-large-assets", action="store_true", help="Copy raw assets instead of symlinking them.")
    return parser.parse_args()


def main() -> int:
    build_manifest(parse_args())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
