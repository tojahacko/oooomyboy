"""Build the Blender scene for the Zielistki 34 walkthrough.

    python3 walkthrough/build_scene.py <house.obj> <out.blend>

The exterior shell comes from the three.js model (exported with
tools/export_obj.mjs). The ground-floor day zone (living room, dining area,
kitchen) is reconstructed from the ten interior photos in source/zielistki34
and the garden from the rear perspective render.

Plan frame (metres): x runs west -> east from the west exterior wall face,
y runs south -> north from the front (entrance) wall face, z is up with 0 at
the finished ground-floor level; the garden lawn is at z = -0.15.

Landmarks used to place the interior (all cross-checked between photos):
  sliding terrace door  north wall, x 6.46-9.09 (rear elevation)
  dining window         east wall,  y 3.22-5.04, sill 0.49 (east elevation)
  kitchen window        south wall, x 7.63-9.47, sill 0.91 = worktop
  fireplace breast      around the central chimney flue (x 4.7-5.6, y 2.2-3.1)
  TV wall               faces the sofa; 0.8 m of white wall to the door jamb
  art wall + sofa       east wall between the dining window and north wall
"""
import math
import os
import random
import sys

import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import materials as MT  # noqa: E402
import vegetation as VG  # noqa: E402

HX = 796 / 76  # exterior length (x)
HY = 627 / 76  # exterior depth (y)
T = 0.35  # wall thickness
X0, X1, Y0, Y1 = T, HX - T, T, HY - T  # interior wall faces
CEIL = 2.65
GROUND = -0.15

SLIDER = (491 / 76, 691 / 76)  # x range, head 2.355
EAST_WIN = (245 / 76, 383 / 76)  # y range, 0.487 .. 2.329
KITCHEN_WIN = (580 / 76, 720 / 76)  # x range, 0.908 .. 2.355
OPEN_HEAD = 179 / 76

rng = random.Random(34)
MAT = {}


# ---------------------------------------------------------------- helpers

def collection(name):
    c = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if c.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(c)
    return c


def link(obj, coll):
    for c in obj.users_collection:
        c.objects.unlink(obj)
    collection(coll).objects.link(obj)
    return obj


def mesh_obj(name, verts, faces, mat, coll='interior'):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    ob = bpy.data.objects.new(name, me)
    collection(coll).objects.link(ob)
    if mat:
        ob.data.materials.append(mat)
    return ob


