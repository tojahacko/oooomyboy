"""Garden vegetation built as real meshes (numpy), no particle systems.

Particle instances cost Cycles a full instance sync on every render (about
20 s a frame here), so every leaf, needle and grass blade is baked into a
handful of prototype meshes: a few birches, pines, thujas, shrubs, an
ornamental grass clump and a seamless 1 m lawn tile. Placements are cheap
collection instances of those prototypes.

Birch crowns grow leaves along a real twig network (main branches, then
drooping secondary twigs), so they have the open, clumpy, see-through look of
real trees instead of solid blobs.
"""
import math

import bpy
import numpy as np
from mathutils import Matrix, Vector

RNG = np.random.default_rng(34)


# ---------------------------------------------------------------- mesh building

def build_mesh(name, verts, faces, mat_index=None, face_rand=None):
    """Fast mesh from numpy arrays. faces: (n, 3) or (n, 4) int array."""
    verts = np.asarray(verts, dtype=np.float32).reshape(-1, 3)
    faces = np.asarray(faces, dtype=np.int32)
    k = faces.shape[1]
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(verts))
    me.vertices.foreach_set('co', verts.ravel())
    me.loops.add(faces.size)
    me.loops.foreach_set('vertex_index', faces.ravel())
    me.polygons.add(len(faces))
    me.polygons.foreach_set('loop_start', np.arange(0, faces.size, k, dtype=np.int32))
    if mat_index is not None:
        me.polygons.foreach_set('material_index', np.asarray(mat_index, dtype=np.int32))
    if face_rand is not None:
        a = me.attributes.new('leafrand', 'FLOAT', 'FACE')
        a.data.foreach_set('value', np.asarray(face_rand, dtype=np.float32))
    me.update()
    me.validate(clean_customdata=False)
    return me


def random_rotations(n, up_bias=0.0):
    """n random rotation matrices; up_bias > 0 tilts the local +z (leaf
    normal) towards world up, as real leaves face the light."""
    q = RNG.normal(size=(n, 4))
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    w, x, y, z = q.T
    R = np.stack([
        np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], -1),
        np.stack([2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], -1),
        np.stack([2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)], -1),
    ], 1)
    if up_bias:
        # blend each basis towards identity then re-orthonormalise
        R = R * (1 - up_bias) + np.eye(3)[None] * up_bias
        u, _, vt = np.linalg.svd(R)
        R = u @ vt
    return R


def scatter(template_v, template_f, pos, rot, scale):
    """Copies of a small template mesh: returns verts, faces, per-face rand."""
    n = len(pos)
    tv = np.asarray(template_v, dtype=np.float64)
    tf = np.asarray(template_f, dtype=np.int32)
    v = np.einsum('nij,kj->nki', rot * scale[:, None, None], tv) + pos[:, None, :]
    f = tf[None] + (np.arange(n) * len(tv))[:, None, None]
    r = np.repeat(RNG.random(n), len(tf))
    return v.reshape(-1, 3), f.reshape(-1, tf.shape[1]), r


def tube(points, radii, sides=5):
    """Tapered tube along a polyline: verts, quads."""
    pts = [Vector(p) for p in points]
    verts, faces = [], []
    for i, (p, r) in enumerate(zip(pts, radii)):
        d = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        a = d.orthogonal().normalized()
        b = d.cross(a)
        for s in range(sides):
            t = 2 * math.pi * s / sides
            verts.append(tuple(p + (a * math.cos(t) + b * math.sin(t)) * r))
    for i in range(len(pts) - 1):
        for s in range(sides):
            a0, a1 = i * sides + s, i * sides + (s + 1) % sides
            faces.append((a0, a1, a1 + sides, a0 + sides))
    return verts, faces


class Builder:
    """Accumulates tubes (bark, material 0) and leaf triangles (material 1)."""

    def __init__(self):
        self.v, self.f, self.m, self.r = [], [], [], []
        self.n = 0

    def add(self, verts, faces, mat, rand=None):
        verts = np.asarray(verts, dtype=np.float64).reshape(-1, 3)
        faces = np.asarray(faces, dtype=np.int32)
        if faces.shape[1] == 4:  # split quads so everything is triangles
            faces = np.concatenate([faces[:, [0, 1, 2]], faces[:, [0, 2, 3]]])
            if rand is not None:
                rand = np.concatenate([rand, rand])
        self.v.append(verts)
        self.f.append(faces + self.n)
        self.m.append(np.full(len(faces), mat))
        self.r.append(rand if rand is not None else np.zeros(len(faces)))
        self.n += len(verts)

    def mesh(self, name):
        return build_mesh(name, np.concatenate(self.v), np.concatenate(self.f),
                          np.concatenate(self.m), np.concatenate(self.r))


