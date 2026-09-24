"""Cut wall textures out of the four elevation images.

Every elevation is an orthographic view at the same scale (~55 px per metre).
Each wall face is cropped from the row just under the eave (soffit shadow)
down to the ground line, 188 px tall, so all walls share one height.
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "source"
OUT = ROOT / "textures"

WALL_H = 188  # px, soffit to ground

# image name -> row of the soffit (top of wall) in that image
TOP = {
    "elevation_front": 305,
    "elevation_east": 307,
    "elevation_west": 300,
    "elevation_rear": 305,
}

# texture name -> (image, x0, x1), left-to-right as seen from outside
WALLS = {
    "front_wing": ("elevation_front", 212, 702),
    "front_main": ("elevation_front", 702, 1086),
    "rear_main": ("elevation_rear", 215, 594),
    "rear_wing": ("elevation_rear", 594, 1089),
    "east_wing_s": ("elevation_east", 98, 385),
    "east_main": ("elevation_east", 385, 880),
    "east_wing_n": ("elevation_east", 880, 1157),
    "west_wing": ("elevation_west", 99, 1155),
}


def main():
    OUT.mkdir(exist_ok=True)
    cache = {}
    for name, (img, x0, x1) in WALLS.items():
        if img not in cache:
            cache[img] = Image.open(SRC / f"{img}.png").convert("RGB")
        im = cache[img]
        top = TOP[img]
        bottom = min(top + WALL_H, im.height)
        crop = im.crop((x0, top, x1, bottom))
        if crop.height < WALL_H:  # pad the plinth if the image is cut short
            padded = Image.new("RGB", (crop.width, WALL_H))
            padded.paste(crop, (0, 0))
            last = crop.crop((0, crop.height - 1, crop.width, crop.height))
            for y in range(crop.height, WALL_H):
                padded.paste(last, (0, y))
            crop = padded
        # upscale 2x so texture filtering stays crisp in close-ups
        crop = crop.resize((crop.width * 2, crop.height * 2), Image.LANCZOS)
        crop.save(OUT / f"{name}.jpg", quality=92)
        print(f"{name}: {crop.size}")


if __name__ == "__main__":
    main()
