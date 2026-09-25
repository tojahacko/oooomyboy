"""Procedural Cycles materials for the Zielistki 34 walkthrough.

No image textures are available offline, so every surface is built from
shader nodes: plaster, stone-look floor tiles, oak veneer, fabrics, lacquer,
back-painted glass, roof tiles, decking, lawn and so on. Colours are sampled
by eye from the reference photos in source/zielistki34/.
"""
import bpy


def _hex(h, a=1.0):
    h = h.lstrip('#')
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*lin, a)


class Nodes:
    """Tiny helper around a material node tree."""

    def __init__(self, name):
        self.mat = bpy.data.materials.new(name)
        self.mat.use_nodes = True
        self.nt = self.mat.node_tree
        self.nt.nodes.clear()
        self.out = self.new('ShaderNodeOutputMaterial', (600, 0))
        self.bsdf = self.new('ShaderNodeBsdfPrincipled', (300, 0))
        self.link(self.bsdf, 0, self.out, 'Surface')

    def new(self, kind, loc=(0, 0), **props):
        n = self.nt.nodes.new(kind)
        n.location = loc
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def link(self, a, out, b, inp):
        self.nt.links.new(a.outputs[out], b.inputs[inp])

    def set(self, **inputs):
        for k, v in inputs.items():
            self.bsdf.inputs[k].default_value = v
        return self

    def coords(self, space='Object', scale=(1, 1, 1), rot=(0, 0, 0)):
        tc = self.new('ShaderNodeTexCoord', (-1200, 0))
        mp = self.new('ShaderNodeMapping', (-1000, 0))
        mp.inputs['Scale'].default_value = scale
        mp.inputs['Rotation'].default_value = rot
        self.link(tc, space, mp, 'Vector')
        return mp

    def ramp(self, fac_src, fac_out, stops, loc=(-200, 0)):
        r = self.new('ShaderNodeValToRGB', loc)
        els = r.color_ramp.elements
        while len(els) > 2:
            els.remove(els[-1])
        for i, (pos, col) in enumerate(stops):
            e = els[i] if i < 2 else els.new(pos)
            e.position = pos
            e.color = _hex(col) if isinstance(col, str) else col
        self.link(fac_src, fac_out, r, 'Fac')
        return r

    def bump(self, height_node, out, strength=0.1, distance=0.01, loc=(0, -300)):
        b = self.new('ShaderNodeBump', loc)
        b.inputs['Strength'].default_value = strength
        b.inputs['Distance'].default_value = distance
        self.link(height_node, out, b, 'Height')
        self.link(b, 'Normal', self.bsdf, 'Normal')
        return b


def plain(name, color, rough=0.5, metal=0.0, coat=0.0, spec=0.5, sheen=0.0, emit=None, emit_strength=0.0):
    n = Nodes(name)
    n.set(**{'Base Color': _hex(color), 'Roughness': rough, 'Metallic': metal,
             'Coat Weight': coat, 'Specular IOR Level': spec, 'Sheen Weight': sheen})
    if emit:
        n.set(**{'Emission Color': _hex(emit), 'Emission Strength': emit_strength})
    return n.mat


def plaster(name, base, var=0.04, rough=0.9, scale=2.0, bump=0.04):
    """Painted / rendered wall: very soft mottling plus fine sand bump."""
    n = Nodes(name)
    mp = n.coords('Object')
    big = n.new('ShaderNodeTexNoise', (-800, 100))
    big.inputs['Scale'].default_value = scale
    big.inputs['Detail'].default_value = 6
    n.link(mp, 0, big, 'Vector')
    col = n.ramp(big, 'Fac', [(0.3, _shade(base, 1 - var)), (0.7, _shade(base, 1 + var * 0.5))])
    n.link(col, 0, n.bsdf, 'Base Color')
    fine = n.new('ShaderNodeTexNoise', (-800, -300))
    fine.inputs['Scale'].default_value = 900
    fine.inputs['Detail'].default_value = 2
    n.link(mp, 0, fine, 'Vector')
    n.bump(fine, 'Fac', strength=bump, distance=0.002)
    n.set(Roughness=rough)
    return n.mat


def _shade(hexcol, k):
    c = _hex(hexcol)
    return (min(c[0] * k, 1), min(c[1] * k, 1), min(c[2] * k, 1), 1)


