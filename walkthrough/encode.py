"""Encode rendered walkthrough frames to video, with no processing at all.

    python3 walkthrough/encode.py <frames_dir> <out.mp4> [--crf 16] [--codec h264|h265]

Frames are taken exactly as rendered (the vignette is already applied,
deterministically, per frame): no grain, no sharpening, no frame blending
or interpolation, constant 24 fps, one frame in = one frame out.
"""
import subprocess
import sys


def main():
    args = sys.argv[1:]
    opts = {'crf': '16', 'codec': 'h264'}
    rest = []
    it = iter(args)
    for a in it:
        if a.startswith('--'):
            opts[a[2:]] = next(it)
        else:
            rest.append(a)
    frames, out = rest
    cmd = ['ffmpeg', '-loglevel', 'error', '-y', '-framerate', '24', '-start_number', '0',
           '-i', f'{frames}/%05d.png', '-fps_mode', 'passthrough', '-pix_fmt', 'yuv420p']
    if opts['codec'] == 'h265':
        cmd += ['-c:v', 'libx265', '-preset', 'slow', '-crf', opts['crf'], '-tag:v', 'hvc1',
                '-x265-params', 'log-level=error:keyint=48:min-keyint=24:aq-mode=3']
    else:
        cmd += ['-c:v', 'libx264', '-preset', 'slower', '-tune', 'film', '-crf', opts['crf'],
                '-profile:v', 'high', '-g', '48', '-keyint_min', '24', '-aq-mode', '3']
    cmd += ['-r', '24', '-movflags', '+faststart', '-an', out]
    subprocess.run(cmd, check=True)
    info = subprocess.run(['ffmpeg', '-i', out], capture_output=True, text=True).stderr
    print('\n'.join(l for l in info.splitlines() if 'Duration' in l or 'Video:' in l))


if __name__ == '__main__':
    main()
