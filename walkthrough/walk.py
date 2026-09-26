"""Render the one-take walkthrough of Zielistki 34.

    python3 walkthrough/walk.py <scene.blend> <frames_dir> [--size 1280x720] [--fps 24]
                                [--samples 16] [--ss 2] [--start N] [--end N] [--step N]
                                [--frames a,b,c] [--threshold T] [--check]

Frame f is rendered at exactly t = f / fps. With --ss 2 each frame is path
traced at 2x the output size (2560x1440) and box-filtered down, with a static
vignette applied in float before the single 8-bit rounding.

The camera is a stabilised gimbal carried at eye height: it walks through the
garden, steps onto the terrace, enters through the open half of the sliding
door and continues through the living room and dining area into the kitchen.
Position and view direction are smooth splines through hand-placed keys;
every key was checked against the furniture and walls (see --check, which
reports the closest approach to any obstacle along the whole path).

Frames already on disk are skipped, so an interrupted render resumes.
"""
import math
import os
import sys
import time

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render_setup import configure  # noqa: E402

GROUND_EYE = 1.40  # eye height over the lawn (lawn is 0.15 below the floor)
FLOOR_EYE = 1.55

# (time s, position, heading deg (0 = east, 90 = north), pitch deg)
KEYS = [
    (0.0, (10.95, 19.60, GROUND_EYE), -118, -1),
    (4.0, (10.65, 17.60, GROUND_EYE), -116, -2),
    (8.0, (10.20, 15.30, GROUND_EYE), -113, -3),
    (11.0, (9.80, 13.05, GROUND_EYE), -120, -4),
    (13.5, (8.20, 12.00, GROUND_EYE + 0.01), -118, -4),   # on the paving strip
    (15.5, (7.25, 11.05, FLOOR_EYE), -100, -5),           # stepped onto the deck
    (18.0, (7.15, 9.45, FLOOR_EYE), -92, -5),
    (20.0, (7.12, 8.25, FLOOR_EYE), -100, -5),            # in the doorway
    (22.0, (7.08, 7.25, FLOOR_EYE), -140, -6),            # TV wall, fireplace, corridor
    (25.0, (7.00, 6.55, FLOOR_EYE), -75, -6),
    (28.5, (6.98, 5.85, FLOOR_EYE), -8, -6),              # sofa and the art wall
    (31.5, (6.95, 5.05, FLOOR_EYE), -35, -6),
    (34.5, (6.93, 4.10, FLOOR_EYE), -75, -7),             # dining table, kitchen beyond
    (37.5, (6.92, 3.10, FLOOR_EYE), -72, -7),
    (40.0, (6.95, 2.30, FLOOR_EYE), -45, -7),             # between tall units and peninsula
    (42.5, (7.25, 1.60, FLOOR_EYE), -10, -6),             # kitchen run and window
    (45.5, (7.65, 1.48, FLOOR_EYE), 40, -5),
    (49.0, (7.95, 1.45, FLOOR_EYE), 82, -4),              # back over the peninsula to the garden
    (52.0, (8.02, 1.50, FLOOR_EYE), 86, -3),
]
DURATION = KEYS[-1][0]
LENS_MM = 17.0  # full-frame equivalent, typical for a gimbal walkthrough

# exposure: exterior at 0 EV, interior opened up like a camera's auto exposure
EXPOSURE_OUT, EXPOSURE_IN = 0.1, 2.0


def catmull(p0, p1, p2, p3, t):
    t2, t3 = t * t, t * t * t
    return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)


def unwrap(hs):
    out = [hs[0]]
    for h in hs[1:]:
        d = (h - out[-1] + 180) % 360 - 180
        out.append(out[-1] + d)
    return out


HEADINGS = unwrap([k[2] for k in KEYS])


def sample_keys(t):
    """Centripetal-free uniform Catmull-Rom over the keys, parameterised by
    time, with the ends clamped. Returns position, heading, pitch."""
    ts = [k[0] for k in KEYS]
    t = min(max(t, 0.0), DURATION)
    i = max(0, min(len(ts) - 2, next(j for j in range(len(ts) - 1) if t <= ts[j + 1])))
    u = (t - ts[i]) / (ts[i + 1] - ts[i])
    idx = [max(0, i - 1), i, i + 1, min(len(KEYS) - 1, i + 2)]
    P = [Vector(KEYS[j][1]) for j in idx]
    H = [HEADINGS[j] for j in idx]
    T = [KEYS[j][3] for j in idx]
    return catmull(*P, u), catmull(*H, u), catmull(*T, u)


