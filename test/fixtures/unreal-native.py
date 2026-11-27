"""Build local native editor assets from generated sources for the opt-in round-trip test."""
from pathlib import Path
import struct
import zlib

import unreal


def png_chunk(name, data):
    return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data))


def texture_bytes():
    width = height = 4
    scanlines = b"".join(b"\0" + bytes(value for x in range(width) for value in (x * 60, y * 60, 70))
                         for y in range(height))
    return (b"\x89PNG\r\n\x1a\n"
            + png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + png_chunk(b"IDAT", zlib.compress(scanlines))
            + png_chunk(b"IEND", b""))


def import_task(source, factory, options=None):
    task = unreal.AssetImportTask()
    task.set_editor_property("filename", str(source))
    task.set_editor_property("automated", True)
    task.set_editor_property("destination_path", "/Game/Fixture")
    task.set_editor_property("factory", factory)
    task.set_editor_property("save", True)
    if options:
        task.set_editor_property("options", options)
    return task


def main():
    root = Path(__file__).resolve().parent
    mesh = root / "SM_Triangle.obj"
    mesh.write_text("o Triangle\nv 0 0 0\nv 100 0 0\nv 0 100 0\nvt 0 0\nvt 1 0\nvt 0 1\nf 1/1 2/2 3/3\n", encoding="utf-8")
    texture = root / "T_Grid.png"
    texture.write_bytes(texture_bytes())
    mesh_options = unreal.FbxImportUI()
    for name, value in {
        "automated_import_should_detect_type": False, "mesh_type_to_import": unreal.FBXImportType.FBXIT_STATIC_MESH,
        "import_mesh": True, "import_as_skeletal": False, "import_materials": False, "import_textures": False,
    }.items():
        mesh_options.set_editor_property(name, value)
    tasks = [import_task(mesh, unreal.FbxFactory(), mesh_options), import_task(texture, unreal.TextureFactory())]
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks(tasks)
    if not all(task.get_editor_property("imported_object_paths") for task in tasks):
        raise RuntimeError("Unreal did not import both local fixture sources")


main()
