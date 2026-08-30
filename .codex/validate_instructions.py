#!/usr/bin/env python3
"""Small dependency-free validator for AGENTS.md and Codex skills."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*(?:\n|\Z)", re.S)
LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
SECRET_RE = re.compile(r"(?i)(api[_-]?key|access[_-]?token|private[_-]?key|cookie\s*=|authorization:\s*bearer)")


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def read_frontmatter(path: Path) -> tuple[dict[str, str], str | None]:
    text = path.read_text(encoding="utf-8")
    match = FRONTMATTER_RE.match(text)
    if not match:
        return {}, "missing YAML frontmatter delimited by ---"
    fields: dict[str, str] = {}
    for raw in match.group(1).splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition(":")
        if not sep or not key.strip():
            return {}, f"invalid frontmatter line: {raw!r}"
        fields[key.strip()] = value.strip().strip("'\"")
    return fields, None


def resolve_path(repo: Path, value: str) -> Path:
    candidate = Path(value)
    return candidate if candidate.is_absolute() else repo / candidate


def check_reference_links(skill_file: Path, errors: list[str]) -> None:
    text = skill_file.read_text(encoding="utf-8")
    for target in LINK_RE.findall(text):
        target = target.strip().split("#", 1)[0].strip()
        if not target or target.startswith(("http://", "https://", "mailto:", "/")):
            continue
        if not (skill_file.parent / target).exists():
            errors.append(f"{skill_file}: missing relative reference {target}")


def check_yaml_shape(path: Path, errors: list[str]) -> None:
    text = path.read_text(encoding="utf-8")
    if not text.strip():
        errors.append(f"{path}: empty agents/openai.yaml")
        return
    if "\t" in text:
        errors.append(f"{path}: YAML contains tabs")
    if not any(":" in line for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")):
        errors.append(f"{path}: YAML has no mapping entries")


def validate_skill(path: Path, policy: dict[str, Any], errors: list[str], warnings: list[str]) -> None:
    entry = path / policy.get("require_skill_entrypoint", "SKILL.md") if path.is_dir() else path
    if not entry.exists():
        errors.append(f"{path}: missing {policy.get('require_skill_entrypoint', 'SKILL.md')}")
        return
    if entry.stat().st_size > int(policy.get("max_skill_bytes", 32768)):
        errors.append(f"{entry}: exceeds max_skill_bytes")
    fields, issue = read_frontmatter(entry)
    if issue:
        errors.append(f"{entry}: {issue}")
    else:
        for required in policy.get("required_frontmatter", ["name", "description"]):
            if not fields.get(required):
                errors.append(f"{entry}: missing frontmatter field {required}")
    check_reference_links(entry, errors)
    yaml_path = entry.parent / "agents" / "openai.yaml"
    if yaml_path.exists():
        check_yaml_shape(yaml_path, errors)
    else:
        warnings.append(f"{entry.parent}: agents/openai.yaml not present")
    if policy.get("forbid_secrets_in_instructions") and SECRET_RE.search(entry.read_text(encoding="utf-8")):
        errors.append(f"{entry}: possible secret/token pattern")


def validate_asset(asset: dict[str, Any], policy: dict[str, Any], *, registry_only: bool = False) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    repo = Path(str(asset["root"]))
    contract = asset.get("instruction_contract") or {}
    agents = contract.get("required_agents", asset.get("agents", []))
    skills = contract.get("required_skills", asset.get("skills", []))
    if not registry_only and not repo.exists():
        errors.append(f"{repo}: root does not exist")
    if not registry_only:
        for relative in agents:
            path = resolve_path(repo, str(relative))
            if not path.exists():
                errors.append(f"{path}: missing required AGENTS file")
            elif path.stat().st_size > int(policy.get("max_agents_bytes", 32768)):
                errors.append(f"{path}: exceeds max_agents_bytes")
            elif policy.get("forbid_secrets_in_instructions") and SECRET_RE.search(path.read_text(encoding="utf-8")):
                errors.append(f"{path}: possible secret/token pattern")
        for skill in skills:
            validate_skill(resolve_path(repo, str(skill)), policy, errors, warnings)
    return {
        "asset_id": asset.get("id"),
        "root": str(repo),
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
    }


def asset_from_contract(repo: Path, contract: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": contract.get("asset_id", repo.name),
        "root": str(repo),
        "agents": contract.get("required_agents", ["AGENTS.md"]),
        "skills": contract.get("required_skills", []),
        "instruction_contract": contract,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--registry", type=Path)
    parser.add_argument("--asset-id")
    parser.add_argument("--contract", type=Path)
    parser.add_argument("--policy", type=Path, required=True)
    parser.add_argument("--registry-only", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()

    try:
        policy = load_json(args.policy)
        if args.contract:
            asset = asset_from_contract(args.repo.resolve(), load_json(args.contract))
        elif args.registry:
            registry = load_json(args.registry)
            matches = [a for a in registry.get("assets", []) if a.get("id") == args.asset_id]
            if len(matches) != 1:
                raise ValueError(f"asset id not found or not unique: {args.asset_id}")
            asset = matches[0]
        else:
            raise ValueError("one of --contract or --registry is required")
        result = validate_asset(asset, policy, registry_only=args.registry_only)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        result = {"ok": False, "errors": [str(exc)], "warnings": []}

    if args.json or args.pretty:
        print(json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None, sort_keys=True))
    else:
        state = "PASS" if result.get("ok") else "FAIL"
        print(f"{state} {result.get('asset_id', 'unknown')}")
        for issue in result.get("errors", []):
            print(f"ERROR {issue}")
        for warning in result.get("warnings", []):
            print(f"WARN {warning}")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