def decorative_plaster(name):
    """The grey 'concrete look' feature wall behind the sofa."""
    n = Nodes(name)
    mp = n.coords('Object')
    a = n.new('ShaderNodeTexNoise', (-800, 200))
    a.inputs['Scale'].default_value = 1.6
    a.inputs['Detail'].default_value = 10
    a.inputs['Roughness'].default_value = 0.62
    n.link(mp, 0, a, 'Vector')
    col = n.ramp(a, 'Fac', [(0.25, '#9f9c97'), (0.5, '#b8b5af'), (0.75, '#cac7c1')])
    n.link(col, 0, n.bsdf, 'Base Color')
    trowel = n.new('ShaderNodeTexNoise', (-800, -250))
    trowel.inputs['Scale'].default_value = 7
    trowel.inputs['Detail'].default_value = 12
    n.link(mp, 0, trowel, 'Vector')
    n.bump(trowel, 'Fac', strength=0.08, distance=0.004)
    n.set(Roughness=0.82)
    return n.mat


def stone_tiles(name, tile=(1.2, 0.6)):
    """Large-format light grey stone-look porcelain, satin finish, fine grout."""
    n = Nodes(name)
    mp = n.coords('Object')
    brick = n.new('ShaderNodeTexBrick', (-700, 300))
    brick.offset = 0.0
    brick.inputs['Scale'].default_value = 1.0
    brick.inputs['Mortar Size'].default_value = 0.0018
    brick.inputs['Brick Width'].default_value = tile[0]
    brick.inputs['Row Height'].default_value = tile[1]
    brick.inputs['Color1'].default_value = (1, 1, 1, 1)
    brick.inputs['Color2'].default_value = (0.93, 0.93, 0.93, 1)
    brick.inputs['Mortar'].default_value = (0, 0, 0, 1)
    n.link(mp, 0, brick, 'Vector')
    # soft clouds + thin veins
    cloud = n.new('ShaderNodeTexNoise', (-700, 0))
    cloud.inputs['Scale'].default_value = 1.2
    cloud.inputs['Detail'].default_value = 8
    n.link(mp, 0, cloud, 'Vector')
    vein = n.new('ShaderNodeTexWave', (-700, -250))
    vein.wave_type = 'BANDS'
    vein.inputs['Scale'].default_value = 1.4
    vein.inputs['Distortion'].default_value = 14
    vein.inputs['Detail'].default_value = 6
    n.link(mp, 0, vein, 'Vector')
    vramp = n.ramp(vein, 'Fac', [(0.0, (1, 1, 1, 1)), (0.03, (0.8, 0.8, 0.8, 1)), (0.06, (1, 1, 1, 1))], loc=(-450, -250))
    base = n.ramp(cloud, 'Fac', [(0.3, '#cfcecb'), (0.7, '#e2e1dd')], loc=(-450, 0))
    mix = n.new('ShaderNodeMix', (-200, 100))
    mix.data_type = 'RGBA'
    mix.blend_type = 'MULTIPLY'
    mix.inputs['Factor'].default_value = 1.0
    n.link(base, 0, mix, 6)
    n.link(vramp, 0, mix, 7)
    mix2 = n.new('ShaderNodeMix', (0, 100))
    mix2.data_type = 'RGBA'
    mix2.blend_type = 'MULTIPLY'
    mix2.inputs['Factor'].default_value = 1.0
    n.link(mix, 2, mix2, 6)
    n.link(brick, 'Color', mix2, 7)
    n.link(mix2, 2, n.bsdf, 'Base Color')
    grout = n.new('ShaderNodeMath', (-200, -450))
    grout.operation = 'LESS_THAN'
    grout.inputs[1].default_value = 0.5
    n.link(brick, 'Fac', grout, 0)
    n.bump(brick, 'Fac', strength=0.25, distance=0.002)
    rough = n.new('ShaderNodeMapRange', (0, -150))
    rough.inputs['To Min'].default_value = 0.22
    rough.inputs['To Max'].default_value = 0.34
    n.link(cloud, 'Fac', rough, 'Value')
    n.link(rough, 'Result', n.bsdf, 'Roughness')
    return n.mat


