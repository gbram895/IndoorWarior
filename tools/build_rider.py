"""Builds web/vendor/rider.js: the 3D view's rider, from MakeHuman's CC0 assets.

  python3 tools/build_rider.py <makehuman-data-dir> <skin.png> web/vendor/rider.js

<makehuman-data-dir> holds, from github.com/makehumancommunity/makehuman
(makehuman/data/...): 3dobjs/base.obj, rigs/default.mhskel,
rigs/default_weights.mhw and the macrodetails targets caucasian-male-young
and universal-male-young-{average,max}muscle-{min,average}weight.
<skin.png> is MakeHuman's young_lightskinned_male_diffuse.png (public domain).

The body is shaped as a lean, muscular man of 1.80 m, its 163 bones merged
into the 19 the 3D view poses, and a cycling kit painted onto its skin
(jersey, bib shorts, socks, shoes, mitts). Out comes one script that sets
window.IW_RIDER, so the page still works opened straight from disk.
"""
import base64, io, json, sys
import numpy as np
from PIL import Image, ImageFilter
sys.path.insert(0, __import__('os').path.dirname(__file__))
import mh_load

HEIGHT = 1.80
TEX = 1024

# Our bones, each made of MakeHuman's; head and tail joints from theirs.
SIDE = {'L': '.L', 'R': '.R'}
BONES = [('hips', ['root', 'spine05', 'pelvis.L', 'pelvis.R'], 'spine05', 'head', 'spine05', 'tail'),
         ('spineLow', ['spine04', 'spine03'], 'spine04', 'head', 'spine03', 'tail'),
         ('chest', ['spine02', 'spine01', 'breast.L', 'breast.R', 'clavicle.L', 'clavicle.R', 'shoulder01.L', 'shoulder01.R'], 'spine02', 'head', 'spine01', 'tail'),
         ('neck', ['neck01', 'neck02', 'neck03'], 'neck01', 'head', 'neck03', 'tail'),
         ('head', ['head', '*face'], 'head', 'head', 'head', 'tail')]
LIMBS = [('thigh', ['upperleg01', 'upperleg02'], 'upperleg01', 'head', 'upperleg02', 'tail'),
         ('shin', ['lowerleg01', 'lowerleg02'], 'lowerleg01', 'head', 'lowerleg02', 'tail'),
         ('foot', ['foot', '*toe'], 'foot', 'head', 'foot', 'tail'),
         ('upper', ['upperarm01', 'upperarm02'], 'upperarm01', 'head', 'upperarm02', 'tail'),
         ('fore1', ['lowerarm01'], 'lowerarm01', 'head', 'lowerarm01', 'tail'),
         ('fore2', ['lowerarm02'], 'lowerarm02', 'head', 'lowerarm02', 'tail'),
         ('hand', ['wrist', '*metacarpal'], 'wrist', 'head', 'metacarpal3', 'tail')]
LIMBS += [('fing%d%d' % (f, g), ['finger%d-%d' % (f, g)], 'finger%d-%d' % (f, g), 'head', 'finger%d-%d' % (f, g), 'tail') for f in range(1, 6) for g in range(1, 4)]
for name, members, hb, he, tb, te in LIMBS:
    for s in 'LR':
        BONES.append((name + s, [m + SIDE[s] if not m.startswith('*') else m + SIDE[s] for m in members], hb + SIDE[s], he, tb + SIDE[s], te))


