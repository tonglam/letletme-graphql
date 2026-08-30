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


def git(cwd: Path, *args: str, capture: bool = False) -> str:
    result = subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
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


def source_checkout(registry_source: Path | None, temporary_root: Path) -> Path:
    if registry_source is not None:
        checkout = registry_source.resolve()
        try:
            inside_worktree = git(checkout, "rev-parse", "--is-inside-work-tree", capture=True).strip()
        except (OSError, subprocess.CalledProcessError) as exc:
            raise SystemExit(f"registry source is not a Git checkout: {checkout}") from exc
        if inside_worktree != "true":
            raise SystemExit(f"registry source is not a Git checkout: {checkout}")
        return checkout
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
            "unable to fetch the pinned workspace config; provide --registry-source "
            "with an authenticated checkout"
        ) from exc
    return checkout


def verify_registry(checkout: Path, advertised: list[str], materialized_root: Path) -> Path:
    ref = EXPECTED_REGISTRY["ref"]
    path = EXPECTED_REGISTRY["path"]
    try:
        blob = subprocess.check_output(["git", "-C", str(checkout), "show", f"{ref}:{path}"])
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
            ["git", "-C", str(checkout), "archive", ref, "--", *archive_paths]
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
    parser.add_argument("--apply", action="store_true", help="install only missing skill directories")
    args = parser.parse_args()

    # Check the lexical manifest path before resolving it.  Resolving first
    # would turn a symlink into its target and bypass the immutable-manifest
    # requirement enforced by ``load_manifest``.
    manifest, advertised = load_manifest(args.manifest)
    with tempfile.TemporaryDirectory(prefix="codex-global-skills-") as temporary:
        source_root = verify_registry(
            source_checkout(args.registry_source, Path(temporary)),
            advertised,
            Path(temporary) / "materialized",
        )
        configured_runtime_root = args.runtime_root
        runtime_root = configured_runtime_root or Path(os.environ.get("CODEX_HOME") or (Path.home() / ".codex"))
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