def oak(name, axis='Z', light='#d8ba94', mid='#c29d73', dark='#a57f57', rough=0.55, scale=1.0):
    """Oak veneer. `axis` is the grain direction in object space."""
    stretch = {'X': (2, 40, 40), 'Y': (40, 2, 40), 'Z': (40, 40, 2)}[axis]
    n = Nodes(name)
    mp = n.coords('Object', scale=tuple(s * scale for s in stretch))
    warp = n.new('ShaderNodeTexNoise', (-800, 250))
    warp.inputs['Scale'].default_value = 0.35
    warp.inputs['Detail'].default_value = 3
    n.link(mp, 0, warp, 'Vector')
    mixv = n.new('ShaderNodeMix', (-600, 150))
    mixv.data_type = 'VECTOR'
    mixv.inputs['Factor'].default_value = 0.35
    n.link(mp, 0, mixv, 4)
    n.link(warp, 'Color', mixv, 5)
    grain = n.new('ShaderNodeTexNoise', (-400, 150))
    grain.inputs['Scale'].default_value = 1.5
    grain.inputs['Detail'].default_value = 12
    grain.inputs['Roughness'].default_value = 0.7
    n.link(mixv, 1, grain, 'Vector')
    col = n.ramp(grain, 'Fac', [(0.35, dark), (0.5, mid), (0.68, light)])
    n.link(col, 0, n.bsdf, 'Base Color')
    n.bump(grain, 'Fac', strength=0.08, distance=0.002)
    n.set(Roughness=rough, **{'Coat Weight': 0.15, 'Coat Roughness': 0.35})
    return n.mat


def fabric(name, color, var=0.06, sheen=0.7, weave=420):
    """Upholstery: sheen, fine woven bump and slight colour flecking."""
    n = Nodes(name)
    mp = n.coords('Object')
    fleck = n.new('ShaderNodeTexNoise', (-800, 200))
    fleck.inputs['Scale'].default_value = 60
    fleck.inputs['Detail'].default_value = 4
    n.link(mp, 0, fleck, 'Vector')
    col = n.ramp(fleck, 'Fac', [(0.35, _shade(color, 1 - var)), (0.65, _shade(color, 1 + var))])
    n.link(col, 0, n.bsdf, 'Base Color')
    w1 = n.new('ShaderNodeTexWave', (-800, -150))
    w1.bands_direction = 'X'
    w1.inputs['Scale'].default_value = weave
    n.link(mp, 0, w1, 'Vector')
    w2 = n.new('ShaderNodeTexWave', (-800, -400))
    w2.bands_direction = 'Z'
    w2.inputs['Scale'].default_value = weave
    n.link(mp, 0, w2, 'Vector')
    add = n.new('ShaderNodeMath', (-500, -250))
    add.operation = 'MULTIPLY'
    n.link(w1, 'Fac', add, 0)
    n.link(w2, 'Fac', add, 1)
    n.bump(add, 0, strength=0.15, distance=0.0015)
    n.set(Roughness=0.95, **{'Sheen Weight': sheen, 'Sheen Roughness': 0.4, 'Specular IOR Level': 0.3})
    return n.mat


def glass(name, tint='#f4f7f6', rough=0.0):
    """Architectural glazing. Transparent to shadow rays so daylight reaches
    the interior without caustic noise, while camera rays still see real
    refraction and reflections."""
    n = Nodes(name)
    n.set(**{'Base Color': _hex(tint), 'Roughness': rough, 'IOR': 1.52, 'Transmission Weight': 1.0})
    lp = n.new('ShaderNodeLightPath', (-200, 300))
    tr = n.new('ShaderNodeBsdfTransparent', (0, 300))
    mix = n.new('ShaderNodeMixShader', (450, 150))
    n.nt.links.remove(n.out.inputs['Surface'].links[0])
    n.link(lp, 'Is Shadow Ray', mix, 'Fac')
    n.link(n.bsdf, 0, mix, 1)
    n.link(tr, 0, mix, 2)
    n.link(mix, 0, n.out, 'Surface')
    return n.mat


def backpainted_glass(name, color='#eeeeec'):
    return plain(name, color, rough=0.04, coat=1.0, spec=0.6)