def box(name, x0, x1, y0, y1, z0, z1, mat, coll='interior', bevel=0.0, segments=3):
    """Axis-aligned box; object origin at its centre so Object texture
    coordinates are in metres around the piece."""
    cx, cy, cz = (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2
    hx, hy, hz = abs(x1 - x0) / 2, abs(y1 - y0) / 2, abs(z1 - z0) / 2
    v = [(sx * hx, sy * hy, sz * hz) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    ob = mesh_obj(name, v, f, mat, coll)
    ob.location = (cx, cy, cz)
    if bevel:
        m = ob.modifiers.new('bevel', 'BEVEL')
        m.width = bevel
        m.segments = segments
        m.limit_method = 'NONE'
        m.harden_normals = False
    return ob


def cylinder(name, x, y, z0, z1, r, mat, coll='interior', verts=32, r_top=None):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r if r_top is None else r_top,
                                    depth=z1 - z0, location=(x, y, (z0 + z1) / 2))
    ob = bpy.context.object
    ob.name = name
    link(ob, coll)
    ob.data.materials.append(mat)
    for p in ob.data.polygons:
        p.use_smooth = True
    return ob


def sphere(name, loc, r, mat, coll='interior', seg=24, scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=seg // 2, radius=r, location=loc)
    ob = bpy.context.object
    ob.name = name
    ob.scale = scale
    link(ob, coll)
    ob.data.materials.append(mat)
    for p in ob.data.polygons:
        p.use_smooth = True
    return ob


def rod(name, a, b, r, mat, coll='interior', verts=12):
    a, b = Vector(a), Vector(b)
    d = b - a
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=d.length, location=(a + b) / 2)
    ob = bpy.context.object
    ob.name = name
    ob.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    link(ob, coll)
    ob.data.materials.append(mat)
    for p in ob.data.polygons:
        p.use_smooth = True
    return ob


def smooth(ob, level=2):
    m = ob.modifiers.new('subd', 'SUBSURF')
    m.levels = level
    m.render_levels = level
    for p in ob.data.polygons:
        p.use_smooth = True
    return ob


def mat(key):
    if key in MAT:
        return MAT[key]
    maker = {
        'wall': lambda: MT.plaster('wall_white', '#f3f2ee', var=0.025, rough=0.93),
        'ext_white': lambda: MT.plaster('ext_white', '#f1f0ec', var=0.04, rough=0.9, bump=0.08),
        'ext_grey': lambda: MT.plaster('ext_grey', '#a4a6a8', var=0.05, rough=0.9, bump=0.08),
        'chimney': lambda: MT.plaster('chimney', '#55585c', var=0.06, rough=0.9, bump=0.1),
        'plinth': lambda: MT.plaster('plinth', '#8e8f8c', var=0.1, rough=0.95, scale=4, bump=0.2),
        'ceiling': lambda: MT.plaster('ceiling', '#f6f5f2', var=0.015, rough=0.95),
        'feature': lambda: MT.decorative_plaster('feature_plaster'),
        'floor': lambda: MT.stone_tiles('floor_tiles'),
        'oakZ': lambda: MT.oak('oak_vertical', 'Z'),
        'oakX': lambda: MT.oak('oak_x', 'X'),
        'oakY': lambda: MT.oak('oak_y', 'Y'),
        'tableoak': lambda: MT.oak('table_oak', 'X', light='#d9c09e', mid='#c8ab86', dark='#b09070', rough=0.5),
        'cedarZ': lambda: MT.oak('cedar_z', 'Z', light='#d9b389', mid='#c39668', dark='#a3764d', rough=0.7),
        'cedarX': lambda: MT.oak('cedar_x', 'X', light='#d9b389', mid='#c39668', dark='#a3764d', rough=0.7),
        'cedarY': lambda: MT.oak('cedar_y', 'Y', light='#d9b389', mid='#c39668', dark='#a3764d', rough=0.7),
        'lacquer': lambda: MT.lacquer('white_lacquer'),
        'splash': lambda: MT.backpainted_glass('backsplash'),
        'worktop': lambda: MT.countertop('worktop'),
        'anthracite': lambda: MT.plain('anthracite', '#2c2d2f', rough=0.45),
        'black': lambda: MT.plain('black_powder', '#161617', rough=0.42),
        'blackgloss': lambda: MT.plain('black_gloss', '#0b0b0c', rough=0.12, coat=0.6),
        'frame': lambda: MT.plain('window_frame', '#37393d', rough=0.38, metal=0.2),
        'glass': lambda: MT.glass('glazing'),
        'clear': lambda: MT.glass('clear_glass', tint='#fbfdfc'),
        'steel': lambda: MT.plain('steel', '#c9ccd0', rough=0.22, metal=1.0),
        'darkmetal': lambda: MT.plain('dark_metal', '#34373b', rough=0.4, metal=0.5),
        'screen': lambda: MT.screen('tv_screen'),
        'sofa': lambda: MT.fabric('sofa_fabric', '#706b65'),
        'chair': lambda: MT.fabric('chair_fabric', '#5d5d5e', var=0.05),
        'rug': lambda: MT.fabric('rug', '#cbc3b6', var=0.04, sheen=0.9, weave=160),
        'pillow_beige': lambda: MT.fabric('pillow_beige', '#c7b8a0'),
        'pillow_grey': lambda: MT.fabric('pillow_grey', '#77726c'),
        'pillow_light': lambda: MT.fabric('pillow_light', '#d9d2c6'),
        'throw': lambda: MT.fabric('throw', '#b4aa9c', weave=200),
        'blind': lambda: MT.oak('blind_slat', 'X', light='#cdb28c', mid='#b69770', dark='#9d7f5b', rough=0.6),
        'paintA': lambda: MT.painting_stripe('painting_stripe'),
        'paintB': lambda: MT.painting_split('painting_split'),
        'ceramic_white': lambda: MT.plain('ceramic_white', '#f2f0ec', rough=0.3, coat=0.4),
        'ceramic_black': lambda: MT.plain('ceramic_black', '#141414', rough=0.5),
        'fire': lambda: MT.fire('fire'),
        'embers': lambda: MT.plain('embers', '#1a1714', rough=0.95, emit='#ff4a0a', emit_strength=1.5),
        'logs': lambda: MT.bark('logs', '#4a3524'),
        'led': lambda: MT.emissive('led_strip', '#fff3de', 25),
        'grapes': lambda: MT.plain('grapes', '#2c1630', rough=0.25, coat=0.5),
        'grapes_green': lambda: MT.plain('grapes_green', '#8ea03c', rough=0.3, coat=0.5),
        'leaf': lambda: MT.foliage('herb_leaves', '#3d5f2a', '#6e8f45', 0.3),
        'cotton': lambda: MT.fabric('cotton', '#f4f2ee', sheen=1.0, weave=60),
        'twig': lambda: MT.bark('twig', '#5a4431'),
        'pampas': lambda: MT.fabric('pampas', '#d6c6a6', sheen=1.0, weave=40),
        'cake': lambda: MT.plain('cake', '#4a2a1a', rough=0.7),
        'stones': lambda: MT.plain('stones', '#1e1e1f', rough=0.35),
        'book1': lambda: MT.plain('book1', '#d8d2c6', rough=0.8),
        'book2': lambda: MT.plain('book2', '#3b3f45', rough=0.8),
        'book3': lambda: MT.plain('book3', '#9a8f7e', rough=0.8),
        # exterior / garden
        'roof': lambda: MT.roof_tiles('roof_tiles'),
        'deck': lambda: MT.decking('decking'),
        'paving': lambda: MT.paving('paving'),
        'lawn': lambda: MT.lawn_ground('lawn'),
        'grass': lambda: MT.grass_blades('grass_blades'),
        'foliage': lambda: MT.foliage('foliage'),
        'foliage_dark': lambda: MT.foliage('foliage_dark', '#1f3a1a', '#3a5a26', 0.25),
        'thuja': lambda: MT.foliage('thuja', '#1d3a17', '#3d6128', 0.2),
        'grass_orn': lambda: MT.foliage('ornamental_grass', '#5b6b3a', '#a4a36a', 0.3),
        'birch': lambda: MT.birch_bark('birch_bark'),
        'pinebark': lambda: MT.bark('pine_bark', '#7a4f33'),
        'fence': lambda: MT.plain('fence', '#3b3d40', rough=0.55),
        'gabion': lambda: MT.stones('gabion_stone'),
        'water': lambda: MT.water('pool_water'),
        'pooltile': lambda: MT.pool_tiles('pool_tiles'),
        'rattan': lambda: MT.plain('rattan', '#2a2826', rough=0.6),
        'cushion_out': lambda: MT.fabric('outdoor_cushion', '#6b6a67'),
        'lounger': lambda: MT.plain('lounger', '#e9e8e4', rough=0.45),
        'cushion_white': lambda: MT.fabric('cushion_white', '#f1efea', sheen=0.8),
        'soil': lambda: MT.plaster('soil', '#4a3b2c', var=0.2, rough=1, scale=6, bump=0.8),
        'gravel': lambda: MT.plaster('gravel', '#b0aca4', var=0.2, rough=0.95, scale=30, bump=1.5),
    }[key]
    MAT[key] = maker()
    return MAT[key]


# ---------------------------------------------------------------- exterior

EXT_MAT = {
    'white': 'ext_white', 'grey': 'ext_grey', 'plinth': 'plinth', 'concrete': 'paving',
    'chimney': 'chimney', 'chimneyCap': 'darkmetal', 'tiles': 'roof', 'verge': 'darkmetal',
    'soffit': 'anthracite', 'dark': 'darkmetal', 'gutter': 'darkmetal', 'frame': 'frame',
    'door': 'anthracite', 'steel': 'steel', 'glass': 'glass', 'clearGlass': 'clear',
    'interior': 'anthracite', 'blind': 'blind', 'wood': 'cedarZ', 'woodBacking': 'black',
    'timber': None, 'deck': 'deck',
}


def import_exterior(path):
    bpy.ops.wm.obj_import(filepath=path, forward_axis='NEGATIVE_Z', up_axis='Y')
    off = Vector((398 / 76, 340 / 76, -0.15))
    imported = list(bpy.context.selected_objects)
    for ob in imported:
        ob.location += off
    # the importer stores the axis conversion as an object rotation: bake it
    # (and the offset) into the vertices so object space == plan space
    bpy.context.view_layer.update()
    for ob in imported:
        ob.data.transform(ob.matrix_world)
        ob.matrix_world = Matrix.Identity(4)
    doomed = []
    for ob in imported:
        link(ob, 'exterior')
        base = ob.material_slots[0].material.name.split('.')[0] if ob.material_slots else ''
        vs = [v.co for v in ob.data.vertices]
        c = Vector([(min(v[i] for v in vs) + max(v[i] for v in vs)) / 2 for i in range(3)])
        # glazing we rebuild: the terrace slider (opened), and the room-side
        # dark boxes / blinds behind the day-zone windows
        in_slider = SLIDER[0] - 0.1 < c.x < SLIDER[1] + 0.1 and Y1 - 0.05 < c.y < HY + 0.05 and c.z < 2.5
        in_east = c.x > X1 - 0.05 and EAST_WIN[0] - 0.1 < c.y < EAST_WIN[1] + 0.1 and 0.3 < c.z < 2.5
        in_kitchen = KITCHEN_WIN[0] - 0.1 < c.x < KITCHEN_WIN[1] + 0.1 and c.y < Y0 + 0.05 and 0.8 < c.z < 2.5
        if in_slider and base in ('frame', 'glass', 'interior', 'blind'):
            doomed.append(ob)
            continue
        if (in_east or in_kitchen) and base in ('interior', 'blind'):
            doomed.append(ob)
            continue
        key = EXT_MAT.get(base)
        if base == 'timber':
            dims = ob.dimensions
            key = 'cedar' + 'XYZ'[max(range(3), key=lambda i: dims[i])]
        if key:
            ob.data.materials.clear()
            ob.data.materials.append(mat(key))
        for p in ob.data.polygons:
            p.use_smooth = False
    for ob in doomed:
        bpy.data.objects.remove(ob)


def slider_door():
    """Lift-and-slide door: the west sash is slid open behind the fixed east
    sash, leaving a clear opening on the west side (the outdoor dining set
    and the sofa chaise sit in front of the east half)."""
    xa, xb = SLIDER
    h = OPEN_HEAD
    y_in, y_out = HY - 0.22, HY - 0.10
    f = 0.07
    fr = mat('frame')
    box('slider_frame_w', xa, xa + f, y_in, y_out, 0, h, fr, 'exterior')
    box('slider_frame_e', xb - f, xb, y_in, y_out, 0, h, fr, 'exterior')
    box('slider_frame_head', xa, xb, y_in, y_out, h - f, h, fr, 'exterior')
    box('slider_track', xa, xb, y_in - 0.02, y_out, -0.005, 0.018, mat('darkmetal'), 'exterior')
    mid = (xa + xb) / 2
    w = mid + 0.02 - (xa + f)
    shift = w - 0.14
    pf = 0.065

    def sash(name, s0, y0):
        s1 = s0 + w
        box(f'sash_{name}_l', s0, s0 + pf, y0, y0 + 0.05, 0.02, h - f, fr, 'exterior')
        box(f'sash_{name}_r', s1 - pf, s1, y0, y0 + 0.05, 0.02, h - f, fr, 'exterior')
        box(f'sash_{name}_t', s0, s1, y0, y0 + 0.05, h - f - pf, h - f, fr, 'exterior')
        box(f'sash_{name}_b', s0, s1, y0, y0 + 0.05, 0.02, 0.11, fr, 'exterior')
        box(f'sash_{name}_glass', s0 + pf, s1 - pf, y0 + 0.02, y0 + 0.03, 0.11, h - f - pf, mat('glass'), 'exterior')
        return s0, s1

    sash('fixed', xb - f - w, HY - 0.16)
    m0, _ = sash('moving', xa + f + shift, HY - 0.215)
    box('slider_handle', m0 + 0.02, m0 + 0.04, HY - 0.245, HY - 0.215, 0.9, 1.25, mat('black'), 'exterior')
    return xa + f, m0  # clear opening


# ---------------------------------------------------------------- interior shell

def shell():
    wall = mat('wall')
    box('floor', X0, X1, Y0, Y1, -0.02, 0, mat('floor'))
    box('ceiling', X0, X1, Y0, Y1, CEIL, CEIL + 0.05, mat('ceiling'))
    # partitions
    box('wall_hall_kitchen', 5.45, 5.58, Y0, 2.10, 0, CEIL, wall)
    box('wall_tv', 5.50, 5.65, 4.45, Y1, 0, CEIL, wall)
    box('wall_corridor_n', 2.0, 5.50, 4.45, 4.60, 0, CEIL, wall)
    box('wall_corridor_s', 2.0, 4.62, 3.0, 3.15, 0, CEIL, wall)
    box('wall_corridor_end', 1.85, 2.0, 3.0, 4.60, 0, CEIL, wall)
    # flush corridor doors with shadow gaps and black handles
    for i, (a, b) in enumerate(((2.75, 3.55), (3.72, 4.52))):
        box(f'door_gap_{i}', a - 0.004, b + 0.004, 3.148, 3.152, 0, 2.054, mat('anthracite'))
        box(f'door_leaf_{i}', a, b, 3.15, 3.162, 0.005, 2.05, mat('wall'))
        box(f'door_handle_{i}', b - 0.11, b - 0.08, 3.162, 3.21, 1.02, 1.05, mat('black'))
        box(f'door_rose_{i}', b - 0.12, b - 0.07, 3.162, 3.17, 1.01, 1.06, mat('black'))
    # feature wall behind the sofa
    box('feature_wall', X1 - 0.012, X1, EAST_WIN[1], Y1, 0, CEIL, mat('feature'))


def fireplace():
    wall = mat('wall')
    xa, xb, ya, yb = 4.62, 6.35, 2.10, 3.15
    z0, z1 = 0.42, 0.97
    fx, fy = 5.40, 2.45  # firebox opens north (x fx..xb) and east (y fy..yb)
    box('breast_base', xa, xb, ya, yb, 0, z0, wall)
    box('breast_top', xa, xb, ya, yb, z1, CEIL, wall)
    box('breast_mid_w', xa, fx, ya, yb, z0, z1, wall)
    box('breast_mid_s', fx, xb, ya, fy, z0, z1, wall)
    k = mat('ceramic_black')
    box('firebox_back', fx, fx + 0.02, fy, yb - 0.02, z0, z1, k)
    box('firebox_side', fx, xb - 0.02, fy, fy + 0.02, z0, z1, k)
    box('firebox_floor', fx, xb - 0.02, fy, yb - 0.02, z0, z0 + 0.03, k)
    box('firebox_top', fx, xb - 0.02, fy, yb - 0.02, z1 - 0.02, z1, k)
    # black frame and corner glass
    fr = mat('black')
    box('fire_frame_top_n', fx, xb, yb - 0.005, yb + 0.004, z1 - 0.03, z1, fr)
    box('fire_frame_bot_n', fx, xb, yb - 0.005, yb + 0.004, z0, z0 + 0.03, fr)
    box('fire_frame_top_e', xb - 0.005, xb + 0.004, fy, yb, z1 - 0.03, z1, fr)
    box('fire_frame_bot_e', xb - 0.005, xb + 0.004, fy, yb, z0, z0 + 0.03, fr)
    box('fire_frame_corner', xb - 0.015, xb + 0.004, yb - 0.015, yb + 0.004, z0, z1, fr)
    box('fire_frame_w', fx, fx + 0.02, yb - 0.005, yb + 0.004, z0, z1, fr)
    box('fire_frame_s', xb - 0.005, xb + 0.004, fy, fy + 0.02, z0, z1, fr)
    box('fire_glass_n', fx + 0.02, xb - 0.015, yb - 0.004, yb - 0.002, z0 + 0.03, z1 - 0.03, mat('clear'))
    box('fire_glass_e', xb - 0.004, xb - 0.002, fy + 0.02, yb - 0.015, z0 + 0.03, z1 - 0.03, mat('clear'))
    # decorative double black line that wraps the corner near the top
    for z in (2.00, 2.045):
        box(f'breast_line_n_{z}', 5.05, xb + 0.002, yb, yb + 0.003, z, z + 0.012, fr)
        box(f'breast_line_e_{z}', xb, xb + 0.003, ya + 0.35, yb + 0.003, z, z + 0.012, fr)
    # logs, embers and flames
    cx, cy = (fx + xb) / 2 + 0.05, (fy + yb) / 2 + 0.05
    for i, (dx, dy, rot) in enumerate(((-0.12, -0.02, 0.4), (0.08, 0.05, -0.5), (0.0, -0.09, 1.3))):
        lg = cylinder(f'log_{i}', 0, 0, -0.2, 0.2, 0.045, mat('logs'), verts=16)
        lg.rotation_euler = (math.pi / 2, 0, rot)
        lg.location = (cx + dx, cy + dy, z0 + 0.09 + i * 0.03)
    # bed of dark fireplace stones under the logs, a few glowing faintly
    for i in range(70):
        sx, sy = cx + rng.uniform(-0.32, 0.3), cy + rng.uniform(-0.28, 0.25)
        glow = math.hypot(sx - cx, sy - cy) < 0.12 and i % 3 == 0
        sphere('fire_stone', (sx, sy, z0 + 0.04), rng.uniform(0.018, 0.03), mat('embers' if glow else 'stones'), seg=10,
               scale=(1.2, 1.0, 0.6))
    fire = mat('fire')
    for i in range(12):
        w = rng.uniform(0.08, 0.14)
        h = rng.uniform(0.2, 0.36)
        ob = mesh_obj(f'flame_{i}', [(-w / 2, 0, 0), (w / 2, 0, 0), (w / 2, 0, h), (-w / 2, 0, h)], [(0, 1, 2, 3)], fire)
        ob.location = (cx + rng.uniform(-0.2, 0.2), cy + rng.uniform(-0.15, 0.15), z0 + 0.09)
        ob.rotation_euler = (0, 0, rng.uniform(0, math.pi))
        ob.visible_shadow = False
        ob['w_offset'] = rng.uniform(0, 10)
    bpy.ops.object.light_add(type='POINT', location=(cx, cy, z0 + 0.25))
    light = bpy.context.object
    light.name = 'fire_light'
    link(light, 'interior')
    light.data.energy = 18
    light.visible_camera = False
    light.visible_glossy = False
    light.visible_transmission = False
    light.data.color = (1.0, 0.52, 0.2)
    light.data.shadow_soft_size = 0.12
    return light


def tall_units():
    x0, x1 = 5.58, 6.20
    cols = [(Y0, 0.93), (0.93, 1.52), (1.52, 2.10)]
    box('tall_plinth', x0, x1 - 0.06, Y0, 2.10, 0, 0.10, mat('anthracite'))
    box('tall_vent', x1 - 0.061, x1 - 0.058, 1.0, 1.9, 0.02, 0.08, mat('black'))
    g = 0.003
    oak = mat('oakZ')
    for i, (a, b) in enumerate(cols):
        rows = [(0.10, 0.74), (0.74, 1.98), (1.98, CEIL)] if i != 1 else [(0.10, 0.74), (1.98, CEIL)]
        for j, (c, d) in enumerate(rows):
            box(f'tall_door_{i}_{j}', x1 - 0.02, x1, a + g, b - g, c + g, d - g, oak)
        box(f'tall_carcass_{i}', x0, x1 - 0.02, a, b, 0.10, CEIL, oak)
    # built-in oven + coffee machine in the middle column
    a, b = cols[1]
    box('oven_surround', x1 - 0.02, x1, a + g, b - g, 0.74 + g, 1.98 - g, oak)
    bg = mat('blackgloss')
    box('coffee_machine', x1 - 0.005, x1 + 0.012, a + 0.02, b - 0.02, 1.34, 1.79, bg)
    box('oven', x1 - 0.005, x1 + 0.012, a + 0.02, b - 0.02, 0.76, 1.33, bg)
    box('oven_handle', x1 + 0.012, x1 + 0.035, a + 0.06, b - 0.06, 1.26, 1.28, mat('darkmetal'))
    box('oven_display', x1 + 0.012, x1 + 0.013, (a + b) / 2 - 0.05, (a + b) / 2 + 0.05, 1.29, 1.31, MT.emissive('oven_display', '#e8f0ff', 2))
    box('coffee_display', x1 + 0.012, x1 + 0.013, (a + b) / 2 - 0.05, (a + b) / 2 + 0.05, 1.72, 1.75, MT.emissive('coffee_display', '#e8f0ff', 2))
    box('coffee_spout', x1 + 0.012, x1 + 0.08, (a + b) / 2 - 0.04, (a + b) / 2 + 0.04, 1.45, 1.52, mat('darkmetal'))


def base_run(prefix, x0, x1, y0, y1, face, modules, drawers=True):
    """Handleless white base cabinets with a recessed plinth. `face` is the
    front direction: 'N', 'S', 'E' or 'W'."""
    lac = mat('lacquer')
    ins = 0.06
    px0, px1, py0, py1 = x0, x1, y0, y1
    if face == 'N':
        py1 -= ins
    elif face == 'S':
        py0 += ins
    elif face == 'E':
        px1 -= ins
    else:
        px0 += ins
    box(f'{prefix}_plinth', px0, px1, py0, py1, 0, 0.10, mat('anthracite'))
    cx0, cx1, cy0, cy1 = x0, x1, y0, y1
    if face == 'N':
        cy1 -= 0.02
    elif face == 'S':
        cy0 += 0.02
    elif face == 'E':
        cx1 -= 0.02
    else:
        cx0 += 0.02
    box(f'{prefix}_carcass', cx0, cx1, cy0, cy1, 0.10, 0.87, lac)
    along_x = face in ('N', 'S')
    a0, a1 = (x0, x1) if along_x else (y0, y1)
    n = max(1, round((a1 - a0) / modules))
    step = (a1 - a0) / n
    rows = [(0.10, 0.36), (0.36, 0.62), (0.62, 0.87)] if drawers else [(0.10, 0.87)]
    for i in range(n):
        s0, s1 = a0 + i * step + 0.002, a0 + (i + 1) * step - 0.002
        for j, (c, d) in enumerate(rows):
            if face == 'N':
                box(f'{prefix}_front_{i}_{j}', s0, s1, y1 - 0.02, y1, c + 0.002, d - 0.002, lac)
            elif face == 'S':
                box(f'{prefix}_front_{i}_{j}', s0, s1, y0, y0 + 0.02, c + 0.002, d - 0.002, lac)
            elif face == 'E':
                box(f'{prefix}_front_{i}_{j}', x1 - 0.02, x1, s0, s1, c + 0.002, d - 0.002, lac)
            else:
                box(f'{prefix}_front_{i}_{j}', x0, x0 + 0.02, s0, s1, c + 0.002, d - 0.002, lac)


def kitchen():
    tall_units()
    top = mat('worktop')
    # run under the window (south wall), fronts face north
    base_run('k_south', 6.20, X1, Y0, 0.95, 'N', 0.6)
    ct = box('worktop_south', 6.20, X1, Y0, 0.97, 0.87, 0.89, top)
    # sink cut + basin
    sx = sum(KITCHEN_WIN) / 2
    cut = box('sink_cut', sx - 0.3, sx + 0.3, 0.45, 0.85, 0.7, 0.95, None)
    b = ct.modifiers.new('sink', 'BOOLEAN')
    b.object = cut
    b.operation = 'DIFFERENCE'
    cut.hide_render = True
    cut.hide_viewport = True
    k = mat('ceramic_black')
    box('sink_bottom', sx - 0.3, sx + 0.3, 0.45, 0.85, 0.69, 0.70, k)
    box('sink_n', sx - 0.3, sx + 0.3, 0.84, 0.85, 0.69, 0.89, k)
    box('sink_s', sx - 0.3, sx + 0.3, 0.45, 0.46, 0.69, 0.89, k)
    box('sink_e', sx + 0.29, sx + 0.3, 0.45, 0.85, 0.69, 0.89, k)
    box('sink_w', sx - 0.3, sx - 0.29, 0.45, 0.85, 0.69, 0.89, k)
    # black faucet: column + arched spout
    blk = mat('black')
    cylinder('faucet_base', sx, 0.42, 0.89, 1.14, 0.017, blk)
    curve = bpy.data.curves.new('spout', 'CURVE')
    curve.dimensions = '3D'
    sp = curve.splines.new('BEZIER')
    sp.bezier_points.add(2)
    pts = [(sx, 0.42, 1.14), (sx, 0.52, 1.28), (sx, 0.66, 1.12)]
    for p, co in zip(sp.bezier_points, pts):
        p.co = co
        p.handle_left_type = p.handle_right_type = 'AUTO'
    curve.bevel_depth = 0.012
    curve.bevel_resolution = 4
    ob = bpy.data.objects.new('faucet_spout', curve)
    collection('interior').objects.link(ob)
    ob.data.materials.append(blk)
    rod('faucet_lever', (sx + 0.02, 0.42, 1.0), (sx + 0.09, 0.42, 1.02), 0.006, blk)

    # east run (hob), fronts face west
    base_run('k_east', 9.50, X1, 0.95, 2.10, 'W', 0.58)
    box('worktop_east', 9.48, X1, 0.95, 2.12, 0.87, 0.89, top)
    box('hob', 9.56, 10.08, 1.23, 1.83, 0.89, 0.895, mat('blackgloss'))
    # peninsula: white drawers to the kitchen, oak to the dining side,
    # dark waterfall end facing west
    base_run('k_pen', 7.35, X1 - 0.62, 2.10, 2.73, 'S', 0.6)
    box('k_pen_corner', X1 - 0.62, X1, 2.10, 2.73, 0.0, 0.87, mat('lacquer'))
    box('pen_oak', 7.35, X1, 2.73, 2.75, 0.0, 0.89, mat('oakZ'))
    box('pen_end', 7.33, 7.35, 2.08, 2.77, 0.0, 0.91, top)
    box('worktop_pen', 7.33, X1, 2.08, 2.77, 0.89, 0.91, top)
    # wall units along the east wall, two rows, handleless
    lac = mat('lacquer')
    ux0 = X1 - 0.36
    box('uppers_carcass', ux0, X1, Y0, 2.75, 1.47, CEIL, lac)
    n = 4
    for i in range(n):
        a = Y0 + i * (2.75 - Y0) / n + 0.002
        b = Y0 + (i + 1) * (2.75 - Y0) / n - 0.002
        for j, (c, d) in enumerate(((1.47, 2.06), (2.06, CEIL))):
            box(f'upper_door_{i}_{j}', ux0 - 0.02, ux0, a, b, c + 0.002, d - 0.002, lac)
    box('hood_strip', ux0 - 0.02, X1, 1.23, 1.83, 1.44, 1.47, mat('darkmetal'))
    box('led_strip', ux0 + 0.02, ux0 + 0.05, Y0, 2.75, 1.463, 1.468, mat('led'))
    # back-painted glass splashbacks
    sp_ = mat('splash')
    box('splash_east', X1 - 0.008, X1, Y0, 2.75, 0.89, 1.47, sp_)
    box('splash_south_w', 6.20, KITCHEN_WIN[0], Y0, Y0 + 0.008, 0.89, 1.55, sp_)
    box('splash_south_e', KITCHEN_WIN[1], X1, Y0, Y0 + 0.008, 0.89, 1.47, sp_)
    # accessories seen in the photos
    fruit_bowl((9.25, 2.42, 0.91))
    herb_pot((6.62, 0.62, 0.89), 0.075)
    herb_pot((6.85, 0.66, 0.89), 0.07)
    kettle((7.18, 0.62, 0.89))


def fruit_bowl(p):
    x, y, z = p
    sphere('fruit_bowl', (x, y, z + 0.06), 0.14, MT.plain('bowl_glass', '#1e2a2e', rough=0.1, coat=1), scale=(1, 1, 0.45))
    for i in range(22):
        r = 0.013
        a = rng.uniform(0, 2 * math.pi)
        d = rng.uniform(0, 0.08)
        sphere(f'grape_{i}', (x + d * math.cos(a), y + d * math.sin(a), z + 0.13 + rng.uniform(0, 0.05)), r,
               mat('grapes' if i % 3 else 'grapes_green'), seg=12)


def herb_pot(p, r):
    x, y, z = p
    cylinder('herb_pot', x, y, z, z + 0.12, r, mat('ceramic_white'), r_top=r * 1.05)
    for i in range(9):
        a = rng.uniform(0, 2 * math.pi)
        d = rng.uniform(0, r * 0.7)
        sphere('herb_leaves', (x + d * math.cos(a), y + d * math.sin(a), z + 0.16 + rng.uniform(0, 0.1)),
               rng.uniform(0.025, 0.04), mat('leaf'), seg=10)


def kettle(p):
    x, y, z = p
    sphere('kettle_body', (x, y, z + 0.1), 0.075, mat('clear'), scale=(1, 1, 1.3))
    cylinder('kettle_base', x, y, z, z + 0.03, 0.08, mat('ceramic_white'))
    cylinder('kettle_lid', x, y, z + 0.19, z + 0.215, 0.045, mat('ceramic_white'))


# ---------------------------------------------------------------- dining / living

def dining():
    cx, cy = 8.35, 4.20
    L, W = 1.90, 0.95
    box('table_top', cx - L / 2, cx + L / 2, cy - W / 2, cy + W / 2, 0.72, 0.76, mat('tableoak'), bevel=0.004)
    blk = mat('black')
    for sx in (-1, 1):
        for sy in (-1, 1):
            x = cx + sx * (L / 2 - 0.08)
            y = cy + sy * (W / 2 - 0.06)
            box('table_leg', x - 0.025, x + 0.025, y - 0.025, y + 0.025, 0, 0.72, blk)
    for sy in (-1, 1):
        y = cy + sy * (W / 2 - 0.06)
        box('table_rail', cx - L / 2 + 0.08, cx + L / 2 - 0.08, y - 0.02, y + 0.02, 0.68, 0.72, blk)
    for sx in (-1, 1):
        x = cx + sx * (L / 2 - 0.08)
        box('table_rail_end', x - 0.02, x + 0.02, cy - W / 2 + 0.06, cy + W / 2 - 0.06, 0.68, 0.72, blk)
    for i, x in enumerate((cx - 0.62, cx, cx + 0.62)):
        tub_chair(f'chair_s{i}', x, cy - W / 2 - 0.18, 0)
        tub_chair(f'chair_n{i}', x, cy + W / 2 + 0.18, math.pi)
    # centrepiece
    cylinder('vase', cx - 0.1, cy + 0.02, 0.76, 0.98, 0.04, mat('clear'), r_top=0.03)
    for i in range(4):
        tip = (cx - 0.1 + rng.uniform(-0.12, 0.12), cy + 0.02 + rng.uniform(-0.08, 0.08), 1.2 + rng.uniform(0, 0.12))
        rod('cotton_twig', (cx - 0.1, cy + 0.02, 0.95), tip, 0.004, mat('twig'), verts=6)
        for k in range(3):
            t = 0.6 + 0.2 * k
            q = Vector((cx - 0.1, cy + 0.02, 0.95)).lerp(Vector(tip), t)
            sphere('cotton_boll', q + Vector((rng.uniform(-0.03, 0.03), rng.uniform(-0.03, 0.03), 0)), 0.018, mat('cotton'), seg=10)
    for dx in (0.12, 0.22):
        cylinder('candle_glass', cx + dx, cy - 0.05 + dx * 0.4, 0.76, 0.86, 0.035, mat('clear'))
        cylinder('candle', cx + dx, cy - 0.05 + dx * 0.4, 0.765, 0.81, 0.028, mat('ceramic_white'))
    cylinder('stone_dish', cx + 0.02, cy + 0.14, 0.76, 0.785, 0.08, mat('ceramic_white'))
    for i in range(5):
        sphere('stone', (cx + 0.02 + rng.uniform(-0.04, 0.04), cy + 0.14 + rng.uniform(-0.04, 0.04), 0.8), 0.022,
               mat('stones'), seg=12, scale=(1.2, 1, 0.7))
    # linear pendant with five spots
    bar_z = 1.86
    box('pendant_bar', cx - 0.72, cx + 0.72, cy - 0.015, cy + 0.015, bar_z, bar_z + 0.03, blk)
    for dx in (-0.55, 0.55):
        rod('pendant_rod', (cx + dx, cy, bar_z + 0.03), (cx + dx, cy, CEIL), 0.005, blk, verts=8)
        cylinder('pendant_canopy', cx + dx, cy, CEIL - 0.02, CEIL, 0.05, blk)
    for i, dx in enumerate((-0.56, -0.28, 0.0, 0.28, 0.56)):
        cylinder(f'pendant_spot_{i}', cx + dx, cy, bar_z - 0.14, bar_z, 0.033, blk)
        cylinder(f'pendant_lens_{i}', cx + dx, cy, bar_z - 0.142, bar_z - 0.139, 0.026, mat('darkmetal'))


def tub_chair(name, x, y, rot):
    """Upholstered dining chair with a wrap-around back and black legs."""
    fab = mat('chair')
    g = []
    seat = box(f'{name}_seat', -0.23, 0.23, -0.22, 0.22, 0.43, 0.50, fab, bevel=0.03, segments=4)
    g.append(seat)
    bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=0.25, depth=0.34, end_fill_type='NOTHING', location=(0, 0, 0.66))
    shell_ = bpy.context.object
    shell_.name = f'{name}_back'
    link(shell_, 'interior')
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(shell_.data)
    for v in [v for v in bm.verts if v.co.y > 0.02]:  # keep the half behind the sitter
        bm.verts.remove(v)
    bm.to_mesh(shell_.data)
    bm.free()
    shell_.scale = (1.0, 0.9, 1.0)
    sol = shell_.modifiers.new('thick', 'SOLIDIFY')
    sol.thickness = 0.05
    smooth(shell_, 1)
    shell_.data.materials.append(fab)
    shell_.location = (0, 0.0, 0.66)
    g.append(shell_)
    blk = mat('black')
    for sx in (-1, 1):
        for sy in (-1, 1):
            g.append(rod(f'{name}_leg', (sx * 0.17, sy * 0.15, 0.43), (sx * 0.2, sy * 0.19, 0.0), 0.011, blk))
    root = bpy.data.objects.new(name, None)
    collection('interior').objects.link(root)
    for ob in g:
        ob.parent = root
    root.location = (x, y, 0)
    root.rotation_euler = (0, 0, rot + rng.uniform(-0.05, 0.05))
    # the back must face away from the table
    return root


