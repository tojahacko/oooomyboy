"""Render check views that mirror the reference photos.

    python3 walkthrough/preview.py <scene.blend> <out_dir> [view ...] [--size 960x540] [--samples 48]
"""
import math
import os
import sys
import time

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render_setup import configure  # noqa: E402

# name: (eye, target, focal mm) in plan metres; each matches a reference photo
VIEWS = {
    'living_overview': ((6.15, 4.9, 1.35), (10.1, 6.9, 1.2), 17),   # interior_living_overview
    'sofa_art_wall': ((6.05, 6.15, 1.3), (10.1, 6.1, 1.25), 18),     # interior_sofa_art_wall
    'living_to_kitchen': ((9.2, 7.45, 1.35), (7.2, 0.5, 1.05), 17),  # interior_living_to_kitchen
    'tv_wall': ((9.35, 6.1, 1.3), (5.6, 5.75, 1.1), 18),             # interior_tv_wall
    'dining_fireplace': ((8.0, 5.9, 1.4), (8.2, 0.4, 1.0), 18),      # interior_dining_fireplace
    'dining_window': ((6.15, 4.4, 1.4), (10.1, 4.25, 1.2), 18),      # interior_dining_window
    'kitchen_window': ((8.3, 3.7, 1.45), (8.4, 0.3, 1.1), 18),       # interior_kitchen_window
    'kitchen_to_living': ((8.6, 0.85, 1.45), (6.9, 7.9, 1.1), 17),   # interior_kitchen_to_living
    'terrace_door': ((9.0, 3.6, 1.3), (7.7, 7.9, 1.2), 18),          # interior_terrace_door
    'garden': ((9.2, 19.5, 1.6), (6.8, 8.0, 2.6), 20),               # view_rear_east (eye level)
    'walk_start': ((11.1, 20.6, 1.4), (8.75, 16.2, 0.87), 17),       # first frame of the walkthrough
    'deck_approach': ((8.2, 12.0, 1.41), (5.85, 7.6, 0.9), 17),
    'fire_close': ((7.1, 4.0, 1.05), (6.05, 2.85, 0.68), 40),
}


def look(cam, eye, target):
    cam.location = eye
    d = Vector(target) - Vector(eye)
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def main():
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    size, samples = (960, 540), 48
    rest = []
    it = iter(args)
    for a in it:
        if a == '--size':
            w, h = next(it).split('x')
            size = (int(w), int(h))
        elif a == '--samples':
            samples = int(next(it))
        else:
            rest.append(a)
    blend, out_dir, *names = rest
    names = names or list(VIEWS)
    bpy.ops.wm.open_mainfile(filepath=blend)
    sc = bpy.context.scene
    configure(sc, size, samples)
    cam_data = bpy.data.cameras.new('preview')
    cam = bpy.data.objects.new('preview', cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam_data.sensor_width = 36
    os.makedirs(out_dir, exist_ok=True)
    for n in names:
        eye, tgt, f = VIEWS[n]
        look(cam, eye, tgt)
        cam_data.lens = f
        sc.view_settings.exposure = 0.1 if n in ('garden', 'walk_start', 'deck_approach') else 2.0
        sc.render.filepath = os.path.join(out_dir, f'{n}.png')
        t = time.time()
        bpy.ops.render.render(write_still=True)
        print(f'{n}: {time.time() - t:.1f}s', flush=True)


if __name__ == '__main__':
    main()
