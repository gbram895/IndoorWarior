"""Loads MakeHuman's CC0 base mesh, shape targets, skeleton and weights."""
import json, os
import numpy as np


def load_obj(path):
    v, vt, faces, group = [], [], [], None
    for line in open(path):
        if line.startswith('v '):
            v.append([float(x) for x in line.split()[1:4]])
        elif line.startswith('vt '):
            vt.append([float(x) for x in line.split()[1:3]])
        elif line.startswith('g '):
            group = line.split()[1]
        elif line.startswith('f ') and group == 'body':
            faces.append([tuple(int(i) - 1 for i in c.split('/')[:2]) for c in line.split()[1:]])
    return np.array(v), np.array(vt), faces


def apply_target(v, path, weight):
    for line in open(path):
        if line[0].isdigit():
            i, dx, dy, dz = line.split()
            v[int(i)] += weight * np.array([float(dx), float(dy), float(dz)])


def load(src, muscle=0.65, weight=0.3):
    """muscle/weight as MakeHuman's sliders (0..1, 0.5 average). Male, 25, European."""
    v, vt, faces = load_obj(os.path.join(src, 'base.obj'))
    apply_target(v, os.path.join(src, 'caucasian-male-young.target'), 1.0)
    mx = max(0.0, (muscle - 0.5) * 2); mw = {'maxmuscle': mx, 'averagemuscle': 1 - mx}
    mn = max(0.0, (0.5 - weight) * 2); ww = {'minweight': mn, 'averageweight': 1 - mn}
    for m, a in mw.items():
        for w, b in ww.items():
            apply_target(v, os.path.join(src, f'universal-male-young-{m}-{w}.target'), a * b)
    skel = json.load(open(os.path.join(src, 'default.mhskel')))
    weights = json.load(open(os.path.join(src, 'default_weights.mhw')))['weights']
    joints = {k: v[idx].mean(axis=0) for k, idx in skel['joints'].items()}
    return v, vt, faces, skel, joints, weights
