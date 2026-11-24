import os
import sys
from pathlib import Path

import bpy


args = sys.argv[sys.argv.index("--") + 1:]
output = Path(args[0])
asset_root = Path(args[1]).resolve()

# Redirect links to files provided with the pack and ignore references outside it.
local_images = {}
for file in asset_root.rglob("*"):
    if file.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".tga", ".exr", ".tif", ".tiff", ".bmp"} and not file.is_symlink() and file.is_file() and file.resolve().is_relative_to(asset_root):
        local_images.setdefault(file.name.casefold(), []).append(file)

source_dir = Path(bpy.data.filepath).parent
for image in bpy.data.images:
    if image.source not in {"FILE", "TILED", "SEQUENCE"} or image.packed_file or not image.filepath:
        continue
    normalized = image.filepath.replace("\\", "/")
    reference = Path(normalized.removeprefix("//"))
    location = Path(os.path.abspath(bpy.path.abspath(normalized, library=image.library)))
    if location.is_relative_to(asset_root):
        resolved = location.resolve()
        if resolved.is_relative_to(asset_root) and resolved.is_file():
            image.filepath = str(resolved)
            image.reload()
            continue
    candidates = local_images.get(reference.name.casefold(), [])
    if len(candidates) > 1:
        sibling = [file for file in candidates if file.parent == source_dir]
        candidates = sibling or [file for file in candidates if file.parent.name.casefold() == reference.parent.name.casefold()]
    if len(candidates) == 1:
        image.filepath = str(candidates[0])
        image.reload()
    else:
        image.filepath = ""

# Keep review copies responsive and leave the Blender source on disk untouched.
for image in bpy.data.images:
    width, height = image.size
    if image.source == "FILE" and max(width, height) > 1536:
        ratio = 1536 / max(width, height)
        try:
            image.scale(max(1, round(width * ratio)), max(1, round(height * ratio)))
            image.pack()
        except RuntimeError:
            pass

bpy.ops.export_scene.gltf(
    filepath=str(output),
    export_format="GLB",
    export_yup=True,
    export_animations=True,
    export_cameras=False,
    export_lights=False,
    export_apply=False,
)