def living():
    fab = mat('sofa')
    # L-shaped sectional against the feature wall, chaise towards the door
    xb, xf = X1 - 0.02, 9.12
    y0, y1 = 5.15, 7.55
    box('sofa_base', xf, xb, y0, y1, 0.07, 0.30, fab, bevel=0.03, segments=3)
    box('sofa_base_chaise', 8.10, xf + 0.05, 6.52, y1, 0.07, 0.30, fab, bevel=0.03, segments=3)
    box('sofa_foot_strip', 8.14, xb - 0.04, 5.19, y1 - 0.04, 0.0, 0.07, mat('black'))
    box('sofa_seat_a', xf + 0.01, xb - 0.24, y0 + 0.26, 6.50, 0.29, 0.44, fab, bevel=0.06, segments=5)
    box('sofa_seat_b', 8.12, xb - 0.24, 6.52, y1 - 0.02, 0.29, 0.44, fab, bevel=0.06, segments=5)
    box('sofa_arm', xf, xb, y0, y0 + 0.27, 0.07, 0.60, fab, bevel=0.07, segments=5)
    for i, (a, b) in enumerate(((5.43, 6.16), (6.16, 6.87), (6.87, 7.53))):
        cb = box(f'sofa_back_{i}', xb - 0.25, xb, a + 0.01, b - 0.01, 0.30, 0.82, fab, bevel=0.08, segments=5)
        cb.rotation_euler = (0, math.radians(7), 0)
    # cushions and throw as in the photos
    pillow('pillow_0', (xb - 0.33, 5.62, 0.62), mat('pillow_beige'), 0.44)
    pillow('pillow_1', (xb - 0.33, 6.12, 0.62), mat('pillow_grey'), 0.44)
    pillow('pillow_2', (xb - 0.33, 6.95, 0.62), striped_pillow_mat(), 0.44)
    pillow('pillow_3', (xb - 0.33, 7.35, 0.6), mat('pillow_light'), 0.42)
    thr = box('throw', 8.35, 9.05, 6.62, 7.46, 0.44, 0.47, mat('throw'), bevel=0.012, segments=2)
    thr.rotation_euler = (0, 0, 0.06)
    box('throw_fold', 8.3, 8.36, 6.66, 7.40, 0.30, 0.46, mat('throw'), bevel=0.012, segments=2)
    box('magazine', 8.5, 8.78, 6.98, 7.2, 0.47, 0.476, mat('book1'))
    # rug and round coffee table
    box('rug', 6.95, 9.18, 4.95, 7.52, 0.0, 0.012, mat('rug'), bevel=0.004, segments=2)
    tx, ty = 8.30, 5.92
    top = cylinder('coffee_top', tx, ty, 0.38, 0.405, 0.50, mat('anthracite'), verts=64)
    blk = mat('black')
    for i in range(3):
        a = i * 2 * math.pi / 3 + 0.3
        rod('coffee_leg', (tx + 0.38 * math.cos(a), ty + 0.38 * math.sin(a), 0.38),
            (tx + 0.18 * math.cos(a + 1.2), ty + 0.18 * math.sin(a + 1.2), 0.01), 0.008, blk)
    ring = bpy.ops.mesh.primitive_torus_add(major_radius=0.2, minor_radius=0.007, location=(tx, ty, 0.012))
    link(bpy.context.object, 'interior')
    bpy.context.object.data.materials.append(blk)
    box('tray', tx - 0.2, tx + 0.2, ty - 0.12, ty + 0.12, 0.405, 0.42, mat('anthracite'), bevel=0.01)
    for i in range(6):
        box('cake', tx - 0.16 + i * 0.055, tx - 0.12 + i * 0.055, ty - 0.05, ty + 0.05, 0.42, 0.45, mat('cake'), bevel=0.006)
    for p in ((tx - 0.3, ty + 0.15), (tx + 0.28, ty - 0.2)):
        cylinder('saucer', p[0], p[1], 0.405, 0.41, 0.06, mat('ceramic_black'))
        cylinder('cup', p[0], p[1], 0.41, 0.46, 0.032, mat('ceramic_black'), r_top=0.037)
    # paintings on the feature wall
    for name, yc, m in (('painting_stripe', 6.88, mat('paintA')), ('painting_split', 5.78, mat('paintB'))):
        w, h, zc = 0.92, 1.26, 1.66
        box(f'{name}_frame', X1 - 0.05, X1 - 0.012, yc - w / 2 - 0.02, yc + w / 2 + 0.02, zc - h / 2 - 0.02, zc + h / 2 + 0.02, mat('black'))
        box(name, X1 - 0.052, X1 - 0.03, yc - w / 2, yc + w / 2, zc - h / 2, zc + h / 2, m)
    # TV wall: oak panelling, floating black unit, TV and decor
    for i in range(4):
        a = 4.85 + i * (7.62 - 4.85) / 4
        b = 4.85 + (i + 1) * (7.62 - 4.85) / 4
        box(f'tv_panel_{i}', 5.65, 5.672, a + 0.0015, b - 0.0015, 0.0, CEIL, mat('oakZ'))
    box('tv_unit', 5.672, 6.10, 5.05, 7.45, 0.14, 0.50, mat('anthracite'))
    for i in range(3):
        a = 5.05 + i * 0.8
        box(f'tv_unit_door_{i}', 6.10, 6.105, a + 0.002, a + 0.8 - 0.002, 0.142, 0.498, mat('anthracite'))
    box('tv_backboard', 5.672, 5.69, 5.05, 7.45, 0.50, 0.78, mat('anthracite'))
    box('tv_body', 5.68, 5.72, 6.25 - 0.84, 6.25 + 0.84, 0.93, 1.88, mat('black'))
    box('tv_screen', 5.72, 5.722, 6.25 - 0.83, 6.25 + 0.83, 0.94, 1.87, mat('screen'))
    cylinder('pampas_vase', 5.86, 7.25, 0.50, 0.74, 0.055, mat('ceramic_white'), r_top=0.045)
    for i in range(6):
        tip = Vector((5.86 + rng.uniform(-0.12, 0.12), 7.25 + rng.uniform(-0.15, 0.15), 1.02 + rng.uniform(0, 0.12)))
        rod('pampas_stem', (5.86, 7.25, 0.72), tip, 0.003, mat('twig'), verts=6)
        pl = sphere('pampas_plume', tip + Vector((0, 0, 0.06)), 0.035, mat('pampas'), seg=10, scale=(1, 1, 3.2))
        pl.rotation_euler = (rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3), 0)
    for i, (h, m) in enumerate(((0.035, 'book1'), (0.03, 'book2'), (0.04, 'book3'))):
        z = 0.50 + sum((0.035, 0.03, 0.04)[:i])
        box('book', 5.72, 5.98, 5.25, 5.45, z, z + h, mat(m), bevel=0.003)


