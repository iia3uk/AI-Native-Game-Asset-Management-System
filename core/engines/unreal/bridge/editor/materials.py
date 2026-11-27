from itertools import islice
import unreal


def material_data(asset, class_name):
    library = unreal.MaterialEditingLibrary
    textures = []
    if class_name == "MaterialInstanceConstant":
        parent = asset.get_editor_property("parent")
        for entry in islice(asset.get_editor_property("texture_parameter_values"), 256):
            info = entry.get_editor_property("parameter_info")
            texture = entry.get_editor_property("parameter_value")
            if texture:
                textures.append({
                    "parameter": str(info.name), "association": str(info.association),
                    "index": info.index, "texture": texture.get_path_name(),
                })
    else:
        parent = None
        textures = [{"texture": item.get_path_name()} for item in islice(library.get_used_textures(asset) or [], 256)]
    return {
        "objectPath": asset.get_path_name(),
        "className": class_name,
        "parent": parent.get_path_name() if parent else None,
        "textures": textures,
    }