# ---------------------------------------------------------------- templates

BIRCH_LEAF_V = [(0, 0, 0), (0.012, 0.012, 0.002), (0.02, 0.03, 0.004), (0.016, 0.048, 0.003), (0, 0.064, 0),
                (-0.016, 0.048, 0.003), (-0.02, 0.03, 0.004), (-0.012, 0.012, 0.002), (0, 0.03, 0.006)]
BIRCH_LEAF_F = [(i, (i + 1) % 8, 8) for i in range(8)]


def needle_tuft():
    v, f = [], []
    for k in range(3):
        a = k * math.pi / 3
        ca, sa = math.cos(a), math.sin(a)
        b = len(v)
        v += [(-0.012 * ca, -0.012 * sa, 0), (0.012 * ca, 0.012 * sa, 0), (0.07 * ca, 0.07 * sa, 0.2), (-0.07 * ca, -0.07 * sa, 0.2)]
        f += [(b, b + 1, b + 2), (b, b + 2, b + 3)]
    return v, f


def spray():
    v = [(0, 0, 0), (0.035, 0.02, 0.06), (0, 0.012, 0.14), (-0.035, 0.02, 0.06)]
    return v, [(0, 1, 2), (0, 2, 3)]


# ---------------------------------------------------------------- prototypes

def birch(seed, height=12.0, leaves_per_twig=380, leaf_scale=2.0):
    rng = np.random.default_rng(seed)
    B = Builder()
    top = Vector((rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3), height * 0.9))
    trunk = [Vector((0, 0, 0)).lerp(top, t) + Vector((0.08 * math.sin(t * 7 + seed), 0.06 * math.cos(t * 5), 0)) for t in np.linspace(0, 1, 9)]
    B.add(*tube(trunk, np.linspace(0.17, 0.035, 9), 10), 0)
    leaf_pos, twig_count = [], 0
    for i in range(15):
        t = rng.uniform(0.34, 0.97)
        p0 = Vector((0, 0, 0)).lerp(top, t)
        az = rng.uniform(0, 2 * math.pi)
        el = math.radians(rng.uniform(28, 58))
        length = height * 0.22 * (1.15 - t) + rng.uniform(0.4, 1.0)
        d = Vector((math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el)))
        p1 = p0 + d * length * 0.55 + Vector((0, 0, 0.15))
        p2 = p0 + d * length + Vector((0, 0, -0.1))
        B.add(*tube([p0, p1, p2], [0.05 * (1.2 - t), 0.03, 0.012], 5), 0)
        for j in range(rng.integers(6, 10)):
            s = rng.uniform(0.25, 1.0)
            q0 = p0.lerp(p1, s * 2) if s < 0.5 else p1.lerp(p2, s * 2 - 1)
            az2 = az + rng.uniform(-1.2, 1.2)
            tl = rng.uniform(0.7, 1.6)
            dd = Vector((math.cos(az2), math.sin(az2), rng.uniform(-0.1, 0.4)))
            q1 = q0 + dd * tl * 0.5
            q2 = q1 + (dd * 0.4 + Vector((0, 0, -0.9))) * tl * 0.5  # weeping tips
            B.add(*tube([q0, q1, q2], [0.012, 0.007, 0.003], 4), 0)
            twig_count += 1
            u = rng.random(leaves_per_twig)
            seg = np.where(u < 0.5, 0, 1)
            a = np.where(seg[:, None] == 0, np.array(q0)[None], np.array(q1)[None])
            b = np.where(seg[:, None] == 0, np.array(q1)[None], np.array(q2)[None])
            w = (u * 2 % 1)[:, None]
            pts = a + (b - a) * w + rng.normal(scale=0.14, size=(leaves_per_twig, 3))
            leaf_pos.append(pts)
    pos = np.concatenate(leaf_pos)
    n = len(pos)
    v, f, r = scatter(BIRCH_LEAF_V, BIRCH_LEAF_F, pos, random_rotations(n, 0.35), rng.uniform(0.7, 1.3, n) * leaf_scale)
    B.add(v, f, 1, r)
    return B, height


