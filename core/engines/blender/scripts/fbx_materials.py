import bpy
import numpy as np


def source(socket):
    return socket.links[0].from_socket if socket is not None and len(socket.links) == 1 else None


def image_node(socket):
    if socket is not None and socket.name == "Color" and socket.node.type == "TEX_IMAGE" and socket.node.image:
        return socket.node
    return None


def _mapping_socket(texture, issues):
    link = source(texture.inputs.get("Vector"))
    if link is not None and link.node.type == "COMBXYZ":
        # glTF's image importer synthesizes per-axis wrap with a vector graph.
        # Blender's FBX exporter reads a directly connected Mapping node.
        issues.add("fbx-texture-sampling")
        axis = source(link.node.inputs.get("X"))
        if axis is not None and axis.node.type == "SEPXYZ":
            link = source(axis.node.inputs.get("Vector"))
    if texture.interpolation == "Closest" or texture.extension == "MIRROR":
        issues.add("fbx-texture-sampling")
    return link


class FbxImages:
    def __init__(self):
        self.remaining_pixels = 8 * 1024 * 1024
        self.packed = {}

    def connect(self, tree, target, texture, channel, factor, issues):
        image = texture.image
        key = (image.as_pointer(), channel, factor)
        prepared = self.packed.get(key)
        if prepared is None:
            width, height = image.size
            pixels = width * height
            expected_space = "sRGB" if channel is None else "Non-Color"
            if image.colorspace_settings.name != expected_space or not 0 < pixels <= min(2048 ** 2, self.remaining_pixels):
                issues.add("fbx-material-channel-unavailable")
                return
            data = np.empty(pixels * 4, dtype=np.float32)
            image.pixels.foreach_get(data)
            data = data.reshape(-1, 4)
            if channel is None:
                values = data[:, :3]
                linear = np.where(values <= .04045, values / 12.92, ((values + .055) / 1.055) ** 2.4)
                linear *= factor
                data[:, :3] = np.where(linear <= .0031308, linear * 12.92, 1.055 * linear ** (1 / 2.4) - .055)
                label = "Emission"
            else:
                data[:, :3] = data[:, channel:channel + 1] * factor
                label = "Metallic" if channel == 2 else "Roughness"
            data[:, :3] = np.rint(np.clip(data[:, :3], 0, 1) * 255) / 255
            data[:, 3] = 1
            prepared = bpy.data.images.new(image.name + " " + label, width=width, height=height, alpha=False)
            prepared.colorspace_settings.name = expected_space
            prepared.pixels.foreach_set(data.reshape(-1))
            prepared.pack()
            self.packed[key] = prepared
            self.remaining_pixels -= pixels

        node = tree.nodes.new("ShaderNodeTexImage")
        node.image = prepared
        node.extension = texture.extension
        node.interpolation = texture.interpolation
        vector = _mapping_socket(texture, issues)
        if vector is not None:
            tree.links.new(vector, node.inputs["Vector"])
        tree.links.new(node.outputs["Color"], target)


def scalar_map(socket, output, channel, tree, images, issues):
    origin = source(socket)
    if origin is None:
        return
    factor = 1.0
    if origin.node.type == "MATH" and origin.node.operation == "MULTIPLY":
        multiplier = origin.node.inputs[1]
        if multiplier.is_linked or not 0 <= multiplier.default_value <= 1:
            issues.add("fbx-material-channel-unavailable")
            return
        factor = multiplier.default_value
        origin = source(origin.node.inputs[0])
    if origin is not None and origin.node.type == "SEPARATE_COLOR" and origin.node.mode == "RGB" and origin.name == output:
        texture = image_node(source(origin.node.inputs["Color"]))
        if texture:
            images.connect(tree, socket, texture, channel, factor, issues)
            return
    issues.add("fbx-material-channel-unavailable")


def emissive_map(socket, tree, images, issues):
    origin = source(socket)
    if origin is None or image_node(origin):
        return
    mix = origin.node
    if mix.type == "MIX" and mix.data_type == "RGBA" and mix.blend_type == "MULTIPLY":
        amount, first, tint = (next((item for item in mix.inputs if item.identifier == key), None)
                               for key in ("Factor_Float", "A_Color", "B_Color"))
        if amount is not None and not amount.is_linked and amount.default_value == 1 and first is not None and (
                tint is not None and not tint.is_linked and all(0 <= value <= 1 for value in tint.default_value[:3])):
            texture = image_node(source(first))
            if texture:
                images.connect(tree, socket, texture, None, tuple(tint.default_value[:3]), issues)
                return
    issues.add("fbx-material-channel-unavailable")


def restore_fbx_material_maps(issues):
    images = FbxImages()
    for material in bpy.data.materials:
        tree = material.node_tree
        if not tree:
            continue
        for texture in list(tree.nodes):
            if texture.type == "GROUP" and source(texture.inputs.get("Occlusion")) is not None:
                issues.add("fbx-occlusion-unsupported")
            if texture.type == "TEX_IMAGE":
                vector = _mapping_socket(texture, issues)
                if vector is not None and vector.node.type in {"MAPPING", "UVMAP"}:
                    tree.links.new(vector, texture.inputs["Vector"])
        for material_node in list(tree.nodes):
            if material_node.type != "BSDF_PRINCIPLED":
                continue
            scalar_map(material_node.inputs["Metallic"], "Blue", 2, tree, images, issues)
            scalar_map(material_node.inputs["Roughness"], "Green", 1, tree, images, issues)
            emissive_map(material_node.inputs["Emission Color"], tree, images, issues)