def lacquer(name, color='#f2f2f0', rough=0.3):
    n = Nodes(name)
    n.set(**{'Base Color': _hex(color), 'Roughness': rough, 'Coat Weight': 0.3, 'Coat Roughness': 0.25})
    return n.mat


def countertop(name, color='#2d2e30'):
    n = Nodes(name)
    mp = n.coords('Object')
    sp = n.new('ShaderNodeTexNoise', (-600, 100))
    sp.inputs['Scale'].default_value = 300
    n.link(mp, 0, sp, 'Vector')
    col = n.ramp(sp, 'Fac', [(0.45, _shade(color, 0.85)), (0.6, _shade(color, 1.2))])
    n.link(col, 0, n.bsdf, 'Base Color')
    n.set(Roughness=0.38)
    return n.mat


def stones(name):
    """Gabion basket: packed grey-beige stones with dark gaps."""
    n = Nodes(name)
    mp = n.coords('Object')
    vor = n.new('ShaderNodeTexVoronoi', (-700, 0))
    vor.feature = 'DISTANCE_TO_EDGE'
    vor.inputs['Scale'].default_value = 7
    n.link(mp, 0, vor, 'Vector')
    cell = n.new('ShaderNodeTexVoronoi', (-700, 300))
    cell.inputs['Scale'].default_value = 7
    n.link(mp, 0, cell, 'Vector')
    col = n.ramp(cell, 'Color', [(0.0, '#8f8a80'), (0.5, '#bdb7ab'), (1.0, '#d3cec4')], loc=(-400, 300))
    gap = n.ramp(vor, 'Distance', [(0.0, (0.15, 0.15, 0.15, 1)), (0.08, (1, 1, 1, 1))], loc=(-400, 0))
    mul = n.new('ShaderNodeMix', (-150, 150))
    mul.data_type = 'RGBA'
    mul.blend_type = 'MULTIPLY'
    mul.inputs['Factor'].default_value = 1
    n.link(col, 0, mul, 6)
    n.link(gap, 0, mul, 7)
    n.link(mul, 2, n.bsdf, 'Base Color')
    n.bump(vor, 'Distance', strength=1.0, distance=0.05)
    n.set(Roughness=0.85)
    return n.mat


def roof_tiles(name):
    """Flat concrete roof tiles on the exported slab UVs (metres)."""
    n = Nodes(name)
    uv = n.new('ShaderNodeTexCoord', (-1200, 0))
    brick = n.new('ShaderNodeTexBrick', (-800, 200))
    brick.offset = 0.5
    brick.inputs['Scale'].default_value = 1.0
    brick.inputs['Mortar Size'].default_value = 0.004
    brick.inputs['Brick Width'].default_value = 0.33
    brick.inputs['Row Height'].default_value = 0.33
    brick.inputs['Color1'].default_value = _hex('#56595e')
    brick.inputs['Color2'].default_value = _hex('#4b4e53')
    brick.inputs['Mortar'].default_value = _hex('#1f2124')
    n.link(uv, 'UV', brick, 'Vector')
    # course shadow: darker at the top of every course (overlap)
    sep = n.new('ShaderNodeSeparateXYZ', (-1000, -250))
    n.link(uv, 'UV', sep, 'Vector')
    div = n.new('ShaderNodeMath', (-800, -250))
    div.operation = 'DIVIDE'
    div.inputs[1].default_value = 0.33
    n.link(sep, 'Y', div, 0)
    fr = n.new('ShaderNodeMath', (-650, -250))
    fr.operation = 'FRACT'
    n.link(div, 0, fr, 0)
    shade = n.ramp(fr, 0, [(0.0, (0.55, 0.55, 0.55, 1)), (0.12, (1, 1, 1, 1))], loc=(-450, -250))
    mul = n.new('ShaderNodeMix', (-200, 0))
    mul.data_type = 'RGBA'
    mul.blend_type = 'MULTIPLY'
    mul.inputs['Factor'].default_value = 1
    n.link(brick, 'Color', mul, 6)
    n.link(shade, 0, mul, 7)
    n.link(mul, 2, n.bsdf, 'Base Color')
    n.bump(fr, 0, strength=0.4, distance=0.01)
    n.set(Roughness=0.62)
    return n.mat