def pillow(name, loc, m, size):
    ob = box(name, -0.08, 0.08, -size / 2, size / 2, -size / 2, size / 2, m, bevel=0.07, segments=6)
    ob.location = loc
    ob.rotation_euler = (rng.uniform(-0.1, 0.1), math.radians(18), rng.uniform(-0.15, 0.15))
    return ob


def striped_pillow_mat():
    n = MT.Nodes('pillow_striped')
    tc = n.new('ShaderNodeTexCoord', (-900, 0))
    w = n.new('ShaderNodeTexWave', (-700, 0))
    w.bands_direction = 'Z'
    w.wave_profile = 'SAW'
    w.inputs['Scale'].default_value = 26
    n.link(tc, 'Object', w, 'Vector')
    r = n.ramp(w, 'Fac', [(0.0, '#e6e0d4'), (0.62, '#e6e0d4'), (0.64, '#2a2826'), (0.8, '#2a2826'), (0.82, '#e6e0d4')])
    n.link(r, 0, n.bsdf, 'Base Color')
    n.set(Roughness=0.95, **{'Sheen Weight': 0.6})
    return n.mat


# ---------------------------------------------------------------- blinds, lights

def blind(name, a, b, fixed, face, top=2.62, bottom=2.22, depth=0.05):
    """Wooden venetian blind, partly lowered, hung in front of the opening.
    face: 'S' (north wall, room to the south), 'W' (east wall), 'N' (south wall)."""
    slat_h = 0.042
    n = int((top - bottom) / slat_h)
    m = mat('blind')

    def piece(nm, u0, u1, z0, z1, d0, d1):
        if face == 'S':
            return box(nm, u0, u1, fixed - d1, fixed - d0, z0, z1, m)
        if face == 'N':
            return box(nm, u0, u1, fixed + d0, fixed + d1, z0, z1, m)
        return box(nm, fixed - d1, fixed - d0, u0, u1, z0, z1, m)

    piece(f'{name}_head', a, b, top, top + 0.05, 0.02, 0.07)
    for i in range(n):
        z = top - (i + 1) * slat_h
        s = piece(f'{name}_slat_{i}', a, b, z, z + 0.004, 0.0, 0.05)
        ax = 'X' if face in ('S', 'N') else 'Y'
        tilt = math.radians(12) * (1 if face != 'N' else -1)
        s.rotation_euler = (tilt, 0, 0) if ax == 'X' else (0, tilt, 0)
    piece(f'{name}_bottom', a, b, bottom - 0.02, bottom, 0.0, 0.06)
    tape = MT.plain('blind_tape', '#bba789', rough=0.9)
    for u in (a + 0.12, (a + b) / 2, b - 0.12):
        piece(f'{name}_tape', u - 0.012, u + 0.012, bottom, top, 0.0, 0.004).data.materials[0] = tape
        piece(f'{name}_tape', u - 0.012, u + 0.012, bottom, top, 0.046, 0.05).data.materials[0] = tape