def main(src, skin_path, out):
    v, vt, faces, skel, joints, mhw = mh_load.load(src)
    used = sorted({c[0] for f in faces for c in f})
    lo, hi = v[used, 1].min(), v[used, 1].max()
    s = HEIGHT / (hi - lo)
    # Into the 3D view's frame: metres, soles at y 0, facing -z, his right at +x.
    to = lambda p: np.array([-p[..., 0] * s, (p[..., 1] - lo) * s, -p[..., 2] * s]).T if p.ndim > 1 else np.array([-p[0] * s, (p[1] - lo) * s, -p[2] * s])
    J = lambda b, e: to(joints[skel['bones'][b][e]])

    # Which of our bones each of theirs belongs to.
    owner = {}
    for i, (name, members, *_) in enumerate(BONES):
        for m in members:
            if m.startswith('*'):
                key, side = m[1:].rstrip('.LR'), m[-2:] if m[-2:] in ('.L', '.R') else ''
                for b in skel['bones']:
                    if b.startswith(key) and b.endswith(side): owner[b] = i
            else:
                owner[m] = i
    face_bones = [b for b in skel['bones'] if b not in owner]  # jaw, eyes, tongue, the face's muscles
    for b in face_bones: owner[b] = 4
    W = np.zeros((len(v), len(BONES)))
    for b, lst in mhw.items():
        for vi, w in lst: W[vi, owner[b]] += w
    W /= np.maximum(W.sum(1, keepdims=True), 1e-9)

    # Bones: head, tail and a reference direction across each (its front, or for
    # forearms and hands the thumb side).
    bones = []
    for name, members, hb, he, tb, te in BONES:
        h, t = J(hb, he), J(tb, te)
        side = name[-1] if name[-1] in 'LR' else ''
        if name.startswith(('fore', 'hand', 'fing')):
            ref = J('finger2-1' + SIDE[side], 'head') - J('finger5-1' + SIDE[side], 'head')
        elif name.startswith('foot'):
            ref = np.array([0, 1.0, 0])
        elif name.startswith('upper'):
            ref = J('lowerarm02' + SIDE[side], 'tail') - h  # towards the hand: the inside of the elbow
        else:
            ref = np.array([0, 0, -1.0])  # forward
        ax = (t - h) / np.linalg.norm(t - h)
        ref = ref - ax * ref.dot(ax); ref /= np.linalg.norm(ref)
        bones.append({'name': name, 'h': h.round(4).tolist(), 't': t.round(4).tolist(), 'r': ref.round(4).tolist()})

    # Split vertices where the UV map has seams; triangulate the quads.
    key, verts, tris = {}, [], []
    for f in faces:
        ids = []
        for c in f:
            if c not in key: key[c] = len(verts); verts.append(c)
            ids.append(key[c])
        tris += [[ids[0], ids[i], ids[i + 1]] for i in range(1, len(ids) - 1)]
    verts, tris = np.array(verts), np.array(tris)
    P = to(v)
    shoe_n = shoe_feet(P, W, faces)
    # Normals on the welded mesh, so seams don't show.
    N = np.zeros_like(P)
    for f in faces:
        ids = [c[0] for c in f]
        for i in range(1, len(ids) - 1):
            a, b, c = P[ids[0]], P[ids[i]], P[ids[i + 1]]
            n = np.cross(b - a, c - a)
            for k in (ids[0], ids[i], ids[i + 1]): N[k] += n
    N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
    for i, n, wgt in shoe_n:  # the shoe's own smooth normals where the toes were folded away
        N[i] = N[i] * (1 - wgt) + n * wgt
    N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
    pos, nrm, uv, wts = P[verts[:, 0]], N[verts[:, 0]], vt[verts[:, 1]], W[verts[:, 0]]
    # Top four bones per vertex.
    top = np.argsort(-wts, axis=1)[:, :4]
    tw = np.take_along_axis(wts, top, 1); tw /= tw.sum(1, keepdims=True)
    tw8 = np.round(tw * 255).astype(int)
    tw8[:, 0] += 255 - tw8.sum(1)

    tex = paint(pos, nrm, uv, wts, tris, bones, Image.open(skin_path).convert('RGB'))
    buf = io.BytesIO(); tex.save(buf, 'JPEG', quality=86); jpg = buf.getvalue()

    b64 = lambda a: base64.b64encode(a.tobytes()).decode()
    data = {
        'height': HEIGHT, 'bones': bones,
        'pos': b64(np.round(pos * 10000).astype('<i2')), 'nrm': b64(np.round(nrm * 127).astype('i1')),
        'uv': b64(np.round(np.clip(uv, 0, 1) * 65535).astype('<u2')), 'idx': b64(tris.astype('<u2')),
        'si': b64(top.astype('u1')), 'sw': b64(tw8.astype('u1')),
        'ball': [to(np.mean([joints[skel['bones']['toe%d-1%s' % (t, SIDE[sd])]['head']] for t in (1, 5)], axis=0)).round(4).tolist() for sd in 'LR'],
        'sole': round(float(pos[:, 1].min()), 4),
        'skull': skull(pos, wts),
        'tex': 'data:image/jpeg;base64,' + base64.b64encode(jpg).decode(),
    }
    with open(out, 'w') as f:
        f.write('/* The 3D view\'s rider: MakeHuman\'s base mesh, shape targets, skeleton, weights and skin\n'
                '   (CC0 / public domain, makehumancommunity.org), merged to 19 bones with a cycling kit painted\n'
                '   on. Built by tools/build_rider.py. */\n')
        f.write('window.IW_RIDER = ' + json.dumps(data, separators=(',', ':')) + ';\n')
    print('verts', len(pos), 'tris', len(tris), 'jpg', len(jpg), 'bytes', __import__('os').path.getsize(out))