def decking(name, color='#a67c55'):
    n = Nodes(name)
    mp = n.coords('Object')
    brick = n.new('ShaderNodeTexBrick', (-700, 200))
    brick.offset = 0.37
    brick.inputs['Scale'].default_value = 1.0
    brick.inputs['Mortar Size'].default_value = 0.006
    brick.inputs['Brick Width'].default_value = 2.4
    brick.inputs['Row Height'].default_value = 0.145
    brick.inputs['Color1'].default_value = _hex(color)
    brick.inputs['Color2'].default_value = _shade(color, 0.86)
    brick.inputs['Mortar'].default_value = _hex('#2a1d12')
    n.link(mp, 0, brick, 'Vector')
    g = n.new('ShaderNodeTexNoise', (-700, -150))
    g.inputs['Scale'].default_value = 3
    n.link(mp, 0, g, 'Vector')
    n.bump(brick, 'Fac', strength=0.3, distance=0.004)
    n.link(brick, 'Color', n.bsdf, 'Base Color')
    n.set(Roughness=0.7)
    return n.mat


def paving(name, color='#b9b8b3', slab=(1.2, 0.6)):
    n = Nodes(name)
    mp = n.coords('Object')
    brick = n.new('ShaderNodeTexBrick', (-700, 200))
    brick.offset = 0.5
    brick.inputs['Scale'].default_value = 1.0
    brick.inputs['Mortar Size'].default_value = 0.008
    brick.inputs['Brick Width'].default_value = slab[0]
    brick.inputs['Row Height'].default_value = slab[1]
    brick.inputs['Color1'].default_value = _hex(color)
    brick.inputs['Color2'].default_value = _shade(color, 0.93)
    brick.inputs['Mortar'].default_value = _shade(color, 0.6)
    n.link(mp, 0, brick, 'Vector')
    nz = n.new('ShaderNodeTexNoise', (-700, -150))
    nz.inputs['Scale'].default_value = 80
    n.link(mp, 0, nz, 'Vector')
    n.link(brick, 'Color', n.bsdf, 'Base Color')
    n.bump(nz, 'Fac', strength=0.1, distance=0.003)
    n.set(Roughness=0.85)
    return n.mat


def lawn_ground(name):
    """Lawn seen from a distance: mottled greens at three scales, a hint of
    mowing stripes and a rough, grassy bump."""
    n = Nodes(name)
    mp = n.coords('Object')
    big = n.new('ShaderNodeTexNoise', (-900, 250))
    big.inputs['Scale'].default_value = 0.25
    big.inputs['Detail'].default_value = 6
    n.link(mp, 0, big, 'Vector')
    mid = n.new('ShaderNodeTexNoise', (-900, 0))
    mid.inputs['Scale'].default_value = 6
    mid.inputs['Detail'].default_value = 4
    n.link(mp, 0, mid, 'Vector')
    fine = n.new('ShaderNodeTexVoronoi', (-900, -250))
    fine.inputs['Scale'].default_value = 260
    n.link(mp, 0, fine, 'Vector')
    stripes = n.new('ShaderNodeTexWave', (-900, -500))
    stripes.bands_direction = 'X'
    stripes.inputs['Scale'].default_value = 0.35
    stripes.inputs['Distortion'].default_value = 0.4
    n.link(mp, 0, stripes, 'Vector')
    acc = n.new('ShaderNodeMath', (-650, 150))
    acc.operation = 'MULTIPLY_ADD'
    acc.inputs[1].default_value = 0.5
    n.link(big, 'Fac', acc, 0)
    n.link(mid, 'Fac', acc, 2)
    acc2 = n.new('ShaderNodeMath', (-500, 0))
    acc2.operation = 'MULTIPLY_ADD'
    acc2.inputs[1].default_value = 0.35
    n.link(fine, 'Distance', acc2, 0)
    n.link(acc, 0, acc2, 2)
    acc3 = n.new('ShaderNodeMath', (-350, -100))
    acc3.operation = 'MULTIPLY_ADD'
    acc3.inputs[1].default_value = 0.08
    n.link(stripes, 'Fac', acc3, 0)
    n.link(acc2, 0, acc3, 2)
    col = n.ramp(acc3, 0, [(0.35, '#35591d'), (0.62, '#557f2c'), (0.9, '#7c9a45')], loc=(-150, 0))
    n.link(col, 0, n.bsdf, 'Base Color')
    n.bump(fine, 'Distance', strength=0.5, distance=0.01)
    n.set(Roughness=0.95, **{'Specular IOR Level': 0.3})
    return n.mat