def blinds():
    xa, xb = SLIDER
    mid = (xa + xb) / 2
    blind('blind_slider_w', xa - 0.08, mid, Y1, 'S', bottom=2.26)
    blind('blind_slider_e', mid, xb + 0.08, Y1, 'S', bottom=2.26)
    blind('blind_dining', EAST_WIN[0] - 0.08, EAST_WIN[1] + 0.08, X1, 'W', bottom=1.98)
    blind('blind_kitchen', KITCHEN_WIN[0] - 0.08, KITCHEN_WIN[1] + 0.08, Y0, 'N', bottom=2.08)


def ceiling_fittings():
    wht = MT.plain('spot_white', '#f5f5f3', rough=0.35)
    lens = MT.plain('spot_lens_off', '#3a3a3a', rough=0.2, metal=0.6)
    # surface downlights over the kitchen
    for x in (6.95, 7.95, 8.95):
        for y in (0.95, 1.9):
            cylinder('downlight', x, y, CEIL - 0.13, CEIL, 0.045, wht)
            cylinder('downlight_lens', x, y, CEIL - 0.132, CEIL - 0.128, 0.035, lens)
    # adjustable surface spots: short stem and an angled cylindrical head
    for i, (x, y, yaw) in enumerate(((6.6, 7.2, 0.5), (6.6, 5.4, -0.4), (8.1, 7.3, 2.6), (8.1, 5.0, 3.6), (7.2, 3.5, 1.2), (9.3, 3.5, 2.2))):
        cylinder('spot_base', x, y, CEIL - 0.015, CEIL, 0.04, wht)
        cylinder('spot_stem', x, y, CEIL - 0.12, CEIL, 0.012, wht)
        d = Vector((math.cos(yaw) * math.sin(0.8), math.sin(yaw) * math.sin(0.8), -math.cos(0.8)))
        c = Vector((x, y, CEIL - 0.13))
        rod('spot_head', c - d * 0.06, c + d * 0.08, 0.036, wht, verts=24)
        rod('spot_lens', c + d * 0.079, c + d * 0.082, 0.029, lens, verts=24)


