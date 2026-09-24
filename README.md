# House 360

A 360° orbit video of the bungalow *Dom w macierzankach 5 (G2)*, rebuilt as a
3D model from its four elevation drawings. It's modelled on the archon.pl
turntable viewer.

**Result:** [`output/house_360.mp4`](output/house_360.mp4) (1920×1080, 60 fps, 16 s, seamless loop)

## How it works

1. `source/` holds the input images: four orthographic elevations plus the
   front render used for reference.
2. `tools/crop_textures.py` cuts each wall face out of the elevations
   (soffit to ground) into `textures/`.
3. `src/house.js` builds the model in three.js from measurements taken off
   the drawings (~55 px/m):
   - T-shaped plan: garage wing 8.9 × 19.2 m plus main body 7.0 × 8.9 m
   - ~30° hip roofs with valleys, ridge and hip caps, fascia, gutters and soffits
   - three chimneys placed by cross-referencing all four elevations
   - baked flat shading and a soft contact shadow on a white backdrop
4. `tools/render.mjs` drives headless Chromium to render every frame and
   pipes the frames to ffmpeg.

## Usage

```sh
npm install
npm run textures                 # re-cut wall textures (needs Pillow)
npm run render                   # -> output/house_360.mp4 (needs playwright + ffmpeg)
node tools/render.mjs --stills   # 8 stills every 45° -> output/stills/
npm run serve                    # interactive viewer at http://localhost:8080 (drag to rotate)
```

Render options: `--seconds 16 --fps 60 --w 1920 --h 1080 --out path.mp4`.

The wall textures come straight from the elevations, so the archon.pl
watermark is still visible on some walls. The source images are © ARCHON+.
