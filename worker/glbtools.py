"""Tiny dependency-light GLB writer/inspector.

Used for: (1) the generic fallback models in /assets/generic (original, CC0), (2) test fixtures
(a deliberately messy GLB), (3) sanity-checking GLBs that come back from 3D providers.
"""
from __future__ import annotations

import io
import json
import math
import struct
from dataclasses import dataclass, field

import numpy as np

GLB_MAGIC = 0x46546C67


@dataclass
class Part:
    positions: np.ndarray            # (n,3) float32
    normals: np.ndarray              # (n,3) float32
    indices: np.ndarray              # (m,) uint32
    uvs: np.ndarray | None = None    # (n,2) float32
    color: tuple[float, float, float] = (0.7, 0.6, 0.5)
    metallic: float | None = 0.0     # None = omit the factor (glTF then defaults to 1.0)
    roughness: float = 0.8
    texture_png: bytes | None = None
    translation: tuple[float, float, float] = (0.0, 0.0, 0.0)
    name: str = "part"


def box(w: float, h: float, d: float, center: tuple[float, float, float] = (0, 0, 0)) -> tuple[np.ndarray, ...]:
    """Axis-aligned box: w along X, h along Y, d along Z. 24 verts so normals and UVs are per face."""
    hx, hy, hz = w / 2, h / 2, d / 2
    faces = [  # normal, 4 corners (CCW seen from outside)
        ((0, 0, 1), [(-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]),
        ((0, 0, -1), [(hx, -hy, -hz), (-hx, -hy, -hz), (-hx, hy, -hz), (hx, hy, -hz)]),
        ((1, 0, 0), [(hx, -hy, hz), (hx, -hy, -hz), (hx, hy, -hz), (hx, hy, hz)]),
        ((-1, 0, 0), [(-hx, -hy, -hz), (-hx, -hy, hz), (-hx, hy, hz), (-hx, hy, -hz)]),
        ((0, 1, 0), [(-hx, hy, hz), (hx, hy, hz), (hx, hy, -hz), (-hx, hy, -hz)]),
        ((0, -1, 0), [(-hx, -hy, -hz), (hx, -hy, -hz), (hx, -hy, hz), (-hx, -hy, hz)]),
    ]
    pos, nor, uv, idx = [], [], [], []
    for n, corners in faces:
        base = len(pos)
        for (x, y, z), t in zip(corners, [(0, 1), (1, 1), (1, 0), (0, 0)]):
            pos.append((x + center[0], y + center[1], z + center[2]))
            nor.append(n)
            uv.append(t)
        idx += [base, base + 1, base + 2, base, base + 2, base + 3]
    return (np.array(pos, np.float32), np.array(nor, np.float32), np.array(idx, np.uint32), np.array(uv, np.float32))


def cylinder(r_bottom: float, r_top: float, h: float, center: tuple[float, float, float] = (0, 0, 0),
             segments: int = 24) -> tuple[np.ndarray, ...]:
    """Closed cylinder / cone frustum along Y, centred on `center`."""
    pos, nor, uv, idx = [], [], [], []
    cx, cy, cz = center
    slope = (r_bottom - r_top) / h if h else 0.0
    for i in range(segments + 1):
        a = 2 * math.pi * i / segments
        ca, sa = math.cos(a), math.sin(a)
        n = np.array([ca, slope, sa])
        n = n / np.linalg.norm(n)
        pos += [(cx + r_bottom * ca, cy - h / 2, cz + r_bottom * sa), (cx + r_top * ca, cy + h / 2, cz + r_top * sa)]
        nor += [tuple(n), tuple(n)]
        uv += [(i / segments, 1), (i / segments, 0)]
    for i in range(segments):
        a, b, c, d = 2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 3
        idx += [a, b, d, a, d, c]
    for y, r, ny in ((cy - h / 2, r_bottom, -1), (cy + h / 2, r_top, 1)):
        if r <= 0:
            continue
        centre = len(pos)
        pos.append((cx, y, cz)); nor.append((0, ny, 0)); uv.append((0.5, 0.5))
        ring = len(pos)
        for i in range(segments + 1):
            a = 2 * math.pi * i / segments
            pos.append((cx + r * math.cos(a), y, cz + r * math.sin(a))); nor.append((0, ny, 0))
            uv.append((0.5 + 0.5 * math.cos(a), 0.5 + 0.5 * math.sin(a)))
        for i in range(segments):
            idx += [centre, ring + i, ring + i + 1] if ny > 0 else [centre, ring + i + 1, ring + i]
    # the side quads above were wound for +Y up with CCW outside; flip top cap handled by ny
    return (np.array(pos, np.float32), np.array(nor, np.float32), np.array(idx, np.uint32), np.array(uv, np.float32))


def part(mesh: tuple[np.ndarray, ...], **kw) -> Part:
    pos, nor, idx, uv = mesh
    return Part(positions=pos, normals=nor, indices=idx, uvs=uv, **kw)


def build_glb(parts: list[Part], generator: str = "FitCheck glbtools") -> bytes:
    bin_ = io.BytesIO()
    views, accessors, meshes, nodes, materials, images, textures = [], [], [], [], [], [], []

    def add_view(data: bytes, target: int | None = None) -> int:
        while bin_.tell() % 4:
            bin_.write(b"\x00")
        off = bin_.tell()
        bin_.write(data)
        v = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target:
            v["target"] = target
        views.append(v)
        return len(views) - 1

    def add_acc(arr: np.ndarray, type_: str, comp: int, target: int | None, minmax: bool = False) -> int:
        view = add_view(arr.tobytes(), target)
        acc = {"bufferView": view, "componentType": comp, "count": int(arr.shape[0]), "type": type_}
        if minmax:
            acc["min"] = [float(x) for x in arr.min(axis=0)]
            acc["max"] = [float(x) for x in arr.max(axis=0)]
        accessors.append(acc)
        return len(accessors) - 1

    for p in parts:
        attrs = {
            "POSITION": add_acc(p.positions.astype(np.float32), "VEC3", 5126, 34962, True),
            "NORMAL": add_acc(p.normals.astype(np.float32), "VEC3", 5126, 34962),
        }
        if p.uvs is not None:
            attrs["TEXCOORD_0"] = add_acc(p.uvs.astype(np.float32), "VEC2", 5126, 34962)
        ind = add_acc(p.indices.astype(np.uint32), "SCALAR", 5125, 34963)
        pbr: dict = {"baseColorFactor": [*p.color, 1.0], "roughnessFactor": p.roughness}
        if p.metallic is not None:
            pbr["metallicFactor"] = p.metallic
        if p.texture_png:
            images.append({"bufferView": add_view(p.texture_png), "mimeType": "image/png"})
            textures.append({"source": len(images) - 1})
            pbr["baseColorTexture"] = {"index": len(textures) - 1}
        materials.append({"name": p.name, "pbrMetallicRoughness": pbr})
        meshes.append({"name": p.name, "primitives": [{"attributes": attrs, "indices": ind, "material": len(materials) - 1}]})
        node = {"mesh": len(meshes) - 1, "name": p.name}
        if any(p.translation):
            node["translation"] = list(p.translation)
        nodes.append(node)

    while bin_.tell() % 4:
        bin_.write(b"\x00")
    gltf = {
        "asset": {"version": "2.0", "generator": generator},
        "scene": 0, "scenes": [{"nodes": list(range(len(nodes)))}],
        "nodes": nodes, "meshes": meshes, "materials": materials,
        "accessors": accessors, "bufferViews": views, "buffers": [{"byteLength": bin_.tell()}],
    }
    if images:
        gltf["images"], gltf["textures"] = images, textures
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    body = bin_.getvalue()
    total = 12 + 8 + len(js) + 8 + len(body)
    return (struct.pack("<III", GLB_MAGIC, 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js
            + struct.pack("<II", len(body), 0x004E4942) + body)


def inspect_glb(data: bytes) -> dict:
    """Sanity-check a provider GLB. Raises ValueError when it is not a usable binary glTF."""
    if len(data) < 20:
        raise ValueError("GLB too small")
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC:
        raise ValueError("not a GLB (bad magic)")
    if version != 2:
        raise ValueError(f"unsupported glTF version {version}")
    jlen, jtype = struct.unpack_from("<II", data, 12)
    if jtype != 0x4E4F534A or 20 + jlen > len(data):
        raise ValueError("GLB JSON chunk is corrupt")
    try:
        gltf = json.loads(data[20:20 + jlen])
    except ValueError as e:
        raise ValueError("GLB JSON chunk does not parse") from e
    meshes = gltf.get("meshes") or []
    if not meshes:
        raise ValueError("GLB has no meshes")
    tris = 0
    for m in meshes:
        for prim in m.get("primitives", []):
            acc = gltf["accessors"][prim["indices"]] if "indices" in prim else gltf["accessors"][prim["attributes"]["POSITION"]]
            tris += acc.get("count", 0) // 3
    return {"bytes": len(data), "declared_bytes": length, "meshes": len(meshes), "triangles": tris,
            "materials": len(gltf.get("materials") or []), "textures": len(gltf.get("textures") or []),
            "generator": (gltf.get("asset") or {}).get("generator")}