# ---------------------------------------------------------------- garden

def garden():
    # lawn ground slab, with a hole for the pool (coping x 1.6-8.0, y 12.35-16.15)
    for i, (a, b, c, d) in enumerate(((-300, 300, -300, 12.35), (-300, 300, 16.15, 300), (-300, 1.6, 12.35, 16.15), (8.0, 300, 12.35, 16.15))):
        box(f'lawn_{i}', a, b, c, d, GROUND - 0.2, GROUND, mat('lawn'), coll='garden')
    # paving: strip in front of the deck and pool coping
    box('paving_strip', 2.0, 11.2, 11.8, 12.35, GROUND, GROUND + 0.02, mat('paving'), coll='garden')
    px0, px1, py0, py1 = 2.0, 7.6, 12.75, 15.75
    for nm, a in (('coping_s', (px0 - 0.4, px1 + 0.4, py0 - 0.4, py0)), ('coping_n', (px0 - 0.4, px1 + 0.4, py1, py1 + 0.4)),
                  ('coping_w', (px0 - 0.4, px0, py0, py1)), ('coping_e', (px1, px1 + 0.4, py0, py1))):
        box(nm, *a, GROUND, GROUND + 0.04, mat('paving'), coll='garden')
    box('pool_basin_floor', px0, px1, py0, py1, GROUND - 1.45, GROUND - 1.4, mat('pooltile'), coll='garden')
    for nm, a in (('pool_wall_s', (px0, px1, py0, py0 + 0.02)), ('pool_wall_n', (px0, px1, py1 - 0.02, py1)),
                  ('pool_wall_w', (px0, px0 + 0.02, py0, py1)), ('pool_wall_e', (px1 - 0.02, px1, py0, py1))):
        box(nm, *a, GROUND - 1.45, GROUND, mat('pooltile'), coll='garden')
    box('pool_water', px0, px1, py0, py1, GROUND - 1.45, GROUND - 0.1, mat('water'), coll='garden')
    # sun lounger by the pool: low white frame, flat mattress, raised back
    lx0, lx1, ly0, ly1 = 8.65, 9.35, 13.3, 15.3
    wht = mat('lounger')
    box('lounger_frame', lx0, lx1, ly0, ly1, GROUND + 0.1, GROUND + 0.26, wht, coll='garden', bevel=0.02)
    box('lounger_mattress', lx0 + 0.02, lx1 - 0.02, ly0 + 0.02, ly1 - 0.62, GROUND + 0.26, GROUND + 0.33, mat('cushion_white'), coll='garden', bevel=0.03, segments=4)
    back = box('lounger_back', lx0 + 0.02, lx1 - 0.02, -0.3, 0.3, -0.035, 0.035, mat('cushion_white'), coll='garden', bevel=0.03, segments=4)
    back.rotation_euler = (math.radians(-38), 0, 0)
    back.location = ((lx0 + lx1) / 2, ly1 - 0.36, GROUND + 0.48)
    for x in (lx0 + 0.05, lx1 - 0.05):
        box('lounger_foot', x - 0.03, x + 0.03, ly0 + 0.08, ly1 - 0.08, GROUND, GROUND + 0.1, mat('steel'), coll='garden')
    # outdoor furniture under the pergola
    tx, ty = 8.75, 9.75
    box('odt_top', tx - 0.8, tx + 0.8, ty - 0.45, ty + 0.45, 0.72, 0.75, mat('anthracite'), coll='garden')
    for sx in (-1, 1):
        for sy in (-1, 1):
            box('odt_leg', tx + sx * 0.72 - 0.02, tx + sx * 0.72 + 0.02, ty + sy * 0.37 - 0.02, ty + sy * 0.37 + 0.02, 0, 0.72, mat('black'), coll='garden')
    for sx in (-0.4, 0.4):
        for sy, rot in ((-0.72, 0), (0.72, math.pi)):
            wire_chair((tx + sx, ty + sy), rot)
    # lounge set at the west end of the deck
    lx, ly = 3.55, 9.9
    box('olounge_frame', lx - 0.45, lx + 0.45, ly - 1.0, ly + 1.0, 0.05, 0.38, mat('rattan'), coll='garden', bevel=0.02)
    box('olounge_seat', lx - 0.4, lx + 0.4, ly - 0.95, ly + 0.95, 0.38, 0.5, mat('cushion_out'), coll='garden', bevel=0.05, segments=4)
    box('olounge_back', lx - 0.45, lx - 0.25, ly - 1.0, ly + 1.0, 0.38, 0.85, mat('cushion_out'), coll='garden', bevel=0.06, segments=4)
    box('olounge_table', lx + 0.9, lx + 1.6, ly - 0.4, ly + 0.4, 0.05, 0.42, mat('rattan'), coll='garden', bevel=0.02)
    # concrete planters (grass added in vegetation())
    for i, y in enumerate((8.6, 10.2)):
        box(f'planter_{i}', 1.55, 2.25, y, y + 1.3, GROUND, 0.35, mat('paving'), coll='garden')
        box(f'planter_soil_{i}', 1.6, 2.2, y + 0.05, y + 1.25, 0.3, 0.33, mat('soil'), coll='garden')
    fences()