def grass_blades(name):
    return foliage(name, '#3c6a22', '#79a040', 0.3)


def foliage(name, a='#35561f', b='#6f9138', translucency=0.35):
    """Leaves / grass: speckled colour, diffuse mixed with a translucent lobe
    (light through the leaf) and a faint waxy sheen. Cheap compared with
    subsurface scattering, which matters with hundreds of thousands of leaves."""
    n = Nodes(name)
    # per-leaf random value baked into the prototype meshes ('leafrand'),
    # varied again per placed tree through the instance's random
    attr = n.new('ShaderNodeAttribute', (-900, 300))
    attr.attribute_name = 'leafrand'
    info = n.new('ShaderNodeObjectInfo', (-900, 100))
    tc = n.new('ShaderNodeTexCoord', (-900, -100))
    nz = n.new('ShaderNodeTexNoise', (-700, -100))
    nz.inputs['Scale'].default_value = 0.8
    n.link(tc, 'Object', nz, 'Vector')
    lr = n.new('ShaderNodeMath', (-650, 250))
    lr.operation = 'MULTIPLY_ADD'
    lr.inputs[1].default_value = 0.55
    n.link(attr, 'Fac', lr, 0)
    n.link(nz, 'Fac', lr, 2)
    mixf = n.new('ShaderNodeMath', (-500, 100))
    mixf.operation = 'MULTIPLY_ADD'
    mixf.inputs[1].default_value = 0.25
    n.link(info, 'Random', mixf, 0)
    n.link(lr, 0, mixf, 2)
    col = n.ramp(mixf, 0, [(0.35, b), (1.1, a)])
    n.link(col, 0, n.bsdf, 'Base Color')
    n.set(Roughness=0.5, **{'Specular IOR Level': 0.35})
    tr = n.new('ShaderNodeBsdfTranslucent', (300, -250))
    n.link(col, 0, tr, 'Color')
    mix = n.new('ShaderNodeMixShader', (500, 0))
    mix.inputs['Fac'].default_value = translucency
    n.nt.links.remove(n.out.inputs['Surface'].links[0])
    n.link(n.bsdf, 0, mix, 1)
    n.link(tr, 0, mix, 2)
    n.link(mix, 0, n.out, 'Surface')
    return n.mat


def birch_bark(name):
    n = Nodes(name)
    mp = n.coords('Object', scale=(6, 6, 1.2))
    nz = n.new('ShaderNodeTexNoise', (-700, 0))
    nz.inputs['Scale'].default_value = 3
    nz.inputs['Detail'].default_value = 6
    n.link(mp, 0, nz, 'Vector')
    col = n.ramp(nz, 'Fac', [(0.62, '#e8e6df'), (0.66, '#2a2724'), (0.7, '#dcd9d0')])
    n.link(col, 0, n.bsdf, 'Base Color')
    n.set(Roughness=0.7)
    return n.mat


def bark(name, color='#6b4a33'):
    n = Nodes(name)
    mp = n.coords('Object', scale=(8, 8, 1))
    nz = n.new('ShaderNodeTexNoise', (-700, 0))
    nz.inputs['Scale'].default_value = 4
    nz.inputs['Detail'].default_value = 8
    n.link(mp, 0, nz, 'Vector')
    col = n.ramp(nz, 'Fac', [(0.3, _shade(color, 0.6)), (0.7, _shade(color, 1.2))])
    n.link(col, 0, n.bsdf, 'Base Color')
    n.bump(nz, 'Fac', strength=0.6, distance=0.02)
    n.set(Roughness=0.85)
    return n.mat


def water(name):
    n = Nodes(name)
    mp = n.coords('Object')
    wv = n.new('ShaderNodeTexNoise', (-700, 0))
    wv.inputs['Scale'].default_value = 1.4
    wv.inputs['Detail'].default_value = 4
    n.link(mp, 0, wv, 'Vector')
    n.bump(wv, 'Fac', strength=0.08, distance=0.02)
    n.set(**{'Base Color': _hex('#d8f0f2'), 'Roughness': 0.02, 'IOR': 1.33, 'Transmission Weight': 1.0})
    return n.mat


