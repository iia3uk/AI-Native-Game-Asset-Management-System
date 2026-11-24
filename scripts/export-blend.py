import json
import os
import re
import struct
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
original_image_names = {}
for image in bpy.data.images:
    if image.source not in {"FILE", "TILED", "SEQUENCE"} or image.packed_file or not image.filepath:
        continue
    normalized = image.filepath.replace("\\", "/")
    reference = Path(normalized.removeprefix("//"))
    original_image_names[image.name] = reference.name or image.name
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


def neutral_color(color):
    return min(color[:3]) >= 0.7 and max(color[:3]) - min(color[:3]) < 0.04


def fallback_color(material, socket, image_name):
    authored = socket.default_value if not neutral_color(socket.default_value) else material.diffuse_color
    if not neutral_color(authored):
        return tuple(authored[:3])
    title = re.sub(r"([a-z])([A-Z])", r"\1 \2", f"{material.name} {image_name}")
    name = re.sub(r"[^a-z]+", " ", title.lower())
    if re.search(r"\b(?:leaf|leaves|leafs|foliage|plants?|bush(?:es)?|ferns?)\b", name):
        return 0.095, 0.235, 0.055
    return tuple(authored[:3])


def missing_base_image(socket):
    if not socket.is_linked:
        return None
    node = socket.links[0].from_node
    while node.type == "REROUTE" and node.inputs[0].is_linked:
        node = node.inputs[0].links[0].from_node
    if node.type != "TEX_IMAGE":
        return None
    image = node.image
    if image and (image.packed_file or all(image.size)):
        return None
    return original_image_names.get(image.name, image.name) if image else node.name


color_sockets = [
    (material, node.inputs["Base Color"])
    for material in bpy.data.materials if material.node_tree
    for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"
]
missing_images = {}
missing_families = {}
for material, socket in color_sockets:
    name = missing_base_image(socket)
    if not name:
        continue
    for link in list(socket.links):
        material.node_tree.links.remove(link)
    socket.default_value = (*fallback_color(material, socket, name), socket.default_value[3])
    missing_images[material.name] = name
    missing_families[material.name.casefold()] = (name, tuple(socket.default_value))

for material, socket in color_sockets:
    family = missing_families.get(material.name.casefold())
    if family and material.name not in missing_images and not socket.is_linked and neutral_color(socket.default_value):
        missing_images[material.name], socket.default_value = family


def write_preview_texture_notes(path, notes):
    if not notes:
        return
    with path.open("rb") as stream:
        magic, version, _, length, chunk = struct.unpack("<4sIII4s", stream.read(20))
        if (magic, version, chunk) != (b"glTF", 2, b"JSON"):
            raise ValueError("Expected a GLB preview with a JSON chunk")
        document = json.loads(stream.read(length))
        remainder = stream.read()
    for material in document.get("materials", []):
        missing = notes.get(material.get("name"))
        if missing:
            material.setdefault("extras", {})["viewerMissingColorTexture"] = missing
    content = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf8")
    content += b" " * (-len(content) % 4)
    with path.open("wb") as stream:
        stream.write(struct.pack("<4sIII4s", magic, version, 20 + len(content) + len(remainder), len(content), chunk))
        stream.write(content)
        stream.write(remainder)


bpy.ops.export_scene.gltf(
    filepath=str(output),
    export_format="GLB",
    export_yup=True,
    export_animations=True,
    export_cameras=False,
    export_lights=False,
    export_apply=False,
)
write_preview_texture_notes(output, missing_images)