def wire_chair(p, rot):
    blk = mat('black')
    x, y = p
    root = bpy.data.objects.new('wire_chair', None)
    collection('garden').objects.link(root)
    parts = [box('wc_seat', -0.23, 0.23, -0.22, 0.22, 0.44, 0.47, mat('rattan'), coll='garden', bevel=0.01)]
    for sx in (-1, 1):
        parts.append(rod('wc_leg', (sx * 0.2, -0.18, 0.44), (sx * 0.22, -0.22, 0.0), 0.01, blk, coll='garden'))
        parts.append(rod('wc_leg', (sx * 0.2, 0.18, 0.44), (sx * 0.22, 0.24, 0.0), 0.01, blk, coll='garden'))
    back = box('wc_back', -0.22, 0.22, 0.18, 0.22, 0.47, 0.85, mat('rattan'), coll='garden', bevel=0.01)
    back.rotation_euler = (math.radians(-10), 0, 0)
    parts.append(back)
    for ob in parts:
        ob.parent = root
    root.location = (x, y, 0)
    root.rotation_euler = (0, 0, rot)


def fences():
    fm = mat('fence')
    # north and east boundary: horizontal-board fence, gabion stretch on the east
    def run(name, a, b, fixed, along_x):
        length = abs(b - a)
        for k in range(12):
            z0 = GROUND + 0.05 + k * 0.135
            if along_x:
                box(f'{name}_board', a, b, fixed, fixed + 0.02, z0, z0 + 0.115, fm, coll='garden')
            else:
                box(f'{name}_board', fixed, fixed + 0.02, a, b, z0, z0 + 0.115, fm, coll='garden')
        n = int(length / 2.4)
        for i in range(n + 1):
            u = a + i * length / n
            if along_x:
                box(f'{name}_post', u - 0.04, u + 0.04, fixed + 0.02, fixed + 0.1, GROUND, GROUND + 1.72, fm, coll='garden')
            else:
                box(f'{name}_post', fixed + 0.02, fixed + 0.1, u - 0.04, u + 0.04, GROUND, GROUND + 1.72, fm, coll='garden')
    run('fence_n', -8.0, 20.0, 24.0, True)
    run('fence_e', 6.0, 24.0, 20.0, False)
    run('fence_w', -6.0, 24.0, -8.0, False)
    g = box('gabion', 20.0, 20.5, -6.0, 6.0, GROUND, GROUND + 1.55, mat('gabion'), coll='garden')
    g2 = box('gabion_cap', 19.98, 20.52, -6.0, 6.0, GROUND + 1.55, GROUND + 1.57, mat('darkmetal'), coll='garden')