def pool_tiles(name):
    n = Nodes(name)
    mp = n.coords('Object')
    brick = n.new('ShaderNodeTexBrick', (-700, 0))
    brick.offset = 0.0
    brick.inputs['Scale'].default_value = 1.0
    brick.inputs['Mortar Size'].default_value = 0.002
    brick.inputs['Brick Width'].default_value = 0.025
    brick.inputs['Row Height'].default_value = 0.025
    brick.inputs['Color1'].default_value = _hex('#58b8c8')
    brick.inputs['Color2'].default_value = _hex('#4aa6ba')
    brick.inputs['Mortar'].default_value = _hex('#d8e8e8')
    n.link(mp, 0, brick, 'Vector')
    n.link(brick, 'Color', n.bsdf, 'Base Color')
    n.set(Roughness=0.2)
    return n.mat


def fire(name):
    """Flame sheet: tapered, noisy tongue that is white-yellow at the root and
    fades through orange to transparent. The 4D noise W input is animated per
    frame by the renderer (see walk.py) so the flames flicker."""
    n = Nodes(name)
    n.nt.nodes.remove(n.bsdf)
    tc = n.new('ShaderNodeTexCoord', (-1400, 0))
    sep = n.new('ShaderNodeSeparateXYZ', (-1200, 0))
    n.link(tc, 'Generated', sep, 'Vector')
    nz = n.new('ShaderNodeTexNoise', (-1000, -300))
    nz.noise_dimensions = '4D'
    nz.inputs['Scale'].default_value = 3.5
    nz.inputs['Detail'].default_value = 5
    mp = n.new('ShaderNodeMapping', (-1200, -300))
    mp.inputs['Scale'].default_value = (1.0, 1.0, 0.45)
    n.link(tc, 'Generated', mp, 'Vector')
    n.link(mp, 0, nz, 'Vector')
    # horizontal taper: 1 at the centre line, 0 at the sides
    cen = n.new('ShaderNodeMath', (-1000, 150))
    cen.operation = 'SUBTRACT'
    cen.inputs[1].default_value = 0.5
    n.link(sep, 'X', cen, 0)
    ab = n.new('ShaderNodeMath', (-850, 150))
    ab.operation = 'ABSOLUTE'
    n.link(cen, 0, ab, 0)
    # the tongue narrows with height
    narrow = n.new('ShaderNodeMath', (-850, 0))
    narrow.operation = 'MULTIPLY_ADD'
    narrow.inputs[1].default_value = -0.42
    narrow.inputs[2].default_value = 0.5
    n.link(sep, 'Z', narrow, 0)
    ratio = n.new('ShaderNodeMath', (-700, 100))
    ratio.operation = 'DIVIDE'
    n.link(ab, 0, ratio, 0)
    n.link(narrow, 0, ratio, 1)
    shape = n.new('ShaderNodeMath', (-550, 100))
    shape.operation = 'SUBTRACT'
    shape.inputs[0].default_value = 1.0
    n.link(ratio, 0, shape, 1)
    # add turbulence, subtract height
    turb = n.new('ShaderNodeMath', (-550, -150))
    turb.operation = 'MULTIPLY_ADD'
    turb.inputs[1].default_value = 0.9
    turb.inputs[2].default_value = -0.45
    n.link(nz, 'Fac', turb, 0)
    dens = n.new('ShaderNodeMath', (-400, 0))
    dens.operation = 'ADD'
    n.link(shape, 0, dens, 0)
    n.link(turb, 0, dens, 1)
    fall = n.new('ShaderNodeMath', (-250, 0))
    fall.operation = 'MULTIPLY_ADD'
    fall.inputs[1].default_value = -0.85
    n.link(sep, 'Z', fall, 0)
    n.link(dens, 0, fall, 2)
    col = n.ramp(fall, 0, [(0.18, (0.9, 0.18, 0.02, 1)), (0.4, (1.0, 0.45, 0.08, 1)), (0.65, (1.0, 0.78, 0.35, 1)), (0.9, (1.0, 0.95, 0.8, 1))], loc=(-50, 150))
    alpha = n.ramp(fall, 0, [(0.12, (0, 0, 0, 1)), (0.3, (1, 1, 1, 1))], loc=(-50, -150))
    em = n.new('ShaderNodeEmission', (250, 150))
    em.inputs['Strength'].default_value = 3.2
    n.link(col, 0, em, 'Color')
    tr = n.new('ShaderNodeBsdfTransparent', (250, -100))
    mix = n.new('ShaderNodeMixShader', (450, 0))
    n.link(alpha, 0, mix, 'Fac')
    n.link(tr, 0, mix, 1)
    n.link(em, 0, mix, 2)
    n.link(mix, 0, n.out, 'Surface')
    n.mat['noise'] = nz.name
    return n.mat