def ease_time(t):
    """Gentle start and finish: the walk accelerates from rest over the first
    1.5 s and settles over the last 2 s (time remapped, path unchanged)."""
    a, b = 1.5, 2.0
    D = DURATION
    # piecewise: quadratic ease in, linear, quadratic ease out, same total time
    v = 1.0 / (1 - a / (2 * D) - b / (2 * D))
    if t < a:
        return v * t * t / (2 * a)
    if t > D - b:
        r = D - t
        return D - v * r * r / (2 * b)
    return v * (t - a / 2)


def camera_at(t):
    p, h, pitch = sample_keys(ease_time(t))
    hr, pr = math.radians(h), math.radians(pitch)
    d = Vector((math.cos(hr) * math.cos(pr), math.sin(hr) * math.cos(pr), math.sin(pr)))
    return p, d


def exposure_at(p):
    # ramps while the camera crosses the pergola and the doorway
    k = min(1.0, max(0.0, (10.6 - p.y) / 2.4))
    k = k * k * (3 - 2 * k)
    return EXPOSURE_OUT + (EXPOSURE_IN - EXPOSURE_OUT) * k


# obstacles (plan boxes, x0 x1 y0 y1) the camera body (0.25 m radius) must clear
OBSTACLES = {
    'pool': (1.6, 8.0, 12.35, 16.15),
    'lounger': (8.6, 9.3, 13.2, 15.8),
    'outdoor dining set': (7.7, 9.8, 8.75, 10.75),
    'outdoor lounge': (3.1, 5.15, 8.9, 10.9),
    'pergola post (mid)': (3.85, 4.1, 10.95, 11.15),
    'pergola post (east)': (10.2, 10.47, 10.95, 11.15),
    'slider fixed sash + frame east': (7.77, 9.09, 7.9, 8.2),
    'slider frame west': (6.40, 6.53, 7.9, 8.2),
    'sofa': (8.10, 10.12, 5.15, 7.55),
    'coffee table': (7.80, 8.80, 5.42, 6.42),
    'tv unit': (5.65, 6.10, 5.05, 7.45),
    'fireplace breast': (4.62, 6.35, 2.10, 3.15),
    'dining table + chairs': (7.40, 9.30, 3.25, 5.15),
    'tall units': (5.58, 6.23, 0.35, 2.10),
    'peninsula': (7.33, 10.12, 2.08, 2.77),
    'south run': (6.20, 10.12, 0.35, 0.97),
    'east run': (9.48, 10.12, 0.97, 2.10),
}
WALL_LINES = [  # house walls the camera may cross only through the door
    ('north wall', 'y', 7.90, (6.53, 7.77)),
]


def check_path(fps=24):
    worst = (9e9, None, None)
    n = int(DURATION * fps)
    prev = None
    max_speed = max_turn = 0.0
    for f in range(n + 1):
        p, d = camera_at(f / fps)
        for name, (x0, x1, y0, y1) in OBSTACLES.items():
            dx = max(x0 - p.x, 0, p.x - x1)
            dy = max(y0 - p.y, 0, p.y - y1)
            dist = math.hypot(dx, dy)
            if dist < worst[0]:
                worst = (dist, name, f)
        if prev:
            pp, pd = prev
            max_speed = max(max_speed, (p - pp).length * fps)
            max_turn = max(max_turn, math.degrees(pd.angle(d)) * fps)
            for name, axis, v, (a, b) in WALL_LINES:
                if (pp.y - v) * (p.y - v) < 0:
                    xc = pp.x + (p.x - pp.x) * (v - pp.y) / (p.y - pp.y)
                    ok = a + 0.25 <= xc <= b - 0.25
                    print(f'crosses {name} at x={xc:.2f} ({"clear" if ok else "BLOCKED"})')
        prev = (p, d)
    print(f'closest approach {worst[0]:.2f} m to {worst[1]} at frame {worst[2]}')
    print(f'max speed {max_speed:.2f} m/s, max turn rate {max_turn:.1f} deg/s')


def camera_rotations(n, fps):
    """Camera Euler rotation per frame, kept continuous. Converting each
    frame's orientation independently lets the heading wrap from +180 to -180
    degrees between two frames; the motion-blur shutter then interpolates
    through a full 360-degree spin and the frame becomes a ghosted blend of
    the whole room. Each Euler is taken compatible with the previous one."""
    out, prev = [], None
    for f in range(n + 1):
        _, d = camera_at(f / fps)
        q = d.to_track_quat('-Z', 'Y')
        e = q.to_euler('XYZ', prev) if prev is not None else q.to_euler('XYZ')
        out.append(e)
        prev = e
    return out


def vignette(w, h, angle=math.pi / 7):
    """cos^4 falloff over the half-diagonal, the same curve as the ffmpeg
    `vignette=angle=PI/7` filter used before, but applied here in float,
    without dithering, so it is static from frame to frame."""
    import numpy as np
    y, x = np.mgrid[0:h, 0:w]
    r = np.hypot(x - (w - 1) / 2, y - (h - 1) / 2) / math.hypot(w / 2, h / 2)
    return (np.cos(angle * r) ** 4)[..., None]


