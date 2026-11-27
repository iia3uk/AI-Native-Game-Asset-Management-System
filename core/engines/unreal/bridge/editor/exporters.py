import json
import unreal

from materials import material_data


EXPORTERS = {
    "StaticMesh": ("model", "fbx", "StaticMeshExporterFBX"),
    "SkeletalMesh": ("skeletal-model", "fbx", "SkeletalMeshExporterFBX"),
    "AnimSequence": ("animation", "fbx", "AnimSequenceExporterFBX"),
    "Texture2D": ("texture", "png", "TextureExporterPNG"),
    "SoundWave": ("audio", "wav", "SoundExporterWAV"),
}


def fbx_options():
    options = unreal.FbxExportOption()
    for name, value in {
        "ascii": False, "vertex_color": True, "level_of_detail": True,
        "collision": True, "export_morph_targets": True, "export_preview_mesh": False,
    }.items():
        options.set_editor_property(name, value)
    if hasattr(options, "export_source_mesh"):
        options.set_editor_property("export_source_mesh", False)
    return options


def write_asset(asset, class_name, directory, number):
    if class_name in {"Material", "MaterialInstanceConstant", "Skeleton"}:
        role = "skeleton" if class_name == "Skeleton" else "material"
        product = {"role": role, "format": "json"}
        data = {"objectPath": asset.get_path_name(), "className": class_name}
        if role == "material":
            data = material_data(asset, class_name)
        (directory / f"{number}.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return product

    role, extension, exporter_name = EXPORTERS[class_name]
    product = {"role": role, "format": extension}
    exporter_class = getattr(unreal, exporter_name, None)
    if exporter_class is None:
        return {**product, "issue": "unreal-exporter-unavailable"}
    destination = directory / f"{number}.{extension}"
    task = unreal.AssetExportTask()
    task.set_editor_property("object", asset)
    task.set_editor_property("exporter", exporter_class())
    task.set_editor_property("filename", str(destination))
    task.set_editor_property("automated", True)
    task.set_editor_property("prompt", False)
    task.set_editor_property("replace_identical", False)
    if extension == "fbx":
        task.set_editor_property("options", fbx_options())
    if not unreal.Exporter.run_asset_export_task(task) or not destination.is_file() or destination.stat().st_size == 0:
        return {**product, "issue": "unreal-export-failed"}
    if role == "texture":
        product.update({
            "width": asset.blueprint_get_size_x(),
            "height": asset.blueprint_get_size_y(),
            "colorSpace": "srgb" if asset.get_editor_property("srgb") else "linear",
        })
    return product
