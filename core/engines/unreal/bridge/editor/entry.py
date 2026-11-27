import json
from pathlib import Path
import sys
import traceback

import unreal

sys.path.insert(0, str(Path(__file__).resolve().parent))
from exporters import write_asset
from registry import asset_type, blocked_dependencies, dependency_status, read_registry


def export_package(target, output, packages, edges, excluded):
    name = target["packageName"].casefold()
    hard, soft = edges[name]
    result = {"id": target["id"], "products": [], "dependencies": [
        {"package": dep, "kind": kind, "status": dependency_status(dep, packages, excluded)}
        for kind, refs in (("hard", hard), ("soft", soft)) for dep in refs
    ]}
    if name in excluded:
        result["issue"] = "unreal-asset-class-excluded" if packages[name] else "unreal-asset-unreadable"
        return result
    blocked = blocked_dependencies(name, packages, edges, excluded)
    if blocked:
        return {**result, "issue": "unreal-hard-dependencies-unavailable", "blockedDependencies": blocked}

    directory = output / target["id"]
    directory.mkdir()
    for number, row in enumerate(sorted(packages[name], key=lambda item: str(item.asset_name))):
        kind = asset_type(row)
        product = {"number": number, "name": str(row.asset_name), "className": kind}
        try:
            asset = row.get_asset()
            if not asset or not isinstance(asset, getattr(unreal, kind)):
                product["issue"] = "unreal-asset-load-failed"
            else:
                product["objectPath"] = asset.get_path_name()
                product.update(write_asset(asset, kind, directory, number))
        except Exception:
            unreal.log_warning(traceback.format_exc())
            product["issue"] = "unreal-asset-export-failed"
        result["products"].append(product)
    return result


def main():
    root = Path(__file__).resolve().parent.parent
    request = json.loads((root / "bridge-request.json").read_text(encoding="utf-8"))
    if request["version"] != 1:
        raise RuntimeError("Unrecognized Asset Viewer bridge request")
    targets = request["targets"]
    packages, edges, excluded = read_registry(targets)
    response = {
        "version": 1,
        "engineVersion": unreal.SystemLibrary.get_engine_version(),
        "results": [export_package(target, root / "BridgeOutput", packages, edges, excluded) for target in targets],
    }
    (root / "bridge-result.json").write_text(json.dumps(response, ensure_ascii=False), encoding="utf-8")


main()
