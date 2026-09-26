"""Temporal consistency check for a rendered frame sequence.

    python3 walkthrough/check_sequence.py <frames_dir | video.mp4>

For every pair of consecutive frames it measures the mean absolute change;
for every frame the mean brightness. A ghosted/blended frame, a cut or a
jump shows up as a spike in the change relative to its neighbours (reported
as a ratio against the local median); exposure pulsing shows up as brightness
wobble (second difference) instead of a smooth curve. Also checks that the
frame numbering has no gaps.
"""
import glob
import os
import subprocess
import sys

import numpy as np
from PIL import Image


def frames_from(src):
    if os.path.isdir(src):
        files = sorted(glob.glob(os.path.join(src, '*.png')))
        nums = [int(os.path.basename(f)[:-4]) for f in files]
        missing = sorted(set(range(nums[0], nums[-1] + 1)) - set(nums))
        print(f'{len(files)} frames, numbered {nums[0]}..{nums[-1]}, missing: {missing or "none"}')
        for f in files:
            yield np.asarray(Image.open(f).convert('L').resize((320, 180), Image.BOX), dtype=np.float32)
    else:
        p = subprocess.Popen(['ffmpeg', '-loglevel', 'error', '-i', src, '-vf', 'scale=320:180:flags=area',
                              '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], stdout=subprocess.PIPE)
        while True:
            buf = p.stdout.read(320 * 180)
            if len(buf) < 320 * 180:
                break
            yield np.frombuffer(buf, np.uint8).reshape(180, 320).astype(np.float32)


def main():
    src = sys.argv[1]
    diffs, lum, prev = [], [], None
    for img in frames_from(src):
        lum.append(img.mean())
        if prev is not None:
            diffs.append(np.abs(img - prev).mean())
        prev = img
    d = np.array(diffs)
    lum = np.array(lum)
    n = len(d)
    ratio = np.array([d[i] / max(np.median(d[max(0, i - 6):i + 7]), 1e-3) for i in range(n)])
    print(f'{len(lum)} frames')
    print(f'consecutive-frame change: median {np.median(d):.2f}, max {d.max():.2f} (frames {d.argmax()}->{d.argmax() + 1})')
    worst = np.argsort(ratio)[::-1][:5]
    print('largest spikes vs local median:', ', '.join(f'{i}->{i + 1}: x{ratio[i]:.2f}' for i in worst))
    spikes = [i for i in range(n) if ratio[i] > 1.8]
    print('SPIKES (>1.8x local median):', spikes or 'none')
    wob = np.abs(np.diff(lum, 2))
    print(f'brightness: {lum.min():.1f}..{lum.max():.1f}; frame-to-frame wobble (2nd diff) '
          f'median {np.median(wob):.3f}, max {wob.max():.3f} at frame {wob.argmax() + 1}')


if __name__ == '__main__':
    main()
