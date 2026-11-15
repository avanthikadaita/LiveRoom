"""Build /assets/generic/<category>.glb: one simple original model per allowlisted category.

These are procedural placeholders written for this project (released CC0), used only as the
generic fallback when every 3D provider fails or is out of quota. Cards that use them carry the
"approx model" badge (assets.is_approx_model = true). Base at the origin, closed meshes, metres.

    python -m scripts.make_generic_assets
"""
from __future__ import annotations

from worker.config import CATEGORY_ALLOWLIST, ROOT
from worker.glbtools import Part, box, build_glb, cylinder, inspect_glb, part

IN = 0.0254
WOOD = (0.62, 0.45, 0.30)
WOOD_DARK = (0.42, 0.30, 0.20)
FABRIC = (0.55, 0.58, 0.60)
CREAM = (0.92, 0.89, 0.80)
METAL = (0.25, 0.25, 0.27)


def b(w, h, d, x=0.0, y=0.0, z=0.0, color=WOOD, name="part") -> Part:
    """Box in inches; (x, z) = centre, y = bottom."""
    return part(box(w * IN, h * IN, d * IN, center=(x * IN, (y + h / 2) * IN, z * IN)), color=color, name=name)


def c(r0, r1, h, x=0.0, y=0.0, z=0.0, color=WOOD, name="part") -> Part:
    return part(cylinder(r0 * IN, r1 * IN, h * IN, center=(x * IN, (y + h / 2) * IN, z * IN)), color=color, name=name)


def legs(w, d, h, t=1.5, inset=1.0, color=WOOD_DARK, round_=False) -> list[Part]:
    out = []
    for sx in (-1, 1):
        for sz in (-1, 1):
            x, z = sx * (w / 2 - inset - t / 2), sz * (d / 2 - inset - t / 2)
            out.append(c(t / 2, t / 2 * 0.8, h, x, 0, z, color, "leg") if round_ else b(t, h, t, x, 0, z, color, "leg"))
    return out


def side_table():      # 20 x 18 x 22
    return [b(20, 1.2, 18, y=20.8, name="top"), b(17, 0.8, 15, y=6, name="shelf"), *legs(20, 18, 20.8)]


def nightstand():      # 20 x 16 x 24
    return [b(20, 19, 16, y=5, name="body"), b(18, 7.5, 0.6, y=14.5, z=8.3, color=WOOD_DARK, name="drawer1"),
            b(18, 7.5, 0.6, y=6, z=8.3, color=WOOD_DARK, name="drawer2"),
            b(4, 0.6, 0.6, y=18, z=8.9, color=METAL, name="pull1"), b(4, 0.6, 0.6, y=9.5, z=8.9, color=METAL, name="pull2"),
            *legs(20, 16, 5, t=1.4)]


def coffee_table():    # 44 x 22 x 17
    return [b(44, 1.5, 22, y=15.5, name="top"), b(39, 0.8, 17, y=4.5, name="shelf"), *legs(44, 22, 15.5, t=2)]


def desk_lamp():       # 8 x 8 x 18
    return [c(3.2, 3.0, 0.8, color=METAL, name="base"), c(0.35, 0.35, 11, y=0.8, color=METAL, name="stem"),
            c(4.0, 2.6, 6.2, y=11.8, color=CREAM, name="shade")]


def floor_lamp():      # 12 x 12 x 60
    return [c(5.5, 5.2, 1.0, color=METAL, name="base"), c(0.5, 0.5, 49, y=1.0, color=METAL, name="pole"),
            c(6.0, 4.5, 10, y=50, color=CREAM, name="shade")]


def stool():           # 14 x 14 x 22
    return [c(7, 7, 1.6, y=20.4, name="seat"), *legs(12.5, 12.5, 20.4, t=1.4, inset=0.6, round_=True),
            c(4.6, 4.6, 0.6, y=7, color=WOOD_DARK, name="ring")]


def ottoman():         # 20 x 18 x 16
    return [b(20, 13, 18, y=3, color=FABRIC, name="cushion"), *legs(20, 18, 3, t=1.6, inset=1.2)]


