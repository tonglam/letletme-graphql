#!/usr/bin/env python3
"""Verify and, when requested, provision the global skills named by a repo manifest."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shutil
import stat
import subprocess
import tarfile
import tempfile
from pathlib import Path
from typing import Any


EXPECTED_REGISTRY = {
    "repository": "tonglam/codex-workspace-config",
    "ref": "7e92336ec04d38f7bb95620e304ce6ec6567c896",
    "path": "registry/workspace-assets.json",
    "sha256": "fa1a2a5448e34376c4dccfe43c6c8a901adb9b62df3995b1f11d3aa4b9b77cb6",
}
EXPECTED_SOURCE_REVISION = "312eaf56264f65bcc74fd7b81d8981a3517eca02"


def _git_env() -> dict[str, str]:
    """Read Git objects without honoring replacement refs from the checkout."""

    environment = os.environ.copy()
    environment["GIT_NO_REPLACE_OBJECTS"] = "1"
    return environment


def git(cwd: Path, *args: str, capture: bool = False) -> str:
    result = subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        env=_git_env(),
    )
    return result.stdout if capture else ""


def load_manifest(path: Path) -> tuple[dict[str, Any], list[str]]:
    if path.is_symlink() or not path.is_file():
        raise SystemExit(f"manifest must be a regular file: {path}")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"invalid global skill manifest: {exc}") from exc
    if not isinstance(manifest, dict) or manifest.get("version") != 1:
        raise SystemExit("global skill manifest must have version 1")
    if manifest.get("registry") != EXPECTED_REGISTRY:
        raise SystemExit("global skill manifest does not pin the trusted immutable registry")
    skills = manifest.get("skills")
    if not isinstance(skills, list) or not skills or not all(
        isinstance(name, str) and name and name.replace("-", "").isalnum() and name == name.casefold()
        for name in skills
    ):
        raise SystemExit("global skill manifest skills must be non-empty lowercase names")
    if len(set(skills)) != len(skills):
        raise SystemExit("global skill manifest contains duplicate skill names")
    return manifest, skills


def _offline_registry_candidates(runtime_root: Path, advertised: list[str]) -> list[Path]:
    """Find a local Git checkout that can prove the immutable registry pin."""

    candidates: list[Path] = []
    for variable in ("CODEX_REGISTRY_SOURCE", "CODEX_WORKSPACE_CONFIG_CHECKOUT"):
        configured = os.environ.get(variable)
        if configured:
            candidates.append(Path(configured).expanduser())
    skills_root = runtime_root.expanduser().resolve() / "skills"
    for name in advertised:
        mount = skills_root / name
        if not mount.is_symlink():
            continue
        try:
            resolved = mount.resolve(strict=True)
        except OSError:
            continue
        for parent in (resolved, *resolved.parents):
            if (parent / ".git").exists():
                candidates.append(parent)
                break
    # The managed runtime registry is itself a symlink into the config
    # checkout. It remains an offline source even when a skill mount is
    # missing or the advertised skill set changed.
    for mount in (runtime_root.expanduser() / "workspace-assets.json", runtime_root.expanduser() / "AGENTS.md"):
        if not mount.is_symlink():
            continue
        try:
            resolved = mount.resolve(strict=True)
        except OSError:
            continue
        for parent in (resolved, *resolved.parents):
            if (parent / ".git").exists():
                candidates.append(parent)
                break
    unique: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if resolved in seen:
            continue
        seen.add(resolved)
        unique.append(resolved)
    return unique


def source_checkout(
    registry_source: Path | None,
    temporary_root: Path,
    *,
    runtime_root: Path,
    advertised: list[str],
    allow_network: bool,
) -> Path:
    if registry_source is not None:
        checkout = registry_source.resolve()
        try:
            inside_worktree = git(checkout, "rev-parse", "--is-inside-work-tree", capture=True).strip()
        except (OSError, subprocess.CalledProcessError) as exc:
            raise SystemExit(f"registry source is not a Git checkout: {checkout}") from exc
        if inside_worktree != "true":
            raise SystemExit(f"registry source is not a Git checkout: {checkout}")
        return checkout
    for checkout in _offline_registry_candidates(runtime_root, advertised):
        try:
            inside_worktree = git(checkout, "rev-parse", "--is-inside-work-tree", capture=True).strip()
            git(checkout, "cat-file", "-e", f"{EXPECTED_REGISTRY['ref']}^{{commit}}")
        except (OSError, subprocess.CalledProcessError):
            continue
        if inside_worktree == "true":
            print(f"using verified offline registry source: {checkout}")
            return checkout
    if not allow_network:
        raise SystemExit(
            "offline registry source unavailable; provide --registry-source, set "
            "CODEX_REGISTRY_SOURCE or CODEX_WORKSPACE_CONFIG_CHECKOUT, mount a verified "
            "runtime checkout, or explicitly opt in with --allow-network"
        )
    checkout = temporary_root / "config"
    repository = EXPECTED_REGISTRY["repository"]
    try:
        subprocess.run(
            [
                "git",
                "clone",
                "--filter=blob:none",
                "--no-checkout",
                "--depth=1",
                "--no-tags",
                f"https://github.com/{repository}.git",
                str(checkout),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        git(checkout, "fetch", "--depth=1", "origin", EXPECTED_REGISTRY["ref"])
    except subprocess.CalledProcessError as exc:
        raise SystemExit(
            "unable to fetch the pinned workspace config; provide --registry-source, "
            "set CODEX_REGISTRY_SOURCE or CODEX_WORKSPACE_CONFIG_CHECKOUT, "
            "or mount a verified runtime checkout"
        ) from exc
    return checkout


def verify_registry(checkout: Path, advertised: list[str], materialized_root: Path) -> Path:
    ref = EXPECTED_REGISTRY["ref"]
    path = EXPECTED_REGISTRY["path"]
    try:
        blob = subprocess.check_output(
            ["git", "-C", str(checkout), "show", f"{ref}:{path}"],
            env=_git_env(),
        )
    except subprocess.CalledProcessError as exc:
        raise SystemExit("pinned registry object is unavailable in the supplied checkout") from exc
    if hashlib.sha256(blob).hexdigest() != EXPECTED_REGISTRY["sha256"]:
        raise SystemExit("pinned registry content digest mismatch")
    try:
        registry = json.loads(blob)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"pinned registry is invalid JSON: {exc}") from exc
    if registry.get("source", {}).get("revision") != EXPECTED_SOURCE_REVISION:
        raise SystemExit("pinned registry source revision is not the trusted canonical configuration")
    allowlist = registry.get("governance", {}).get("global_skill_allowlist", [])
    names = {Path(item).name for item in allowlist if isinstance(item, str)}
    missing = sorted(set(advertised) - names)
    if missing:
        raise SystemExit(f"pinned registry does not advertise: {', '.join(missing)}")
    git(checkout, "cat-file", "-e", f"{ref}^{{commit}}")
    archive_paths = [f"global/skills/{name}" for name in advertised]
    try:
        archive = subprocess.check_output(
            ["git", "-C", str(checkout), "archive", ref, "--", *archive_paths],
            env=_git_env(),
        )
        materialized_root.mkdir(parents=True, exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as bundle:
            for member in bundle.getmembers():
                target = (materialized_root / member.name).resolve()
                if not str(target).startswith(str(materialized_root.resolve()) + "/"):
                    raise SystemExit("pinned global skill archive contains an unsafe path")
                if member.issym() or member.islnk():
                    raise SystemExit("pinned global skill archive contains a symlink")
                bundle.extract(member, path=materialized_root)
    except (OSError, tarfile.TarError, subprocess.CalledProcessError) as exc:
        raise SystemExit("unable to materialize the pinned global skill tree") from exc
    source_root = materialized_root / "global" / "skills"
    for name in advertised:
        skill = source_root / name
        entry = skill / "SKILL.md"
        if not skill.is_dir() or not entry.is_file() or skill.is_symlink() or entry.is_symlink():
            raise SystemExit(f"pinned global skill is missing or symlinked: {name}")
        for item in skill.rglob("*"):
            if item.is_symlink():
                raise SystemExit(f"pinned global skill contains a symlink: {item}")
    return source_root


def tree_digest(root: Path) -> str:
    """Return a deterministic digest for a materialized, regular-file tree."""

    digest = hashlib.sha256()
    for item in sorted(root.rglob("*"), key=lambda path: path.relative_to(root).as_posix()):
        relative_path = item.relative_to(root)
        relative = relative_path.as_posix()
        if item.is_symlink():
            raise SystemExit(f"global skill tree contains a symlink: {item}")
        # Runtime cache directories are ignored, but executable bytecode is
        # never accepted, including inside those caches.  A timestamp-valid
        # .pyc could otherwise be imported without changing the source digest.
        if item.is_file() and item.suffix.casefold() in {".pyc", ".pyo"}:
            raise SystemExit(f"global skill tree contains executable bytecode: {item}")
        if "__pycache__" in relative_path.parts:
            continue
        if item.is_dir():
            digest.update(f"D:{relative}\0".encode("utf-8"))
            digest.update(f"M:{stat.S_IMODE(item.stat().st_mode):04o}\0".encode("ascii"))
            continue
        if not item.is_file():
            raise SystemExit(f"global skill tree contains an unsupported entry: {item}")
        digest.update(f"F:{relative}\0".encode("utf-8"))
        digest.update(f"M:{stat.S_IMODE(item.stat().st_mode):04o}\0".encode("ascii"))
        digest.update(hashlib.sha256(item.read_bytes()).digest())
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=Path(".codex/global-skills.json"))
    parser.add_argument(
        "--runtime-root",
        type=Path,
        help="Codex runtime root (defaults to CODEX_HOME or ~/.codex)",
    )
    parser.add_argument("--registry-source", type=Path, help="authenticated local config checkout")
    parser.add_argument(
        "--allow-network",
        action="store_true",
        help="allow cloning the pinned config when no verified offline source is available",
    )
    parser.add_argument("--apply", action="store_true", help="install only missing skill directories")
    args = parser.parse_args()

    # Check the lexical manifest path before resolving it.  Resolving first
    # would turn a symlink into its target and bypass the immutable-manifest
    # requirement enforced by ``load_manifest``.
    manifest, advertised = load_manifest(args.manifest)
    configured_runtime_root = args.runtime_root
    runtime_root = configured_runtime_root or Path(os.environ.get("CODEX_HOME") or (Path.home() / ".codex"))
    with tempfile.TemporaryDirectory(prefix="codex-global-skills-") as temporary:
        source_root = verify_registry(
            source_checkout(
                args.registry_source,
                Path(temporary),
                runtime_root=runtime_root,
                advertised=advertised,
                allow_network=args.allow_network,
            ),
            advertised,
            Path(temporary) / "materialized",
        )
        destination_root = runtime_root.expanduser().resolve() / "skills"
        missing: list[str] = []
        for name in advertised:
            destination = destination_root / name
            if destination.is_symlink():
                if not destination.resolve().exists():
                    raise SystemExit(f"global skill mount is a broken symlink: {destination}")
                installed = destination.resolve()
                expected = source_root / name
                if not installed.is_dir() or tree_digest(installed) != tree_digest(expected):
                    raise SystemExit(f"global skill mount is stale or modified: {destination}")
                print(f"ok verified mounted {name} -> {installed}")
            elif destination.is_dir():
                if not (destination / "SKILL.md").is_file():
                    raise SystemExit(f"global skill mount is incomplete: {destination}")
                if tree_digest(destination) != tree_digest(source_root / name):
                    raise SystemExit(f"global skill installation is stale or modified: {destination}")
                print(f"ok verified installed {name} -> {destination}")
            elif destination.exists():
                # A regular file or other special node must never be replaced
                # by a provisioned skill directory. Treat this as an explicit
                # collision instead of classifying it as merely missing.
                raise SystemExit(f"global skill mount collides with a non-directory: {destination}")
            else:
                missing.append(name)
        if missing and not args.apply:
            print("missing global skills: " + ", ".join(missing))
            print("rerun with --apply to install only those advertised directories")
            return 1
        if args.apply and missing:
            destination_root.mkdir(parents=True, exist_ok=True)
            for name in missing:
                destination = destination_root / name
                staging = destination_root / f".provision-{name}"
                if staging.exists() or staging.is_symlink():
                    shutil.rmtree(staging) if staging.is_dir() and not staging.is_symlink() else staging.unlink()
                shutil.copytree(source_root / name, staging)
                staging.replace(destination)
                print(f"provisioned {name} -> {destination}")
    print(f"verified {len(advertised)} global skill route(s) from {manifest['registry']['repository']}@{manifest['registry']['ref']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