def vegetation():
    """Trees, shrubs, planter grasses and the lawn, as prototype meshes placed
    by collection instances (see vegetation.py)."""
    protos = collection('protos')
    lc = bpy.context.view_layer.layer_collection.children.get('protos')
    lc.exclude = True
    birch_m = [mat('birch'), mat('foliage')]
    pine_m = [mat('pinebark'), mat('foliage_dark')]
    birches = [VG.prototype(f'birch_{k}', lambda k=k: VG.birch(100 + k), birch_m, protos) for k in range(3)]
    pines = [VG.prototype(f'pine_{k}', lambda k=k: VG.pine(200 + k), pine_m, protos) for k in range(3)]
    thujas = [VG.prototype(f'thuja_{k}', lambda k=k: VG.thuja(300 + k), [mat('pinebark'), mat('thuja')], protos) for k in range(2)]
    shrubs = [VG.prototype(f'shrub_{k}', lambda k=k: VG.shrub(400 + k), [mat('twig'), mat('foliage')], protos) for k in range(2)]
    grasses = [VG.prototype(f'orn_grass_{k}', lambda k=k: VG.ornamental_grass(500 + k), [mat('twig'), mat('grass_orn')], protos) for k in range(2)]
    tile = VG.prototype('lawn_tile', lambda: VG.lawn_tile(600, size=0.5), [mat('lawn'), mat('grass')], protos)

    def put(kind, protos_, x, y, height, z=GROUND):
        proto = rng.choice(protos_)
        VG.place(kind, proto, (x, y, z), rng.uniform(0, 2 * math.pi), height / proto[1], 'garden_v')

    collection('garden_v')
    # garden trees (birches frame the house as in the renders, pines behind)
    for x, y, h in ((13.2, 4.2, 11), (15.8, 11.0, 12.5), (-3.0, 13.0, 10), (11.5, 21.0, 12), (1.5, 21.8, 11),
                    (17.8, 17.0, 13), (-4.5, 3.0, 9.5), (6.0, 26.5, 13), (3.0, -7.5, 11), (8.5, -9.0, 13), (6.0, -14.0, 12)):
        put('birch', birches, x, y, h)
    for i in range(16):
        put('pine', pines, -10 + i * 2.2 + rng.uniform(-0.6, 0.6), 27.5 + rng.uniform(0, 5), rng.uniform(15, 21))
    for i in range(9):
        put('pine', pines, 24 + rng.uniform(0, 5), -4 + i * 3.2, rng.uniform(15, 20))
    for x, y, h in ((13.0, -6.5, 17), (-2.5, -8.0, 16), (11.0, -12.5, 18)):
        put('pine', pines, x, y, h)
    # thuja hedges along the north, east and front boundaries
    for i in range(18):
        put('thuja', thujas, -7.2 + i * 1.5 + rng.uniform(-0.2, 0.2), 23.2, rng.uniform(3.2, 4.4))
    for i in range(11):
        put('thuja', thujas, 19.2, 7.5 + i * 1.5, rng.uniform(3.2, 4.2))
    for i in range(10):
        put('thuja', thujas, -3.0 + i * 1.6, -4.6, rng.uniform(2.6, 3.4))
    # neighbouring woodland all around, 35-110 m out
    for i in range(160):
        a = rng.uniform(0, 2 * math.pi)
        d = rng.uniform(35, 110)
        x, y = 5 + d * math.cos(a), 4 + d * math.sin(a)
        if rng.random() < 0.6:
            put('far_pine', pines, x, y, rng.uniform(16, 24))
        else:
            put('far_birch', birches, x, y, rng.uniform(11, 16))
    # shrubs along the east side of the house
    for i in range(7):
        put('shrub', shrubs, 11.3 + rng.uniform(-0.2, 0.3), 0.8 + i * 1.1, rng.uniform(0.9, 1.2))
    # ornamental grass in the two concrete planters at the west end of the deck
    for y0 in (8.6, 10.2):
        for k in range(3):
            put('planter_grass', grasses, 1.9 + rng.uniform(-0.1, 0.1), y0 + 0.25 + k * 0.4, rng.uniform(0.8, 1.0), z=0.35)
    # lawn: 0.5 m tiles, randomly turned, over all the lawn near the house
    holes = [(-0.1, 10.8, -0.9, 11.85),   # house, terrace deck and its step
             (2.0, 11.2, 11.8, 12.35),    # paving strip
             (1.6, 8.0, 12.35, 16.15),    # pool and coping
             (8.65, 9.35, 13.3, 15.3),    # lounger
             (1.55, 2.25, 8.6, 11.5)]     # planters
    step = 0.5
    for i in range(int(26 / step)):
        for j in range(int(26 / step)):
            x0, y0 = -5 + i * step, 1 + j * step
            cx, cy = x0 + step / 2, y0 + step / 2
            touching = [h for h in holes if h[0] < x0 + step and x0 < h[1] and h[2] < y0 + step and y0 < h[3]]
            if not touching:
                VG.place('lawn_tile', tile, (cx, cy, GROUND), rng.randrange(4) * math.pi / 2, 1.0, 'garden_v')
                continue
            if any(h[0] <= x0 and x0 + step <= h[1] and h[2] <= y0 and y0 + step <= h[3] for h in touching):
                continue  # fully covered
            # edge tile: its own mesh, blades clipped 3 cm clear of the hole

            def keep(x, y, cx=cx, cy=cy, touching=touching):
                ok = np.ones(len(x), bool)
                for a, b, c, d in touching:
                    ok &= ~((x + cx > a - 0.03) & (x + cx < b + 0.03) & (y + cy > c - 0.03) & (y + cy < d + 0.03))
                return ok
            B, _ = VG.lawn_tile(rng.randrange(10 ** 6), size=step, keep=keep)
            if B is None:
                continue
            me = B.mesh(f'lawn_edge_{i}_{j}')
            me.materials.append(mat('lawn'))
            me.materials.append(mat('grass'))
            ob = bpy.data.objects.new(f'lawn_edge_{i}_{j}', me)
            ob.location = (cx, cy, GROUND)
            collection('garden_v').objects.link(ob)


# ---------------------------------------------------------------- world & lights

SUN_AZIMUTH = math.radians(-50)  # from north towards east: north-west, so it
SUN_ELEVATION = math.radians(38)  # falls through the terrace door as in the photos


def world_and_sun():
    sc = bpy.context.scene
    w = bpy.data.worlds.new('sky')
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    sky = nt.nodes.new('ShaderNodeTexSky')
    sky.sky_type = 'MULTIPLE_SCATTERING'
    sky.sun_disc = False
    sky.sun_elevation = SUN_ELEVATION
    sky.sun_rotation = math.pi / 2 - SUN_AZIMUTH  # Blender measures from +x
    for k, v in (('altitude', 150), ('air_density', 1.0), ('aerosol_density', 0.5), ('ozone_density', 1.0)):
        if hasattr(sky, k):
            setattr(sky, k, v)
    bg = nt.nodes['Background']
    bg.inputs['Strength'].default_value = 0.30
    # fair-weather cumulus: noise on a cloud deck projected along the view ray
    geo = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(geo.outputs['Generated'], sep.inputs[0])
    zc = nt.nodes.new('ShaderNodeMath')
    zc.operation = 'MAXIMUM'
    zc.inputs[1].default_value = 0.04
    nt.links.new(sep.outputs['Z'], zc.inputs[0])
    proj = nt.nodes.new('ShaderNodeVectorMath')
    proj.operation = 'DIVIDE'
    nt.links.new(geo.outputs['Generated'], proj.inputs[0])
    comb = nt.nodes.new('ShaderNodeCombineXYZ')
    for k in 'XYZ':
        nt.links.new(zc.outputs[0], comb.inputs[k])
    nt.links.new(comb.outputs[0], proj.inputs[1])
    cl = nt.nodes.new('ShaderNodeTexNoise')
    cl.inputs['Scale'].default_value = 1.1
    cl.inputs['Detail'].default_value = 9
    cl.inputs['Roughness'].default_value = 0.58
    nt.links.new(proj.outputs[0], cl.inputs['Vector'])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.56
    ramp.color_ramp.elements[1].position = 0.72
    nt.links.new(cl.outputs['Fac'], ramp.inputs['Fac'])
    fade = nt.nodes.new('ShaderNodeMapRange')  # thin out towards the horizon
    fade.inputs['From Min'].default_value = 0.0
    fade.inputs['From Max'].default_value = 0.25
    nt.links.new(sep.outputs['Z'], fade.inputs['Value'])
    amt = nt.nodes.new('ShaderNodeMath')
    amt.operation = 'MULTIPLY'
    nt.links.new(ramp.outputs['Color'], amt.inputs[0])
    nt.links.new(fade.outputs['Result'], amt.inputs[1])
    cloud_col = nt.nodes.new('ShaderNodeMix')
    cloud_col.data_type = 'RGBA'
    nt.links.new(amt.outputs[0], cloud_col.inputs['Factor'])
    nt.links.new(sky.outputs[0], cloud_col.inputs[6])
    cloud_col.inputs[7].default_value = (2.2, 2.2, 2.25, 1)
    nt.links.new(cloud_col.outputs[2], bg.inputs[0])
    # sun lamp matching the sky's sun position
    bpy.ops.object.light_add(type='SUN')
    sun = bpy.context.object
    sun.name = 'sun'
    link(sun, 'lights')
    d = Vector((math.sin(SUN_AZIMUTH) * math.cos(SUN_ELEVATION), math.cos(SUN_AZIMUTH) * math.cos(SUN_ELEVATION), math.sin(SUN_ELEVATION)))
    sun.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    sun.data.energy = 4.2
    sun.data.angle = math.radians(0.8)
    sun.data.color = (1.0, 0.96, 0.9)


def portals():
    """Area-light portals in the day-zone openings guide sky sampling."""
    def portal(name, loc, rot, sx, sy):
        bpy.ops.object.light_add(type='AREA', location=loc, rotation=rot)
        p = bpy.context.object
        p.name = name
        link(p, 'lights')
        p.data.shape = 'RECTANGLE'
        p.data.size, p.data.size_y = sx, sy
        p.data.cycles.is_portal = True
    xa, xb = SLIDER
    portal('portal_slider', ((xa + xb) / 2, HY - 0.02, OPEN_HEAD / 2), (math.radians(-90), 0, 0), xb - xa, OPEN_HEAD)
    portal('portal_dining', (HX - 0.02, sum(EAST_WIN) / 2, 1.41), (0, math.radians(90), 0), 1.84, EAST_WIN[1] - EAST_WIN[0])
    portal('portal_kitchen', (sum(KITCHEN_WIN) / 2, 0.02, 1.63), (math.radians(90), 0, 0), KITCHEN_WIN[1] - KITCHEN_WIN[0], 1.45)


# ---------------------------------------------------------------- main

def main(obj_path, out_path):
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob)
    import_exterior(obj_path)
    slider_door()
    shell()
    fireplace()
    kitchen()
    dining()
    living()
    blinds()
    ceiling_fittings()
    garden()
    vegetation()
    world_and_sun()
    portals()
    bpy.ops.wm.save_as_mainfile(filepath=out_path)
    print('saved', out_path, len(bpy.data.objects), 'objects')


if __name__ == '__main__':
    main(sys.argv[-2], sys.argv[-1])