class Renderer:
    def __init__(self, blend, size, samples, fps=24, ss=1, threshold=None, blur=True, clamp_indirect=8.0,
                 min_samples=16):
        self.w, self.h = size
        self.ss = ss
        self.fps = fps
        bpy.ops.wm.open_mainfile(filepath=blend)
        sc = self.sc = bpy.context.scene
        configure(sc, (self.w * ss, self.h * ss), samples, threshold, clamp_indirect, min_samples)
        sc.render.use_motion_blur = blur
        sc.render.motion_blur_shutter = 0.5  # 180 degree shutter
        sc.render.fps = fps
        sc.render.fps_base = 1.0
        cam_data = bpy.data.cameras.new('gimbal')
        cam_data.lens = LENS_MM
        cam_data.sensor_width = 36
        cam_data.clip_start = 0.05
        cam = self.cam = bpy.data.objects.new('gimbal', cam_data)
        sc.collection.objects.link(cam)
        sc.camera = cam
        fire = bpy.data.materials.get('fire')
        self.noise = fire.node_tree.nodes[fire['noise']] if fire else None
        # the camera is keyed on every frame; motion blur samples the curve
        # between neighbouring keys, so keys must be continuous
        self.n = int(DURATION * fps)
        rots = camera_rotations(self.n, fps)
        cam.animation_data_clear()
        for f in range(self.n + 1):
            p, _ = camera_at(f / fps)
            cam.location = p
            cam.rotation_euler = rots[f]
            cam.keyframe_insert('location', frame=f)
            cam.keyframe_insert('rotation_euler', frame=f)
        self.vig = vignette(self.w, self.h)

    def render(self, f, path, crop=None, post=True):
        """Render frame f (time exactly f / fps) to an 8-bit PNG at the output
        size. With ss > 1 the frame is rendered ss times larger and box-
        filtered down. `crop` = (x0, x1, y0, y1) fractions renders a region."""
        import numpy as np
        from PIL import Image
        sc = self.sc
        sc.frame_set(f)
        p, _ = camera_at(f / self.fps)
        sc.view_settings.exposure = exposure_at(p)
        if self.noise:  # flame animation, a pure function of the frame number
            self.noise.inputs['W'].default_value = f * 0.09
        sc.render.use_border = crop is not None
        sc.render.use_crop_to_border = crop is not None
        if crop:
            sc.render.border_min_x, sc.render.border_max_x = crop[0], crop[1]
            sc.render.border_min_y, sc.render.border_max_y = 1 - crop[3], 1 - crop[2]
        tmp = path + '.full.png'
        sc.render.filepath = tmp
        bpy.ops.render.render(write_still=True)
        img = np.asarray(Image.open(tmp).convert('RGB'), dtype=np.float64)
        s = self.ss
        hh, ww = (img.shape[0] // s) * s, (img.shape[1] // s) * s
        img = img[:hh, :ww].reshape(hh // s, s, ww // s, s, 3).mean(axis=(1, 3))
        if post and crop is None:
            img = img * self.vig
        Image.fromarray(np.clip(np.rint(img), 0, 255).astype(np.uint8)).save(path)
        os.remove(tmp)
        return img


def main():
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
    opts = {'size': '1280x720', 'fps': '24', 'samples': '12', 'ss': '2', 'start': '0', 'end': '-1', 'step': '1'}
    rest = []
    it = iter(args)
    for a in it:
        if a == '--check':
            opts['check'] = True
        elif a.startswith('--'):
            opts[a[2:]] = next(it)
        else:
            rest.append(a)
    fps = int(opts['fps'])
    if opts.get('check'):
        check_path(fps)
        return
    blend, out_dir = rest
    w, h = (int(v) for v in opts['size'].split('x'))
    thr = float(opts['threshold']) if 'threshold' in opts else None
    r = Renderer(blend, (w, h), int(opts['samples']), fps, int(opts['ss']), thr)
    end = r.n if int(opts['end']) < 0 else min(r.n, int(opts['end']))
    os.makedirs(out_dir, exist_ok=True)
    frames = range(int(opts['start']), end + 1, int(opts['step']))
    if 'frames' in opts:
        frames = [int(v) for v in opts['frames'].split(',')]
    for f in frames:
        path = os.path.join(out_dir, f'{f:05d}.png')
        if os.path.exists(path):
            continue
        t0 = time.time()
        r.render(f, path)
        print(f'frame {f}/{r.n} {time.time() - t0:.1f}s', flush=True)


if __name__ == '__main__':
    main()