def pine(seed, height=18.0, tufts_per_cluster=420, scale=1.7):
    rng = np.random.default_rng(seed)
    B = Builder()
    top = Vector((rng.uniform(-0.4, 0.4), rng.uniform(-0.4, 0.4), height * 0.94))
    trunk = [Vector((0, 0, 0)).lerp(top, t) + Vector((0.12 * math.sin(t * 4 + seed), 0.1 * math.sin(t * 3), 0)) for t in np.linspace(0, 1, 10)]
    B.add(*tube(trunk, np.linspace(0.24, 0.05, 10), 10), 0)
    tv, tf = needle_tuft()
    clusters = []
    for i in range(16):
        t = rng.uniform(0.62, 0.99)
        p0 = Vector((0, 0, 0)).lerp(top, t)
        az = rng.uniform(0, 2 * math.pi)
        ln = rng.uniform(1.0, 2.8) * (1.2 - t) + 0.4
        d = Vector((math.cos(az), math.sin(az), rng.uniform(0.15, 0.6))).normalized()
        p1 = p0 + d * ln
        B.add(*tube([p0, p0.lerp(p1, 0.5) + Vector((0, 0, 0.2)), p1], [0.07, 0.04, 0.02], 5), 0)
        for k in range(rng.integers(2, 4)):
            c = p1 + Vector((rng.normal(0, 0.4), rng.normal(0, 0.4), rng.normal(0.1, 0.15)))
            clusters.append((c, rng.uniform(0.6, 1.0)))
    clusters.append((top + Vector((0, 0, 0.4)), 0.8))
    pts = []
    for c, rad in clusters:
        m = rng.normal(size=(tufts_per_cluster, 3)) * np.array([rad, rad, rad * 0.45]) * 0.55
        pts.append(np.array(c)[None] + m)
    pos = np.concatenate(pts)
    n = len(pos)
    v, f, r = scatter(tv, tf, pos, random_rotations(n, 0.5), rng.uniform(0.7, 1.2, n) * scale)
    B.add(v, f, 1, r)
    return B, height


def thuja(seed, height=3.6, count=5200):
    """Emerald thuja: a dense narrow cone of scale-leaf sprays around a core."""
    rng = np.random.default_rng(seed)
    B = Builder()
    rings, sides = 14, 14
    cv, cf = [], []
    for i in range(rings + 1):
        t = i / rings
        z = height * t
        rad = height * 0.15 * (1 - t) ** 0.9 + 0.02
        for s in range(sides):
            a = 2 * math.pi * s / sides
            jit = 1 + 0.18 * math.sin(a * 3 + i) * math.cos(i * 1.7 + s)
            cv.append((rad * jit * math.cos(a), rad * jit * math.sin(a), z))
    for i in range(rings):
        for s in range(sides):
            a0, a1 = i * sides + s, i * sides + (s + 1) % sides
            cf.append((a0, a1, a1 + sides, a0 + sides))
    B.add(cv, cf, 1)
    t = rng.random(count) ** 0.8
    a = rng.uniform(0, 2 * math.pi, count)
    rad = (height * 0.15 * (1 - t) ** 0.9 + 0.02) * rng.uniform(0.85, 1.25, count)
    pos = np.stack([rad * np.cos(a), rad * np.sin(a), t * height], -1)
    sv, sf = spray()
    v, f, r = scatter(sv, sf, pos, random_rotations(count, 0.2), rng.uniform(0.9, 1.6, count))
    B.add(v, f, 1, r)
    return B, height


