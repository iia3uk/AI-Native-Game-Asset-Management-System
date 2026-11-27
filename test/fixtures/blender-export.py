import sys
from pathlib import Path

import bpy


root = Path(sys.argv[-1])
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
bones = bpy.data.armatures.new("Fixture skeleton")
rig = bpy.data.objects.new("Fixture rig", bones)
scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
rig.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
bone = bones.edit_bones.new("Root")
bone.head = (0, 0, 0)
bone.tail = (0, 0, 1)
bpy.ops.object.mode_set(mode="OBJECT")

mesh = bpy.data.meshes.new("Fixture surface")
mesh.from_pydata([(0, 0, 0), (1, 0, 0), (0, 1, 1)], [], [(0, 1, 2)])
mesh.update()
surface = bpy.data.objects.new("Fixture mesh", mesh)
scene.collection.objects.link(surface)
surface.parent = rig
surface.vertex_groups.new(name="Root").add([0, 1, 2], 1, "REPLACE")
modifier = surface.modifiers.new("Fixture weights", "ARMATURE")
modifier.object = rig
for name in ("UVMap", "Detail"):
    uv = mesh.uv_layers.new(name=name)
    for index, coordinate in enumerate(((0, 0), (1, 0), (0, 1))):
        uv.uv[index].vector = coordinate
surface.shape_key_add(name="Basis")
surface.shape_key_add(name="Raise").data[2].co.z += 0.25

pose = rig.pose.bones["Root"]
pose.location = (0, 0, 0)
pose.keyframe_insert(data_path="location", frame=1)
pose.location = (0, 0, 0.25)
pose.keyframe_insert(data_path="location", frame=25)
rig.animation_data.action.name = "Lift"
scene.frame_set(1)
bpy.ops.export_scene.gltf(filepath=str(root / "rig.gltf"), export_format="GLTF_SEPARATE", export_animations=True)
