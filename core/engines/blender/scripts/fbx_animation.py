from contextlib import contextmanager
from types import FunctionType

import bpy


def action_frames(reference, numpy, first, last):
    # The all-actions exporter passes an (object, action) reference.
    action = reference[1] if isinstance(reference, tuple) and len(reference) == 2 else reference
    frames = {first, last}
    if isinstance(action, bpy.types.Action):
        for layer in action.layers:
            for strip in layer.strips:
                for channelbag in strip.channelbags:
                    for curve in channelbag.fcurves:
                        keys = curve.keyframe_points
                        coords = numpy.empty(len(keys) * 2, dtype=numpy.float32)
                        keys.foreach_get("co", coords)
                        times = coords[::2]
                        frames.update(times[(times > first) & (times < last)].tolist())
    return numpy.array(sorted(frames), dtype=numpy.float64)


class BakeFrames:
    def __init__(self, numpy, action, first, last, step):
        self.numpy = numpy
        self.action = action
        self.first = first
        self.last = last
        self.step = step
        self.used = False

    def __getattr__(self, name):
        return getattr(self.numpy, name)

    def arange(self, *args, **kwargs):
        numpy = self.numpy
        regular = numpy.arange(*args, **kwargs)
        if args != (self.first, numpy.nextafter(self.last, numpy.inf)) or kwargs != {"step": self.step}:
            return regular
        self.used = True
        authored = action_frames(self.action, numpy, self.first, self.last)
        interior = regular[(regular > self.first) & (regular < self.last)]
        right = numpy.searchsorted(authored, interior)
        distance = numpy.minimum(interior - authored[right - 1], authored[right] - interior)
        # Blender stores action key times in float32. Use the authored time when
        # an otherwise identical bake frame differs only by one representable step.
        one_ulp = numpy.spacing(numpy.abs(interior).astype(numpy.float32))
        return numpy.sort(numpy.concatenate((authored, interior[distance > one_ulp])))


@contextmanager
def preserve_fbx_samples(issues, animated):
    if not animated:
        yield
        return
    from io_scene_fbx import export_fbx_bin as exporter

    bake = getattr(exporter, "fbx_animations_do", None)
    issue = "fbx-animation-sampling-unsupported"
    if (not isinstance(bake, FunctionType) or "np" not in bake.__globals__ or
            bake.__code__.co_varnames[:4] != ("scene_data", "ref_id", "f_start", "f_end") or
            not {"arange", "nextafter"}.issubset(bake.__code__.co_names)):
        issues.add(issue)
        yield
        return

    def sample(scene_data, ref_id, f_start, f_end, *args, **kwargs):
        # Give this bake its own NumPy proxy. Geometry code and Blender's global
        # NumPy module keep their original range implementation.
        globals_for_bake = dict(bake.__globals__)
        frames = BakeFrames(globals_for_bake["np"], ref_id, f_start, f_end, scene_data.settings.bake_anim_step)
        globals_for_bake["np"] = frames
        patched = FunctionType(bake.__code__, globals_for_bake, bake.__name__, bake.__defaults__, bake.__closure__)
        patched.__kwdefaults__ = bake.__kwdefaults__
        result = patched(scene_data, ref_id, f_start, f_end, *args, **kwargs)
        if f_end > f_start and not frames.used:
            issues.add(issue)
        return result

    exporter.fbx_animations_do = sample
    try:
        yield
    finally:
        exporter.fbx_animations_do = bake