def shrub(seed, count=9000):
    rng = np.random.default_rng(seed)
    B = Builder()
    blobs = [(np.array([rng.normal(0, 0.25), rng.normal(0, 0.25), rng.uniform(0.3, 0.6)]), rng.uniform(0.35, 0.55)) for _ in range(5)]
    pts = []
    for c, rad in blobs:
        d = rng.normal(size=(count // 5, 3))
        d /= np.linalg.norm(d, axis=1, keepdims=True)
        pts.append(c + d * rad * rng.random((count // 5, 1)) ** 0.4)
    pos = np.concatenate(pts)
    for k in range(10):
        c = blobs[k % 5][0]
        B.add(*tube([(0, 0, 0), tuple(c * 0.6), tuple(c)], [0.02, 0.012, 0.006], 4), 0)
    n = len(pos)
    v, f, r = scatter(BIRCH_LEAF_V, BIRCH_LEAF_F, pos, random_rotations(n, 0.3), rng.uniform(0.7, 1.2, n) * 1.3)
    B.add(v, f, 1, r)
    return B, 1.0


def ornamental_grass(seed, blades=520):
    """Arching clump like the miscanthus in the terrace planters."""
    rng = np.random.default_rng(seed)
    v, f, r = [], [], []
    for b in range(blades):
        a = rng.uniform(0, 2 * math.pi)
        h = rng.uniform(0.45, 0.9)
        lean = rng.uniform(0.1, 0.7)
        w = rng.uniform(0.004, 0.007)
        ox, oy = rng.normal(0, 0.06, 2)
        ca, sa = math.cos(a), math.sin(a)
        base = len(v)
        segs = 6
        for i in range(segs + 1):
            t = i / segs
            bend = lean * t * t * h
            cx, cy, cz = ox + ca * bend, oy + sa * bend, h * t * (1 - 0.3 * lean * t)
            ww = w * (1 - 0.9 * t)
            v += [(cx - sa * ww, cy + ca * ww, cz), (cx + sa * ww, cy - ca * ww, cz)]
        for i in range(segs):
            f.append((base + 2 * i, base + 2 * i + 1, base + 2 * i + 3, base + 2 * i + 2))
        r += [rng.random()] * segs
    B = Builder()
    B.add(v, f, 1, np.array(r))
    return B, 0.9


def lawn_tile(seed, size=0.5, density=36000):
    """Seamless square patch of lawn centred on the origin, blades 4-10 cm,
    `density` blades per square metre."""
    rng = np.random.default_rng(seed)
    n = int(density * size * size)
    x = (rng.random(n) - 0.5) * size
    y = (rng.random(n) - 0.5) * size
    a = rng.uniform(0, 2 * math.pi, n)
    h = rng.uniform(0.04, 0.1, n)
    lean = rng.uniform(0.1, 0.7, n)
    w = rng.uniform(0.0015, 0.0028, n)
    segs = 3
    ts = np.linspace(0, 1, segs + 1)
    ca, sa = np.cos(a), np.sin(a)
    bend = lean[:, None] * ts[None] ** 2 * h[:, None]
    cx = x[:, None] + ca[:, None] * bend
    cy = y[:, None] + sa[:, None] * bend
    cz = h[:, None] * ts[None] * (1 - 0.2 * lean[:, None] * ts[None])
    ww = w[:, None] * (1 - 0.92 * ts[None])
    left = np.stack([cx - sa[:, None] * ww, cy + ca[:, None] * ww, cz], -1)
    right = np.stack([cx + sa[:, None] * ww, cy - ca[:, None] * ww, cz], -1)
    verts = np.stack([left, right], 2).reshape(n, -1, 3)  # (n, 2*(segs+1), 3)
    k = verts.shape[1]
    base = (np.arange(n) * k)[:, None]
    quads = []
    for i in range(segs):
        quads.append(np.stack([base[:, 0] + 2 * i, base[:, 0] + 2 * i + 1, base[:, 0] + 2 * i + 3, base[:, 0] + 2 * i + 2], -1))
    faces = np.stack(quads, 1).reshape(-1, 4)
    rand = np.repeat(rng.random(n), segs)
    B = Builder()
    B.add(verts.reshape(-1, 3), faces, 1, rand)
    return B, 0.1


# ---------------------------------------------------------------- placement

PROTOS = {}


def prototype(key, make, materials, protos_parent):
    """Build once, store in its own collection (excluded from rendering
    directly); returns (collection, nominal height)."""
    if key in PROTOS:
        return PROTOS[key]
    B, h = make()
    me = B.mesh(key)
    for m in materials:
        me.materials.append(m)
    for p in me.polygons:
        p.use_smooth = False
    ob = bpy.data.objects.new(key, me)
    coll = bpy.data.collections.new(f'proto_{key}')
    coll.objects.link(ob)
    protos_parent.children.link(coll)
    PROTOS[key] = (coll, h)
    return PROTOS[key]


def place(name, proto, loc, rot_z=0.0, scale=1.0, parent_coll='garden'):
    coll, _ = proto
    e = bpy.data.objects.new(name, None)
    e.instance_type = 'COLLECTION'
    e.instance_collection = coll
    e.location = loc
    e.rotation_euler = (0, 0, rot_z)
    e.scale = (scale, scale, scale)
    bpy.data.collections[parent_coll].objects.link(e)
    return e