def shoe_feet(P, W, faces):
    """Turns the bare feet into shoes: every foot point below the shoe's top is
    moved onto a smooth shoe surface (sections from heel to toe), so the toes
    vanish into one toe box. The ankle above stays the body's."""
    body = np.array(sorted({c[0] for f in faces for c in f}))
    out = []
    T = [0, 0.1, 0.3, 0.6, 0.8, 0.93, 1]
    HW = [0.03, 0.036, 0.04, 0.043, 0.04, 0.031, 0.01]   # half widths: inside the shoe drawn over it
    TOP = [0.07, 0.08, 0.072, 0.058, 0.046, 0.036, 0.024]  # heights above the sole
    for side in (-1, 1):
        f = body[(P[body, 1] < 0.12) & (np.sign(P[body, 0]) == side)]
        f = f[(W[f, 9] + W[f, 10]) > 0.2]
        heel, toe = P[f, 2].max(), P[f, 2].min()
        t = np.clip((heel - P[f, 2]) / (heel - toe), 0, 1)
        hw, top = np.interp(t, T, HW), np.interp(t, T, TOP)
        cx = np.interp(t, *zip(*sorted((tt, x) for tt, x in zip(np.round(t, 1), P[f, 0]))))  # rough centre line
        cxs = {}
        for tt in np.unique(np.round(t, 1)):
            cxs[tt] = P[f[np.round(t, 1) == tt], 0].mean()
        cx = np.interp(t, sorted(cxs), [cxs[k] for k in sorted(cxs)])
        cy = top / 2 + 0.006
        th = np.arctan2((P[f, 1] - cy) / np.maximum(top / 2, 1e-3), (P[f, 0] - cx) / hw)
        target = np.stack([cx + hw * np.cos(th), cy + top / 2 * np.sin(th), P[f, 2]], 1)
        target[:, 1] = np.maximum(target[:, 1], 0.012)  # up off the shoe's sole
        wgt = np.clip((top + 0.012 - P[f, 1]) / 0.012, 0, 1)[:, None]
        P[f] += (target - P[f]) * wgt
        nrm = np.stack([np.cos(th) / hw, np.sin(th) / np.maximum(top / 2, 1e-3), -np.clip((t - 0.85) / 0.15, 0, 1) * 40], 1)
        nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
        out += list(zip(f, nrm, wgt[:, 0]))
    return out


def skull(pos, wts):
    """The head's extent above the ears, for the helmet."""
    p = pos[wts[:, 4] > 0.9]
    top = p[:, 1].max()
    cap = p[p[:, 1] > top - 0.09]
    return {'top': round(float(top), 4), 'c': cap.mean(0).round(4).tolist(),
            'w': round(float(np.ptp(cap[:, 0])), 4), 'l': round(float(np.ptp(cap[:, 2])), 4)}


def along(p, h, t):
    d = np.array(t) - np.array(h)
    return ((p - h) @ d) / d.dot(d)


