"""Temporal-stability test for the walkthrough render settings.

    python3 walkthrough/stability.py <scene.blend> <out_dir> --label NAME
            [--frames 200,330,700,1000] [--samples 16] [--ss 2] [--threshold T]
            [--crop 0.2,0.8,0.2,0.8]

With a moving camera every frame sees a fresh sampling/anti-aliasing pattern
over any given surface, so the difference between two renders of the *same*
frame made with two different sampler seeds is the shimmer that setting will
show frame to frame (noise, denoiser blotches, aliasing of thin edges and
procedural detail). Reports the mean and 99th percentile of that difference
in 8-bit output levels, per frame, plus render time.
"""
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import walk  # noqa: E402


def main():
    args = sys.argv[1:]
    opts = {'frames': '200,330,700,1000', 'samples': '16', 'ss': '2', 'crop': '0.2,0.8,0.2,0.8', 'label': 'test'}
    rest = []
    it = iter(args)
    for a in it:
        if a.startswith('--'):
            opts[a[2:]] = next(it)
        else:
            rest.append(a)
    blend, out = rest
    os.makedirs(out, exist_ok=True)
    thr = float(opts['threshold']) if 'threshold' in opts else None
    r = walk.Renderer(blend, (1280, 720), int(opts['samples']), 24, int(opts['ss']), thr,
                      clamp_indirect=float(opts.get('clamp', 8.0)), min_samples=int(opts.get('min', 16)))
    if 'lighttree' in opts:
        r.sc.cycles.use_light_tree = opts['lighttree'] == '1'
    crop = tuple(float(v) for v in opts['crop'].split(','))
    rows = []
    for f in (int(v) for v in opts['frames'].split(',')):
        imgs = []
        t0 = time.time()
        for seed in (7, 1234):
            r.sc.cycles.seed = seed
            imgs.append(r.render(f, os.path.join(out, f"{opts['label']}_{f:05d}_s{seed}.png"), crop=crop))
        dt = (time.time() - t0) / 2 / ((crop[1] - crop[0]) * (crop[3] - crop[2]))
        d = np.abs(imgs[0] - imgs[1]).mean(axis=2)
        rows.append((f, d.mean(), np.percentile(d, 99), dt))
        print(f"{opts['label']} frame {f}: mean {d.mean():.2f}  p99 {np.percentile(d, 99):.1f}  "
              f"~{dt:.0f}s per full frame", flush=True)
    m = np.mean([x[1] for x in rows]), np.mean([x[2] for x in rows]), np.mean([x[3] for x in rows])
    print(f"{opts['label']} AVERAGE: mean {m[0]:.2f}  p99 {m[1]:.1f}  ~{m[2]:.0f}s per frame", flush=True)


if __name__ == '__main__':
    main()