def painting_stripe(name):
    """Left artwork: warm white field, black vertical band, tan block top."""
    n = Nodes(name)
    tc = n.new('ShaderNodeTexCoord', (-1200, 0))
    sep = n.new('ShaderNodeSeparateXYZ', (-1000, 0))
    n.link(tc, 'Generated', sep, 'Vector')
    band = n.ramp(sep, 'Y', [(0.0, '#e9e5dc'), (0.32, '#e9e5dc'), (0.33, '#1c1b1a'), (0.44, '#1c1b1a'), (0.45, '#f1efe9')], loc=(-700, 100))
    top = n.ramp(sep, 'Z', [(0.0, (0, 0, 0, 1)), (0.8, (0, 0, 0, 1)), (0.81, (1, 1, 1, 1))], loc=(-700, -200))
    tan = n.new('ShaderNodeMix', (-350, 0))
    tan.data_type = 'RGBA'
    n.link(top, 0, tan, 'Factor')
    n.link(band, 0, tan, 6)
    tan.inputs[7].default_value = _hex('#a98f6b')
    tex = n.new('ShaderNodeTexNoise', (-700, -450))
    tex.inputs['Scale'].default_value = 40
    n.link(tc, 'Object', tex, 'Vector')
    n.link(tan, 2, n.bsdf, 'Base Color')
    n.bump(tex, 'Fac', strength=0.3, distance=0.002)
    n.set(Roughness=0.85)
    return n.mat


def painting_split(name):
    """Right artwork: pale upper field over a dark blue-grey textured base."""
    n = Nodes(name)
    tc = n.new('ShaderNodeTexCoord', (-1200, 0))
    sep = n.new('ShaderNodeSeparateXYZ', (-1000, 0))
    n.link(tc, 'Generated', sep, 'Vector')
    nz = n.new('ShaderNodeTexNoise', (-1000, -300))
    nz.inputs['Scale'].default_value = 9
    nz.inputs['Detail'].default_value = 10
    n.link(tc, 'Object', nz, 'Vector')
    dark = n.ramp(nz, 'Fac', [(0.35, '#2f3a42'), (0.65, '#5b6970')], loc=(-700, -300))
    light = n.ramp(nz, 'Fac', [(0.35, '#dcdad4'), (0.65, '#f4f3ef')], loc=(-700, 100))
    split = n.ramp(sep, 'Z', [(0.0, (0, 0, 0, 1)), (0.42, (0, 0, 0, 1)), (0.43, (1, 1, 1, 1))], loc=(-700, 350))
    mix = n.new('ShaderNodeMix', (-300, 0))
    mix.data_type = 'RGBA'
    n.link(split, 0, mix, 'Factor')
    n.link(dark, 0, mix, 6)
    n.link(light, 0, mix, 7)
    n.link(mix, 2, n.bsdf, 'Base Color')
    n.bump(nz, 'Fac', strength=0.35, distance=0.003)
    n.set(Roughness=0.8)
    return n.mat


def screen(name):
    return plain(name, '#050607', rough=0.04, coat=1.0, spec=0.6)


def emissive(name, color='#fff4e0', strength=6.0):
    n = Nodes(name)
    n.nt.nodes.remove(n.bsdf)
    em = n.new('ShaderNodeEmission', (200, 0))
    em.inputs['Color'].default_value = _hex(color)
    em.inputs['Strength'].default_value = strength
    n.link(em, 0, n.out, 'Surface')
    return n.mat
