#!/usr/bin/env python3
"""Dependency-free integrity checks for repository instructions and skills.

The validator intentionally implements the small YAML/Markdown subset used by
Codex instruction files. It fails closed instead of silently treating a
malformed manifest as a string.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable


SUPPORTED_VERSION = 1
FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*(?:\n|\Z)", re.S)
KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*$")
INLINE_LINK_RE = re.compile(
    r"\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:\"[^\"]*\"|'[^']*'|\([^)]*\)))?\s*\)"
)
REFERENCE_DEF_RE = re.compile(r"^\s{0,3}\[([^\]]+)\]:\s*(<[^>]*>|[^\s]+)", re.M)
PEM_RE = re.compile(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----")
SECRET_VALUE_RES = (
    re.compile(r"(?i)\b(?:api[_ -]?key|access[_ -]?token|private[_ -]?key|client[_ -]?secret|password)\b\s*[:=]\s*([^\s`<>]+)"),
    re.compile(r"(?i)\bauthorization\s*:\s*bearer\s+([A-Za-z0-9._~+/=-]{8,})"),
    re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,})\b"),
)
PLACEHOLDER_VALUES = {
    "example",
    "example-token",
    "placeholder",
    "redacted",
    "token",
    "value",
    "your-token",
    "<token>",
    "<value>",
}
CONTRACT_KEYS = {
    "version",
    "asset_id",
    "canonical_config_commit",
    "validator_version",
    "policy_version",
    "required_agents",
    "required_skills",
    "required_global_skills",
    "policy_profile",
}
REVIEW_RULE_KEYS = {
    "codex_quota",
    "tests_and_scripts",
    "all_other_paths",
    "all_findings",
    "post_merge_cleanup",
}
IGNORED_PARTS = {".git", "node_modules", ".next", "dist", "build", "coverage", "archive", "output"}


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle, object_pairs_hook=_reject_duplicate_keys)
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def _strip_yaml_comment(value: str) -> str:
    quote: str | None = None
    escaped = False
    for index, char in enumerate(value):
        if quote == '"' and escaped:
            escaped = False
            continue
        if quote == '"' and char == "\\":
            escaped = True
            continue
        if char in {'"', "'"}:
            if quote is None:
                quote = char
            elif quote == char:
                quote = None
        elif char == "#" and quote is None and (index == 0 or value[index - 1].isspace()):
            return value[:index].rstrip()
    return value.rstrip()


def _parse_scalar(value: str, path: Path, line_number: int, *, scalar_only: bool = False) -> str:
    value = _strip_yaml_comment(value.strip())
    if not value:
        raise ValueError(f"{path}:{line_number}: empty YAML value")
    if value[0] in {'"', "'"}:
        quote = value[0]
        if len(value) < 2 or value[-1] != quote:
            raise ValueError(f"{path}:{line_number}: unterminated YAML quote")
        if quote == '"':
            try:
                decoded = json.loads(value)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_number}: invalid double-quoted YAML scalar") from exc
            if not isinstance(decoded, str):
                raise ValueError(f"{path}:{line_number}: YAML scalar is not a string")
            return decoded
        return value[1:-1].replace("''", "'")
    if value[0] not in "[{":
        # Apostrophes and brackets are ordinary characters in a YAML plain
        # scalar (for example, "user's route" or "[locale]").
        return value
    if scalar_only:
        raise ValueError(f"{path}:{line_number}: expected a scalar YAML value")
    stack: list[str] = []
    quote: str | None = None
    escaped = False
    for char in value:
        if quote == '"' and escaped:
            escaped = False
            continue
        if quote == '"' and char == "\\":
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = None
            continue
        if char in {'"', "'"}:
            quote = char
        elif char in "[{(":
            stack.append(char)
        elif char in "]})":
            expected = {']': '[', '}': '{', ')': '('}[char]
            if not stack or stack.pop() != expected:
                raise ValueError(f"{path}:{line_number}: unbalanced YAML delimiters")
    if quote or stack or escaped:
        raise ValueError(f"{path}:{line_number}: unterminated YAML quote or delimiter")
    return value


def parse_yaml_mapping(text: str, path: Path, *, scalar_fields: bool = False) -> dict[str, Any]:
    """Parse the mapping/nested-mapping subset used by instruction metadata."""

    root: dict[str, Any] = {}
    stack: list[tuple[int, dict[str, Any]]] = [(-1, root)]
    for line_number, raw in enumerate(text.splitlines(), start=1):
        if "\t" in raw:
            raise ValueError(f"{path}:{line_number}: YAML contains tabs")
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        if indent % 2:
            raise ValueError(f"{path}:{line_number}: YAML indentation must use two-space levels")
        content = _strip_yaml_comment(raw[indent:])
        if not content:
            continue
        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()
        if stack[-1][0] == -1 and indent != 0:
            raise ValueError(f"{path}:{line_number}: root YAML entries must start at column zero")
        if stack[-1][0] >= 0 and indent > stack[-1][0] and indent != stack[-1][0] + 2:
            raise ValueError(f"{path}:{line_number}: invalid YAML indentation")
        if ":" not in content:
            raise ValueError(f"{path}:{line_number}: expected a YAML mapping entry")
        key, value = content.split(":", 1)
        key = key.strip()
        if not KEY_RE.fullmatch(key):
            raise ValueError(f"{path}:{line_number}: invalid YAML key {key!r}")
        mapping = stack[-1][1]
        if key in mapping:
            raise ValueError(f"{path}:{line_number}: duplicate YAML key {key}")
        value = value.strip()
        if not value:
            child: dict[str, Any] = {}
            mapping[key] = child
            stack.append((indent, child))
        else:
            mapping[key] = _parse_scalar(value, path, line_number, scalar_only=scalar_fields)
    return root


def read_frontmatter(path: Path) -> tuple[dict[str, str], str | None]:
    text = path.read_text(encoding="utf-8")
    match = FRONTMATTER_RE.match(text)
    if not match:
        return {}, "missing YAML frontmatter delimited by ---"
    try:
        parsed = parse_yaml_mapping(match.group(1), path, scalar_fields=True)
    except ValueError as exc:
        return {}, str(exc)
    fields: dict[str, str] = {}
    for key, value in parsed.items():
        if not isinstance(value, str):
            return {}, f"{path}: frontmatter field {key} must be scalar"
        fields[key] = value
    return fields, None


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def resolve_path(
    repo: Path,
    value: str,
    *,
    allow_absolute_inside_repo: bool = False,
    allow_external: bool = False,
) -> Path:
    candidate = Path(value)
    if candidate.is_absolute():
        if not allow_absolute_inside_repo:
            raise ValueError(f"required instruction path must be repository-relative: {value}")
        resolved = candidate.resolve()
    else:
        if ".." in candidate.parts:
            raise ValueError(f"required instruction path may not escape the repository: {value}")
        resolved = (repo / candidate).resolve()
    root = repo.resolve()
    if not allow_external and not _is_within(resolved, root):
        raise ValueError(f"required instruction path escapes the repository: {value}")
    return resolved


def _markdown_targets(text: str) -> Iterable[str]:
    for raw in INLINE_LINK_RE.findall(text):
        yield raw[1:-1] if raw.startswith("<") and raw.endswith(">") else raw
    for match in REFERENCE_DEF_RE.finditer(text):
        raw = match.group(2)
        yield raw[1:-1] if raw.startswith("<") and raw.endswith(">") else raw


def check_reference_links(
    instruction_file: Path,
    repo: Path,
    errors: list[str],
    *,
    allow_external: bool = False,
) -> None:
    text = instruction_file.read_text(encoding="utf-8")
    for raw_target in _markdown_targets(text):
        target = raw_target.strip().split("#", 1)[0].strip()
        if not target or target.startswith(("http://", "https://", "mailto:", "data:", "#")):
            continue
        candidate = (instruction_file.parent / target).resolve()
        if not allow_external and not _is_within(candidate, repo.resolve()):
            errors.append(f"{instruction_file}: relative reference escapes repository: {target}")
        elif not candidate.exists():
            errors.append(f"{instruction_file}: missing relative reference {target}")


def _looks_like_placeholder(value: str) -> bool:
    normalized = value.strip().strip("'\"").casefold()
    return (
        normalized in PLACEHOLDER_VALUES
        or normalized.startswith("${")
        or (normalized.startswith("<") and normalized.endswith(">"))
        or normalized in {"your-api-key", "your-access-token", "replace-me"}
    )


def has_secret(text: str) -> bool:
    if PEM_RE.search(text):
        return True
    for pattern in SECRET_VALUE_RES:
        for match in pattern.finditer(text):
            value = match.group(1) if match.lastindex else match.group(0)
            if not _looks_like_placeholder(value):
                return True
    return False


def check_yaml_shape(path: Path, errors: list[str], *, skill_name: str | None = None) -> None:
    text = path.read_text(encoding="utf-8")
    if not text.strip():
        errors.append(f"{path}: empty agents/openai.yaml")
        return
    try:
        document = parse_yaml_mapping(text, path)
    except ValueError as exc:
        errors.append(str(exc))
        return
    interface = document.get("interface")
    if not isinstance(interface, dict):
        errors.append(f"{path}: metadata must contain an interface mapping")
        return
    for field in ("display_name", "short_description", "default_prompt"):
        if not isinstance(interface.get(field), str) or not interface[field].strip():
            errors.append(f"{path}: interface.{field} must be a nonempty string")
    if skill_name and isinstance(interface.get("default_prompt"), str) and f"${skill_name}" not in interface["default_prompt"]:
        errors.append(f"{path}: interface.default_prompt must invoke ${skill_name}")


def _instruction_paths(repo: Path, *, include_discovery: bool) -> list[Path]:
    if not include_discovery:
        return []
    paths: set[Path] = set()
    for pattern in ("AGENTS.md", ".agents/**/AGENTS.md", ".agents/**/SKILL.md", "skills/**/SKILL.md"):
        for path in repo.glob(pattern):
            if path.is_file() and not any(part in IGNORED_PARTS for part in path.relative_to(repo).parts):
                paths.add(path.resolve())
    return sorted(paths)


def _validate_instruction_file(
    path: Path,
    repo: Path,
    policy: dict[str, Any],
    errors: list[str],
    *,
    allow_external: bool = False,
) -> None:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"{path}: cannot read instruction file: {exc}")
        return
    if not text.strip():
        errors.append(f"{path}: instruction file is empty")
    if path.name == "AGENTS.md" and path.stat().st_size > int(policy.get("max_agents_bytes", 32768)):
        errors.append(f"{path}: exceeds max_agents_bytes")
    if path.name == "SKILL.md":
        if path.stat().st_size > int(policy.get("max_skill_bytes", 32768)):
            errors.append(f"{path}: exceeds max_skill_bytes")
        fields, issue = read_frontmatter(path)
        if issue:
            errors.append(f"{path}: {issue}")
        else:
            for required in policy.get("required_frontmatter", ["name", "description"]):
                if not fields.get(required):
                    errors.append(f"{path}: missing frontmatter field {required}")
            if fields.get("name") and fields["name"] != path.parent.name:
                errors.append(f"{path}: frontmatter name must match directory {path.parent.name}")
        yaml_path = path.parent / "agents" / "openai.yaml"
        if yaml_path.exists():
            check_yaml_shape(yaml_path, errors, skill_name=path.parent.name)
            if policy.get("forbid_secrets_in_instructions") and has_secret(yaml_path.read_text(encoding="utf-8")):
                errors.append(f"{yaml_path}: possible secret/token pattern")
        else:
            errors.append(f"{path.parent}: missing agents/openai.yaml")
    check_reference_links(path, repo, errors, allow_external=allow_external)
    if policy.get("forbid_secrets_in_instructions") and has_secret(text):
        errors.append(f"{path}: possible secret/token pattern")


def _validate_contract_shape(contract: dict[str, Any], errors: list[str]) -> None:
    unknown = sorted(set(contract) - CONTRACT_KEYS)
    if unknown:
        errors.append(f"contract contains unknown keys: {', '.join(unknown)}")
    if contract.get("version") != SUPPORTED_VERSION:
        errors.append(f"unsupported contract version: {contract.get('version')!r}")
    if str(contract.get("validator_version")) != str(SUPPORTED_VERSION):
        errors.append(f"unsupported validator_version: {contract.get('validator_version')!r}")
    if str(contract.get("policy_version")) != str(SUPPORTED_VERSION):
        errors.append(f"unsupported policy_version: {contract.get('policy_version')!r}")
    commit = contract.get("canonical_config_commit")
    if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-fA-F]{7,40}", commit):
        errors.append("canonical_config_commit must be a 7-40 character hexadecimal revision")
    for key in ("required_agents", "required_skills"):
        value = contract.get(key)
        if not isinstance(value, list) or not value or not all(isinstance(item, str) and item.strip() for item in value):
            errors.append(f"{key} must be a non-empty list of strings")
    globals_value = contract.get("required_global_skills", [])
    if not isinstance(globals_value, list) or not globals_value or not all(
        isinstance(item, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]*", item) for item in globals_value
    ):
        errors.append("required_global_skills must be a non-empty list of skill names")


def _validate_policy(policy: dict[str, Any], errors: list[str]) -> None:
    if policy.get("version") != SUPPORTED_VERSION:
        errors.append(f"unsupported policy version: {policy.get('version')!r}")
    rules = policy.get("review_rules")
    if not isinstance(rules, dict) or set(rules) != REVIEW_RULE_KEYS or not all(isinstance(value, str) and value.strip() for value in rules.values()):
        errors.append("policy review_rules must contain every operative review rule")
    elif (
        "tests" not in rules["tests_and_scripts"]
        or "scripts" not in rules["tests_and_scripts"]
        or "P2" not in rules["all_other_paths"]
        or "P3" not in rules["all_other_paths"]
    ):
        errors.append("policy review_rules must preserve the narrow tests/scripts exception and all-other-path P2/P3 rule")


def _validate_against_trusted_contract(
    contract: dict[str, Any], trusted: dict[str, Any], errors: list[str]
) -> None:
    """Prevent a PR from weakening the protected asset list or config pin."""

    if contract.get("asset_id") != trusted.get("asset_id"):
        errors.append("contract asset_id does not match the trusted base contract")
    if contract.get("canonical_config_commit") != trusted.get("canonical_config_commit"):
        errors.append("contract canonical_config_commit differs from the trusted base contract")
    if contract.get("policy_profile") != trusted.get("policy_profile"):
        errors.append("contract policy_profile differs from the trusted base contract")
    for key in ("required_agents", "required_skills", "required_global_skills"):
        proposed = set(contract.get(key, []))
        baseline = set(trusted.get(key, []))
        missing = sorted(baseline - proposed)
        if missing:
            errors.append(f"contract {key} removes trusted entries: {', '.join(missing)}")


def validate_skill(
    path: Path,
    repo: Path,
    policy: dict[str, Any],
    errors: list[str],
    *,
    allow_external: bool = False,
) -> None:
    entry = path / policy.get("require_skill_entrypoint", "SKILL.md") if path.is_dir() else path
    if not entry.exists():
        errors.append(f"{path}: missing {policy.get('require_skill_entrypoint', 'SKILL.md')}")
        return
    _validate_instruction_file(entry, repo, policy, errors, allow_external=allow_external)


def validate_asset(
    asset: dict[str, Any],
    policy: dict[str, Any],
    *,
    registry_only: bool = False,
    expected_config_commit: str | None = None,
    trusted_contract: dict[str, Any] | None = None,
) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    repo = Path(str(asset["root"]))
    contract = asset.get("instruction_contract") or {}
    if contract:
        _validate_contract_shape(contract, errors)
        if trusted_contract:
            _validate_against_trusted_contract(contract, trusted_contract, errors)
        if expected_config_commit and contract.get("canonical_config_commit") != expected_config_commit:
            errors.append(
                f"canonical_config_commit {contract.get('canonical_config_commit')!r} does not match trusted {expected_config_commit!r}"
            )
    agents = contract.get("required_agents") if contract else asset.get("agents", [])
    skills = contract.get("required_skills") if contract else asset.get("skills", [])
    if not isinstance(agents, list) or not isinstance(skills, list):
        errors.append("required instruction lists must be arrays")
        agents, skills = [], []
    if not registry_only and not repo.exists():
        errors.append(f"{repo}: root does not exist")
    if not registry_only and repo.exists():
        allow_absolute = asset.get("kind") == "instruction-system"
        required_paths: set[Path] = set()
        for relative in agents:
            try:
                path = resolve_path(
                    repo,
                    str(relative),
                    allow_absolute_inside_repo=allow_absolute,
                    allow_external=allow_absolute,
                )
            except ValueError as exc:
                errors.append(str(exc))
                continue
            required_paths.add(path)
            if not path.exists() or not path.is_file():
                errors.append(f"{path}: missing required AGENTS file")
        for skill in skills:
            try:
                path = resolve_path(
                    repo,
                    str(skill),
                    allow_absolute_inside_repo=allow_absolute,
                    allow_external=allow_absolute,
                )
            except ValueError as exc:
                errors.append(str(exc))
                continue
            required_paths.add((path / policy.get("require_skill_entrypoint", "SKILL.md")) if path.is_dir() else path)
            validate_skill(path, repo, policy, errors, allow_external=allow_absolute)

        discovered = _instruction_paths(repo, include_discovery=asset.get("kind") != "instruction-system")
        discovered_set = set(discovered)
        for path in discovered:
            _validate_instruction_file(path, repo, policy, errors)
        for path in sorted(discovered_set - required_paths):
            errors.append(f"{path}: instruction entrypoint is not listed in the contract")

        manifest_path = repo / ".codex" / "global-skills.json"
        globals_value = contract.get("required_global_skills", []) if contract else []
        if globals_value:
            if not manifest_path.exists():
                errors.append(f"{manifest_path}: missing required global skill manifest")
            else:
                try:
                    manifest = load_json(manifest_path)
                    advertised = manifest.get("skills")
                    if not isinstance(advertised, list) or set(advertised) != set(globals_value):
                        errors.append(f"{manifest_path}: advertised skills do not match required_global_skills")
                except (OSError, ValueError, json.JSONDecodeError) as exc:
                    errors.append(str(exc))
            if manifest_path.exists():
                check_reference_links(manifest_path, repo, errors)
                if policy.get("forbid_secrets_in_instructions") and has_secret(manifest_path.read_text(encoding="utf-8")):
                    errors.append(f"{manifest_path}: possible secret/token pattern")
    return {
        "asset_id": asset.get("id"),
        "root": str(repo),
        "ok": not errors,
        "errors": list(dict.fromkeys(errors)),
        "warnings": warnings,
    }


def asset_from_contract(repo: Path, contract: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": contract.get("asset_id", repo.name),
        "root": str(repo),
        "kind": "code-repository",
        "instruction_contract": contract,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--registry", type=Path)
    parser.add_argument("--asset-id")
    parser.add_argument("--contract", type=Path)
    parser.add_argument("--policy", type=Path, required=True)
    parser.add_argument("--expected-config-commit")
    parser.add_argument("--trusted-contract", type=Path)
    parser.add_argument("--registry-only", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()

    try:
        policy = load_json(args.policy)
        policy_errors: list[str] = []
        _validate_policy(policy, policy_errors)
        if policy_errors:
            raise ValueError("; ".join(policy_errors))
        if args.contract:
            contract = load_json(args.contract)
            contract_errors: list[str] = []
            _validate_contract_shape(contract, contract_errors)
            if contract_errors:
                raise ValueError("; ".join(contract_errors))
            asset = asset_from_contract(args.repo.resolve(), contract)
        elif args.registry:
            registry = load_json(args.registry)
            matches = [a for a in registry.get("assets", []) if a.get("id") == args.asset_id]
            if len(matches) != 1:
                raise ValueError(f"asset id not found or not unique: {args.asset_id}")
            asset = matches[0]
        else:
            raise ValueError("one of --contract or --registry is required")
        trusted_contract = load_json(args.trusted_contract) if args.trusted_contract else None
        result = validate_asset(
            asset,
            policy,
            registry_only=args.registry_only,
            expected_config_commit=args.expected_config_commit,
            trusted_contract=trusted_contract,
        )
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