def accent_chair():    # 28 x 30 x 33
    return [b(28, 7, 28, y=8, color=FABRIC, name="seat_base"), b(22, 4, 22, y=15, z=1, color=FABRIC, name="cushion"),
            b(28, 20, 5, y=13, z=-12.5, color=FABRIC, name="back"),
            b(4, 9, 24, x=-12, y=13, z=1, color=FABRIC, name="arm_l"), b(4, 9, 24, x=12, y=13, z=1, color=FABRIC, name="arm_r"),
            *legs(28, 28, 8, t=1.8, inset=1.5)]


def dining_chair():    # 18 x 20 x 36
    return [b(18, 1.5, 18, y=16.5, z=1, name="seat"), b(18, 12, 1.2, y=24, z=-8.4, name="back_panel"),
            b(1.5, 36, 1.5, x=-8.25, z=-8.25, color=WOOD_DARK, name="post_l"),
            b(1.5, 36, 1.5, x=8.25, z=-8.25, color=WOOD_DARK, name="post_r"),
            b(1.5, 16.5, 1.5, x=-8.25, z=9.25, color=WOOD_DARK, name="leg_fl"),
            b(1.5, 16.5, 1.5, x=8.25, z=9.25, color=WOOD_DARK, name="leg_fr")]


def dresser():         # 50 x 18 x 34
    parts = [b(50, 30, 18, y=4, name="body"), *legs(50, 18, 4, t=2)]
    for row in range(3):
        for col in (-1, 1):
            parts.append(b(23, 8.6, 0.6, x=col * 12.2, y=5.2 + row * 9.6, z=9.3, color=WOOD_DARK, name="drawer"))
            parts.append(b(5, 0.6, 0.6, x=col * 12.2, y=9.2 + row * 9.6, z=9.9, color=METAL, name="pull"))
    return parts


def bookshelf():       # 30 x 12 x 65
    parts = [b(1, 65, 12, x=-14.5, name="side_l"), b(1, 65, 12, x=14.5, name="side_r"),
             b(28, 65, 0.5, z=-5.75, color=WOOD_DARK, name="back")]
    for i in range(6):
        parts.append(b(28, 1, 11.5, y=i * 12.8, z=0.25, name="shelf"))
    return parts


def desk():            # 48 x 24 x 30
    return [b(48, 1.5, 24, y=28.5, name="top"), b(1.5, 28.5, 22, x=-22.5, name="panel_l"),
            b(1.5, 28.5, 22, x=22.5, name="panel_r"), b(43.5, 10, 0.8, y=16, z=-9.5, color=WOOD_DARK, name="modesty"),
            b(14, 5, 20, x=14, y=23.5, color=WOOD_DARK, name="drawer")]


BUILDERS = {
    "side_table": side_table, "nightstand": nightstand, "coffee_table": coffee_table, "desk_lamp": desk_lamp,
    "floor_lamp": floor_lamp, "stool": stool, "ottoman": ottoman, "accent_chair": accent_chair,
    "dining_chair": dining_chair, "dresser": dresser, "bookshelf": bookshelf, "desk": desk,
}


def main() -> None:
    out = ROOT / "assets" / "generic"
    out.mkdir(parents=True, exist_ok=True)
    for cat in CATEGORY_ALLOWLIST:
        data = build_glb(BUILDERS[cat](), generator="FitCheck generic (CC0)")
        (out / f"{cat}.glb").write_bytes(data)
        info = inspect_glb(data)
        print(f"{cat:14s} {info['bytes']:6d} bytes  {info['meshes']} parts")
    (out / "README.md").write_text(
        "# Generic fallback models\n\nOne procedural model per allowlisted category, generated by "
        "`python -m scripts.make_generic_assets`. Written for FitCheck and released CC0.\n\n"
        "Used only when every image-to-3D provider fails or is out of quota. Items that use them are "
        "marked `is_approx_model = true` and the UI shows an \"approx model\" badge. They are still "
        "scaled to the listing's real height, so the footprint in AR is honest even when the shape is generic.\n",
        encoding="utf-8")


if __name__ == "__main__":
    main()