def paint(pos, nrm, uv, wts, tris, bones, skin):
    """Paints the kit onto the skin, deciding every texel from the body point it
    lands on, so hems and panels follow the body rather than the UV islands."""
    S = TEX * 2
    base = np.asarray(skin.resize((S, S), Image.BICUBIC)).astype(float) / 255
    out = base.copy()
    lum = base.mean(2); shade = np.clip(0.82 + 0.35 * (lum - np.median(lum)) / max(lum.std(), 1e-3) * 0.15, 0.7, 1.08)
    painted = np.zeros((S, S), bool)
    B = {b['name']: b for b in bones}
    px = uv[:, 0] * S - 0.5; py = (1 - uv[:, 1]) * S - 0.5
    for t in tris:
        x, y = px[t], py[t]
        x0, x1 = int(np.floor(x.min())), int(np.ceil(x.max())) + 1
        y0, y1 = int(np.floor(y.min())), int(np.ceil(y.max())) + 1
        if x1 <= x0 or y1 <= y0: continue
        gx, gy = np.meshgrid(np.arange(x0, x1), np.arange(y0, y1))
        d = (y[1] - y[2]) * (x[0] - x[2]) + (x[2] - x[1]) * (y[0] - y[2])
        if abs(d) < 1e-12: continue
        l0 = ((y[1] - y[2]) * (gx - x[2]) + (x[2] - x[1]) * (gy - y[2])) / d
        l1 = ((y[2] - y[0]) * (gx - x[2]) + (x[0] - x[2]) * (gy - y[2])) / d
        l2 = 1 - l0 - l1
        m = (l0 >= -0.02) & (l1 >= -0.02) & (l2 >= -0.02) & (gx >= 0) & (gy >= 0) & (gx < S) & (gy < S)
        if not m.any(): continue
        L = np.stack([l0[m], l1[m], l2[m]], 1)
        p = L @ pos[t]; n = L @ nrm[t]; w = L @ wts[t]
        col, flat = kit(p, n, w, B)
        X, Y = gx[m], gy[m]
        k = ~np.isnan(col[:, 0])
        sh = np.where(flat, 0.95 + 0.05 * shade[Y, X], shade[Y, X])
        out[Y[k], X[k]] = col[k] * sh[k, None]
        painted[Y, X] = True
    img = Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8))
    return img.resize((TEX, TEX), Image.LANCZOS)


ORANGE, BLACK, WHITE = np.array([0.98, 0.42, 0.05]), np.array([0.05, 0.05, 0.06]), np.array([0.93, 0.93, 0.92])
HAIR = np.array([0.16, 0.11, 0.07])


