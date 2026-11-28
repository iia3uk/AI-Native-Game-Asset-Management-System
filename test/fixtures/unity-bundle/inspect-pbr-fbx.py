import json
from pathlib import Path
import sys

import bpy


source, output = sys.argv[sys.argv.index("--") + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
assert "FINISHED" in bpy.ops.import_scene.fbx(filepath=source, use_image_search=False)
material = bpy.data.materials["PbrMetal"]
principled = next(node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
models = {}
for field in ("Base Color", "Normal", "Roughness", "Metallic", "Emission Color"):
    socket = principled.inputs[field]
    node = socket.links[0].from_node
    if node.type == "NORMAL_MAP":
        node = node.inputs["Color"].links[0].from_node
    assert node.type == "TEX_IMAGE"
    assert node.image.packed_file
    mapping = node.inputs["Vector"].links[0].from_node
    assert mapping.type == "MAPPING"
    models[field] = {
        "pixel": [round(value * 255) for value in node.image.pixels[:4]],
        "scale": list(mapping.inputs["Scale"].default_value)[:2],
        "offset": list(mapping.inputs["Location"].default_value)[:2],
    }
Path(output).write_text(json.dumps(models), encoding="utf-8")
