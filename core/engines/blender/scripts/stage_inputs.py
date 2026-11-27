import json
import os
import re
import shutil
import struct
from pathlib import Path
from urllib.parse import unquote


MIB = 1024 * 1024
IMAGES = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tga", ".tif", ".tiff", ".exr", ".hdr", ".dds", ".ktx2"}
OBJ_KEYS = {"v", "vn", "vt", "f", "l", "p", "o", "g", "s", "usemtl"}
MTL_KEYS = {"newmtl", "ka", "kd", "ks", "ke", "tf", "ns", "ni", "d", "tr", "illum", "pr", "pm", "ps", "pc", "pcr", "aniso", "anisor"}
MTL_MAPS = {"map_ka", "map_kd", "map_ks", "map_ke", "map_ns", "map_d", "bump", "map_bump", "disp", "norm",
            "map_pr", "map_pm", "map_ps", "map_rma", "map_orm"}


class InputIssue(Exception):
    pass


class Inputs:
    def __init__(self, root, source, workspace):
        self.root = root
        self.source = source
        self.directory = workspace / "input"
        self.directory.mkdir()
        self.copies = {}
        self.bytes = 0
        self.issues = set()

    def contained(self, location, suffixes):
        # Normalize lexically before touching the filesystem, then reject linked children.
        path = Path(os.path.abspath(location))
        if not path.is_relative_to(self.root) or path.suffix.lower() not in suffixes:
            return None
        return path if path.resolve() == path and path.is_file() else None

    def resolve(self, parent, reference, suffixes):
        reference = reference.strip().replace("\\", "/")
        if not reference or reference.startswith("/") or re.search(r'[:\x00-\x1f\x7f]', reference):
            return None
        return self.contained(parent / reference, suffixes)

    def copy(self, path):
        if path in self.copies:
            return self.copies[path]
        size = path.stat().st_size
        self.bytes += size
        if self.bytes > 512 * MIB or len(self.copies) >= 512:
            raise InputIssue("model-dependency-limit")
        target = self.directory / f"dependency-{len(self.copies)}{path.suffix.lower()}"
        shutil.copyfile(path, target)
        self.copies[path] = target.name
        return target.name

    def obj(self):
        target = self.directory / "model.obj"
        materials = {}
        with target.open("w", encoding="utf-8") as output:
            for key, value in records(self.source, 64 * MIB):
                kind = key.lower()
                if kind in OBJ_KEYS:
                    output.write(f"{kind} {value}\n")
                elif kind == "mtllib":
                    material = self.resolve(self.source.parent, value.strip('"'), {".mtl"})
                    if not material:
                        self.issues.add("missing-model-dependency")
                        continue
                    if material not in materials:
                        if len(materials) >= 32:
                            raise InputIssue("model-dependency-limit")
                        name = f"material-{len(materials)}.mtl"
                        self.mtl(material, self.directory / name)
                        materials[material] = name
                    output.write(f"mtllib {materials[material]}\n")
                else:
                    self.issues.add("obj-records-omitted")
        return target

    def mtl(self, source, target):
        with target.open("w", encoding="utf-8") as output:
            for key, value in records(source, 2 * MIB):
                kind = key.lower()
                if kind in MTL_KEYS:
                    output.write(f"{key} {value}\n")
                elif kind in MTL_MAPS:
                    # Preserve plain texture declarations. Advanced flags need a separate parser.
                    texture = self.resolve(source.parent, value.strip('"'), IMAGES)
                    if texture:
                        output.write(f"{key} {self.copy(texture)}\n")
                    else:
                        self.issues.add("missing-model-dependency" if not value.startswith("-") else "mtl-map-options-omitted")
                else:
                    self.issues.add("mtl-records-omitted")

    def gltf(self):
        suffix = self.source.suffix.lower()
        if suffix == ".glb":
            return self.glb()
        if self.source.stat().st_size > 64 * MIB:
            raise InputIssue("model-input-limit")
        document = json.loads(self.source.read_text(encoding="utf-8-sig"))
        self.gltf_resources(document)
        target = self.directory / "model.gltf"
        target.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
        return target

    def gltf_resources(self, document):
        if not isinstance(document, dict) or document.get("asset", {}).get("version") != "2.0":
            raise InputIssue("model-format-unsupported")
        changed = False
        data_uri = re.compile(r"^data:(?:application/(?:octet-stream|gltf-buffer)|image/(?:png|jpeg|webp|ktx2));base64,", re.I)
        for key, suffixes in (("buffers", {".bin"}), ("images", IMAGES)):
            entries = document.get(key, [])
            if not isinstance(entries, list) or len(entries) > 512:
                raise InputIssue("model-dependency-limit")
            for resource in entries:
                if "uri" not in resource:
                    continue
                uri = resource["uri"]
                if not isinstance(uri, str):
                    raise InputIssue("model-format-unsupported")
                if data_uri.match(uri):
                    continue
                path = self.resolve(self.source.parent, unquote(uri), suffixes)
                if not path:
                    raise InputIssue("missing-model-dependency")
                resource["uri"] = self.copy(path)
                changed = True
        return changed

    def glb(self):
        target = self.directory / "model.glb"
        with self.source.open("rb") as source:
            header = source.read(20)
            if len(header) != 20:
                raise InputIssue("model-format-unsupported")
            magic, version, size, json_size, chunk = struct.unpack("<4sIII4s", header)
            if (magic, version, chunk) != (b"glTF", 2, b"JSON") or size != self.source.stat().st_size:
                raise InputIssue("model-format-unsupported")
            if not 0 < json_size <= min(64 * MIB, size - 20) or json_size % 4:
                raise InputIssue("model-input-limit")
            document = json.loads(source.read(json_size))
            if not self.gltf_resources(document):
                return self.source
            content = json.dumps(document, ensure_ascii=False).encode("utf-8")
            content += b" " * (-len(content) % 4)
            with target.open("wb") as output:
                output.write(struct.pack("<4sIII4s", b"glTF", 2, size - json_size + len(content), len(content), b"JSON"))
                output.write(content)
                shutil.copyfileobj(source, output, MIB)
        return target


def records(path, limit):
    if path.stat().st_size > limit:
        raise InputIssue("model-input-limit")
    with path.open("rb") as stream:
        while line := stream.readline(64 * 1024 + 1):
            if len(line) > 64 * 1024 or re.search(rb"[\x00-\x08\x0b-\x1f\x7f]", line.rstrip(b"\r\n")):
                raise InputIssue("model-format-unsupported")
            line = line.decode("utf-8-sig").split("#", 1)[0].strip()
            if line.endswith("\\"):
                raise InputIssue("obj-continuation-unsupported")
            parts = line.split(None, 1)
            if len(parts) == 2:
                yield parts
