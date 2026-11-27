import json
import os
import sys
from pathlib import Path

import bpy

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from stage_inputs import IMAGES, InputIssue, Inputs


def import_fbx(inputs):
    # The bundled Python FBX importer loads embedded textures through this callback.
    # Give it contained images or a local placeholder that can receive embedded data.
    from bpy_extras import image_utils
    from io_scene_fbx import import_fbx as fbx

    if not callable(getattr(fbx, "blen_read_texture_image", None)):
        raise InputIssue("converter-version-unsupported")
    original = image_utils.load_image
    placeholders = []

    def load_image(filepath, **_):
        path = inputs.contained(inputs.source.parent / filepath, IMAGES)
        if path:
            return bpy.data.images.load(str(path), check_existing=True)
        name = "embedded-texture-" + str(len(placeholders)) + ".png"
        image = bpy.data.images.new(name, 1, 1)
        image.filepath = str(inputs.directory / name)
        image.source = "FILE"
        placeholders.append(image)
        return image

    try:
        image_utils.load_image = load_image
        result = bpy.ops.import_scene.fbx(filepath=str(inputs.source), use_image_search=False, use_custom_props=False)
    finally:
        image_utils.load_image = original
    for image in placeholders:
        if not image.packed_file:
            inputs.issues.add("missing-model-dependency")
            bpy.data.images.remove(image, do_unlink=True)
    return result


def import_model(inputs):
    suffix = inputs.source.suffix.lower()
    if suffix == ".obj":
        path = inputs.obj()
        return bpy.ops.wm.obj_import(filepath=str(path), forward_axis="NEGATIVE_Z", up_axis="Y")
    if suffix in {".gltf", ".glb"}:
        path = inputs.gltf()
        return bpy.ops.import_scene.gltf(filepath=str(path), import_pack_images=True)
    if suffix == ".fbx":
        return import_fbx(inputs)
    raise InputIssue("model-format-unsupported")


def export_model(workspace, format_name):
    target = workspace / ("model." + format_name)
    if format_name == "fbx":
        return bpy.ops.export_scene.fbx(filepath=str(target), add_leaf_bones=False, bake_anim=True,
                                        bake_anim_use_nla_strips=False, path_mode="COPY", embed_textures=True,
                                        use_custom_props=False, use_tspace=True)
    if format_name == "glb":
        return bpy.ops.export_scene.gltf(filepath=str(target), export_format="GLB", export_yup=True,
                                         export_animations=True, export_tangents=True, export_all_influences=True,
                                         export_all_vertex_colors=True, export_apply=False)
    raise InputIssue("model-format-unsupported")


def run(inputs, workspace, formats, report):
    if bpy.app.version < (4, 5, 0):
        raise InputIssue("converter-version-unsupported")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if "FINISHED" not in import_model(inputs):
        raise InputIssue("model-import-failed")
    meshes = [obj.data for obj in bpy.context.scene.objects if obj.type == "MESH"]
    triangles = sum(max(0, len(face.vertices) - 2) for mesh in meshes for face in mesh.polygons)
    if not triangles:
        raise InputIssue("model-has-no-surfaces")
    report["metrics"] = {
        "triangles": triangles,
        "meshes": len(meshes),
        "bones": sum(len(obj.data.bones) for obj in bpy.context.scene.objects if obj.type == "ARMATURE"),
        "animations": len(bpy.data.actions),
        "morphTargets": sum(max(0, len(mesh.shape_keys.key_blocks) - 1) for mesh in meshes if mesh.shape_keys),
    }
    for format_name in formats:
        try:
            if "FINISHED" in export_model(workspace, format_name):
                report["outputs"][format_name] = "written"
            else:
                report["outputs"][format_name] = "model-export-failed"
        except (RuntimeError, ValueError, TypeError, OSError):
            report["outputs"][format_name] = "model-export-failed"
    report["issues"] = sorted(inputs.issues)


root, source, workspace, formats = sys.argv[sys.argv.index("--") + 1:]
workspace = Path(workspace).resolve()
root = Path(root).resolve()
source = Path(os.path.abspath(source))
report = {"version": bpy.app.version_string, "outputs": {}}
try:
    if not source.is_relative_to(root) or source.resolve() != source or not source.is_file():
        raise InputIssue("model-file-unavailable")
    run(Inputs(root, source, workspace), workspace, formats.split(","), report)
except InputIssue as error:
    report["error"] = str(error)
except (RuntimeError, ValueError, TypeError, OSError, AttributeError, RecursionError):
    report["error"] = "model-import-failed"
(workspace / "result.json").write_text(json.dumps(report), encoding="utf-8")