def kit(p, n, w, B):
    """Colour for body points p (n normals, w bone weights); NaN keeps the skin."""
    col = np.full((len(p), 3), np.nan)
    flat = np.zeros(len(p), bool)  # no skin creases showing through (shoes)
    g = np.argmax(w, 1)
    names = [b for b in ['hips', 'spineLow', 'chest', 'neck', 'head', 'thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR',
                         'upperL', 'upperR', 'fore1L', 'fore1R', 'fore2L', 'fore2R', 'handL', 'handR']]
    torso = (w[:, 0] + w[:, 1] + w[:, 2]) > 0.4
    hipY = B['thighL']['h'][1]
    hem = hipY + 0.07  # jersey hem, a little above the hip joints
    # Bib shorts: the hips below the hem and the thighs to a hand above the knee.
    tl = np.where(p[:, 0] < 0, along(p, B['thighL']['h'], B['thighL']['t']), along(p, B['thighR']['h'], B['thighR']['t']))
    legish = (w[:, 5] + w[:, 6]) > 0.5
    shorts = ((torso | legish) & (p[:, 1] < hem) & (tl < 0.74)) & ~((w[:, 7] + w[:, 8]) > 0.5)
    col[shorts] = BLACK * 1.4
    grip = shorts & (tl > 0.66)
    col[grip] = BLACK * 0.8
    # Jersey: the torso above the hem, the neck's base, the sleeves.
    ul = np.where(p[:, 0] < 0, along(p, B['upperL']['h'], B['upperL']['t']), along(p, B['upperR']['h'], B['upperR']['t']))
    arm = (w[:, 11] + w[:, 12]) > 0.5
    neckBase = (w[:, 3] > 0.25) & (p[:, 1] < B['neck']['h'][1] + 0.022)
    jersey = (torso & (p[:, 1] >= hem)) | (arm & (ul < 0.55)) | neckBase
    jc = np.tile(ORANGE, (len(p), 1))
    chestY0 = B['chest']['h'][1] + 0.45 * (B['chest']['t'][1] - B['chest']['h'][1])
    front = n[:, 2] < -0.2; back = n[:, 2] > 0.2
    sidep = torso & (np.abs(n[:, 0]) > 0.86) & (p[:, 1] < chestY0)
    jc[sidep] = BLACK
    chestY = B['chest']['h'][1] + 0.62 * (B['chest']['t'][1] - B['chest']['h'][1])
    band = torso & (np.abs(p[:, 1] - chestY) < 0.022) & (np.abs(n[:, 2]) > 0.45)
    jc[band] = WHITE
    jc[arm & (ul > 0.45)] = WHITE  # cuffs
    jc[torso & front & (np.abs(p[:, 0]) < 0.006) & (p[:, 1] > hem + 0.05)] = BLACK * 2  # zip
    jc[neckBase & (p[:, 1] > B['neck']['h'][1] - 0.005)] = BLACK  # collar
    pocket = torso & back & (p[:, 1] > hem) & (p[:, 1] < hem + 0.17)
    jc[pocket] = ORANGE * 0.84
    jc[pocket & (np.abs(np.abs(p[:, 0]) - 0.055) < 0.004)] = ORANGE * 0.6
    jc[torso & (np.abs(p[:, 1] - hem) < 0.012) & (p[:, 1] >= hem)] = BLACK * 2  # hem gripper
    col[jersey] = jc[jersey]
    # Socks and shoes.
    sl = np.where(p[:, 0] < 0, along(p, B['shinL']['h'], B['shinL']['t']), along(p, B['shinR']['h'], B['shinR']['t']))
    shin = (w[:, 7] + w[:, 8]) > 0.5
    foot = (w[:, 9] + w[:, 10]) > 0.5
    ankleY = B['footL']['h'][1]
    col[(shin & (sl > 0.7)) | (foot & (p[:, 1] >= ankleY - 0.035))] = WHITE
    shoe = (foot | shin) & (p[:, 1] < ankleY - 0.035)
    col[shoe] = WHITE * 0.97
    flat |= shoe
    # Mitts: the palm and the back of the hand, fingers bare from the first knuckle.
    hand = (w[:, 17] + w[:, 18]) > 0.5
    hl = np.where(p[:, 0] < 0, along(p, B['handL']['h'], B['handL']['t']), along(p, B['handR']['h'], B['handR']['t']))
    mitt = (hand & (hl < 1.25)) | (((w[:, 15] + w[:, 16]) > 0.5) & (np.where(p[:, 0] < 0, along(p, B['fore2L']['h'], B['fore2L']['t']), along(p, B['fore2R']['h'], B['fore2R']['t'])) > 0.85))
    for f in range(2, 6):  # the mitts end halfway along the first finger bones
        for sd in 'LR':
            bn = B['fing%d1%s' % (f, sd)]; i = list(B).index('fing%d1%s' % (f, sd))
            mitt |= (w[:, i] > 0.5) & (along(p, bn['h'], bn['t']) < 0.45) & ((p[:, 0] < 0) == (sd == 'L'))
    col[mitt] = BLACK * 1.6
    # Short hair under the helmet: the scalp above the ears and round the back.
    head = w[:, 4] > 0.5
    eyeY = B['head']['h'][1] + 0.42 * (B['head']['t'][1] - B['head']['h'][1])
    scalp = head & ((p[:, 1] > eyeY + 0.065) | ((n[:, 2] > 0.25) & (p[:, 1] > B['head']['h'][1] + 0.02)))
    col[scalp] = HAIR
    return col, flat


if __name__ == '__main__':
    main(*sys.argv[1:4])
