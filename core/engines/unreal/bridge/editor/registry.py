import unreal


# Only native, declarative asset classes are eligible for loading or export.
ASSET_TYPES = {
    "StaticMesh", "SkeletalMesh", "AnimSequence", "Skeleton",
    "Texture2D", "Material", "MaterialInstanceConstant", "SoundWave",
}
ENGINE_MODULES = {
    "/script/coreuobject", "/script/engine", "/script/physicscore", "/script/unrealed",
}


def asset_type(asset):
    path = asset.asset_class_path
    name = str(path.asset_name)
    if str(path.package_name) == "/Script/Engine" and name in ASSET_TYPES and not asset.is_redirector():
        return name
    return None


def read_registry(targets):
    registry = unreal.AssetRegistryHelpers.get_asset_registry()
    registry.scan_paths_synchronous(["/Game"], force_rescan=True)
    requested = {row["packageName"].casefold() for row in targets}
    packages = {name: [] for name in requested}
    for asset in registry.get_assets_by_path("/Game", recursive=True, include_only_on_disk_assets=True) or []:
        name = str(asset.package_name).casefold()
        if name in packages:
            packages[name].append(asset)

    hard_options = unreal.AssetRegistryDependencyOptions(
        include_hard_package_references=True, include_soft_package_references=False,
        include_searchable_names=False, include_soft_management_references=False,
        include_hard_management_references=False,
    )
    soft_options = unreal.AssetRegistryDependencyOptions(
        include_hard_package_references=False, include_soft_package_references=True,
        include_searchable_names=False, include_soft_management_references=False,
        include_hard_management_references=False,
    )
    edges = {}
    excluded = set()
    for row in targets:
        name = row["packageName"]
        key = name.casefold()
        assets = packages[key]
        if not assets or len(assets) > 64 or any(not asset_type(asset) for asset in assets):
            excluded.add(key)
        hard = sorted(str(dep) for dep in registry.get_dependencies(name, hard_options) or [])
        soft = sorted(str(dep) for dep in registry.get_dependencies(name, soft_options) or [])
        if len(hard) > 256:
            excluded.add(key)
        edges[key] = (hard[:256], soft[:256])
    return packages, edges, excluded


def dependency_status(name, packages, excluded):
    key = name.casefold()
    if key.startswith("/engine/") or key in ENGINE_MODULES:
        return "builtin"
    if key in excluded:
        return "excluded"
    return "staged" if key in packages else "missing"


def blocked_dependencies(package, packages, edges, excluded):
    visited = {package}
    stack = list(edges[package][0])
    blocked = set()
    while stack:
        name = stack.pop()
        key = name.casefold()
        if key in visited:
            continue
        visited.add(key)
        status = dependency_status(name, packages, excluded)
        if status == "staged":
            stack.extend(edges[key][0])
        elif status != "builtin":
            blocked.add(name)
        if len(blocked) >= 256:
            break
    return sorted(blocked)
