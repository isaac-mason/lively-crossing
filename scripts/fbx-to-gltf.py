# Headless FBX -> GLB for Blender:
#   blender -b -P scripts/fbx-to-gltf.py -- <in.fbx> <out.glb>
#
# Imports one FBX into an empty scene and exports a GLB (mesh + skin + ALL
# animations), normalized to a human height and Y-up for three.js.
import bpy
import sys
import mathutils

argv = sys.argv[sys.argv.index("--") + 1:]
src, dst = argv[0], argv[1]
TARGET_HEIGHT = 1.8  # metres — normalize characters to real-world scale

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=src, automatic_bone_orientation=True)

# --- normalize height (Blender is Z-up here; glTF export converts to Y-up) ---
zmin, zmax = 1e9, -1e9
for o in bpy.context.scene.objects:
    if o.type == "MESH":
        for corner in o.bound_box:
            wz = (o.matrix_world @ mathutils.Vector(corner)).z
            zmin = min(zmin, wz)
            zmax = max(zmax, wz)
height = (zmax - zmin) if zmax > zmin else 0.0
scale = (TARGET_HEIGHT / height) if height > 1e-6 else 1.0
# Scale a ROOT node above the skeleton — scaling the armature itself cancels out
# in glTF skinning (joint * inverseBind absorbs it). Parent everything (at
# identity, so world positions are kept) under a root empty, then scale the empty.
root = bpy.data.objects.new("CharacterRoot", None)
bpy.context.scene.collection.objects.link(root)
for o in list(bpy.context.scene.objects):
    if o is not root and o.parent is None:
        o.parent = root
root.scale = (scale, scale, scale)


def clean(name):
    n = name.split("|")[-1]
    for p in ("Man_", "Woman_", "Male_", "Female_"):
        if n.startswith(p):
            n = n[len(p):]
    return n


# --- push every imported action onto its own NLA track so ALL export ---
arms = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
if arms:
    ad = arms[0].animation_data or arms[0].animation_data_create()
    ad.action = None
    for act in list(bpy.data.actions):
        trk = ad.nla_tracks.new()
        trk.name = clean(act.name)
        trk.strips.new(clean(act.name), int(act.frame_range[0]), act)

print(f"[fbx-to-gltf] height {height:.2f} -> scale {scale:.3f}; {len(bpy.data.actions)} actions")

bpy.ops.export_scene.gltf(
    filepath=dst,
    export_format="GLB",
    export_yup=True,
    export_apply=False,
    export_skins=True,
    export_animations=True,
    export_animation_mode="NLA_TRACKS",  # one glTF animation per NLA track
)
