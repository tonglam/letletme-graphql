#!/usr/bin/env python3
"""Dependency-free integrity checks for repository instructions and skills.

The validator intentionally implements the small YAML/Markdown subset used by
Codex instruction files. It fails closed instead of silently treating a
malformed manifest as a string.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
import re
import sys
from urllib.parse import unquote
from pathlib import Path
from typing import Any, Iterable


SUPPORTED_VERSION = 1
FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*(?:\n|\Z)", re.S)
KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*$")
INLINE_LINK_RE = re.compile(
    r"\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:\"[^\"]*\"|'[^']*'|\([^)]*\)))?\s*\)"
)
# Reference definitions may be nested in block quotes or list containers. The
# container prefix is still Markdown structure; the destination remains an
# operative repository reference.
REFERENCE_DEF_RE = re.compile(
    r"^(?: {0,3}>[ \t]?| {0,3}(?:[-+*]|\d+[.)])[ \t]+)* {0,3}(?<!\\)\[((?:\\.|[^\]\\])*)\]:\s*(<[^>]*>|[^\s]+)",
    re.M,
)
REFERENCE_TEXT_SUFFIXES = {".md", ".yaml", ".yml", ".json", ".txt", ".text", ".rst"}
URI_SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:", re.IGNORECASE)
PEM_RE = re.compile(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----")
BASIC_AUTH_RE = re.compile(r"(?i)\bauthorization\s*:\s*basic\s+([A-Za-z0-9+/]{8,}={0,2})")
CLI_CREDENTIAL_RE = re.compile(
    r"(?ix)(?<![A-Za-z0-9_-])(?:"
    r"(?:--(?:password|pass|token|api[-_]?key|access[-_]?token)(?:=|\s+))"
    r"|(?:redis-cli)(?:[^\n;&|`]*?)\s+-a(?:=|\s+|(?=[^\s`<>#]))"
    r"|(?:mysql(?:dump|admin|sh)?)(?:[^\n;&|`]*?)\s+-p(?:=|\s+|(?=[^\s`<>#]))"
    r")(?!-)([^\s`<>#]+)"
)
AWS_CREDENTIAL_ARGUMENT_RE = re.compile(
    r"(?ix)\baws\s+configure\s+set\s+(?:aws[_-])?(?:secret[_-]?access[_-]?key|access[_-]?key(?:[_-]?id)?|session[_-]?token)"
    r"\s+([^\s`<>#]+)"
)
IP_LITERAL_RE = re.compile(
    r"(?<![A-Za-z0-9_])(?:\[[0-9A-Fa-f:.]+\]|[0-9]{1,3}(?:\.[0-9]{1,3}){3}|"
    r"[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{0,4}){2,7})(?![A-Za-z0-9_])"
)
SECRET_VALUE_RES = (
    re.compile(r'''(?ix)(?<![A-Za-z0-9_])["']?(?:[A-Za-z0-9]+[_-])*(?:api[_ -]?(?:key|token)|access[_ -]?(?:token|key)|private[_ -]?key|client[_ -]?secret|service[_ -]?(?:role[_ -]?)?key|secret[_ -]?(?:access[_ -]?)?key|app[_ -]?secret|service[_ -]?token|signing[_ -]?(?:key|secret)|password)["']?\s*[:=]\s*((?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^\n`<>#]+))'''),
    # YAML block scalars put the sensitive value on indented following lines,
    # so there is no literal value beside the key for the normal rule above to
    # capture. Treat non-placeholder folded/literal blocks as credentials.
    re.compile(r'''(?im)(?<![A-Za-z0-9_])(?:[A-Za-z0-9]+[_-])*(?:api[_ -]?(?:key|token)|access[_ -]?(?:token|key)|private[_ -]?key|client[_ -]?secret|service[_ -]?(?:role[_ -]?)?key|secret[_ -]?(?:access[_ -]?)?key|app[_ -]?secret|service[_ -]?token|signing[_ -]?(?:key|secret)|token|secret|credential|password)\s*[:=]\s*[|>][-+0-9]*\s*\n((?:[ \t]+[^\n]*(?:\n|$))+)'''),
    # Server-only names often use a plain ``*_SECRET``/``*_CREDENTIAL``
    # suffix (for example BACKEND_PROXY_SECRET) rather than one of the
    # provider-specific names above. Keep the value capture identical so
    # documented environment lookups and placeholders remain exempt.
    re.compile(r'''(?ix)(?<![A-Za-z0-9_])["']?(?:[A-Za-z0-9]+[_-])+(?:secret|credential)(?:[_-](?:key|token|value))?["']?\s*[:=]\s*((?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^\n`<>#]+))'''),
    re.compile(r'''(?ix)(?<![A-Za-z0-9_])["']?(?:[A-Za-z0-9]+[_-])*(?:notification[_ -]?api[_ -]?token|notification[_ -]?token|notifier[_ -]?token|metrics[_ -]?token|telegram[_ -]?bot[_ -]?token|session[_ -]?(?:cookie|token)|cookie)["']?\s*[:=]\s*((?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^\n`<>#]+))'''),
    re.compile(r"(?i)\bauthorization\s*:\s*bearer\s+([A-Za-z0-9._~+/=-]{8,})"),
    BASIC_AUTH_RE,
    CLI_CREDENTIAL_RE,
    AWS_CREDENTIAL_ARGUMENT_RE,
    re.compile(r"(?i)\b(?:postgres(?:ql)?|mysql|redis(?:s)?|mongodb(?:\+srv)?):\/\/[^\s/@:]*:([^\s/@]+)@"),
    # HTTP(S) and Git userinfo can carry a password/token even when the host
    # is public. Keep the username optional so ``https://:secret@host`` is
    # covered as well, while placeholders remain exempt via
    # ``_looks_like_placeholder``.
    re.compile(r"(?i)\b(?:https?|git):\/\/[^\s/@:]*:([^\s/@]+)@"),
    # Bare generic names are useful for catching literal credentials, but do
    # not treat ordinary code expressions such as ``token = value.casefold()``
    # as secrets. Keep the value branch deliberately literal-shaped.
    re.compile(r'''(?ix)(?<![A-Za-z0-9_])["']?(?:token|secret|credential|password)["']?\s*[:=]\s*((?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^\n`<>#]+))'''),
    re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[0-9A-Za-z-]{10,}|sk-(?:[A-Za-z0-9]+-)*[A-Za-z0-9]{20,})\b"),
)
PRIVATE_ORIGIN_RE = re.compile(
    r"(?ix)\bhttps?://(?:[^\s/@:]+(?::[^\s/@]*)?@)?"
    r"(?:localhost|127(?:\.[0-9]{1,3}){3}|10(?:\.[0-9]{1,3}){3}|"
    r"192\.168(?:\.[0-9]{1,3}){2}|172\.(?:1[6-9]|2[0-9]|3[0-1])(?:\.[0-9]{1,3}){2}|"
    r"169\.254(?:\.[0-9]{1,3}){2}|0\.0\.0\.0|::1|\[::1\]|"
    r"\[(?:f[c-d][0-9a-f]{2}|fe[89a-f][0-9a-f])(?::[0-9a-f:.]+)*\]|"
    r"[^\s./]+\.local\.?|[^\s./]+\.internal(?:\.[^\s/:?#]+(?:\.[^\s/:?#]+)*)?\.?)"
    r"(?=$|[:/?#])"
)
SAFE_LOCAL_ORIGIN_RE = re.compile(
    r"(?i)\bhttps?://(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?(?:[/?#][^\s`<>)]*)?(?![A-Za-z0-9.-])"
)
FORBIDDEN_YAML_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
PLACEHOLDER_VALUES = {
    "example",
    "example-token",
    "placeholder",
    "redacted",
    "token",
    "value",
    "pass",
    "password",
    "user",
    "username",
    "localhost",
    "127.0.0.1",
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
CANONICAL_REVIEW_RULES = {
    "codex_quota": "after-two-consecutive-explicit-quota-limit-responses-for-unchanged-head-may-skip-review",
    "tests_and_scripts": "finding_only_in_tests_or_scripts: implement_P0_P1; disposition_and_resolve_P2_P3_without_implementation_time. This exception applies only to findings confined to tests or scripts.",
    "all_other_paths": "P0_P1_P2_P3_must_be_actually_resolved; do_not_use_the_tests_scripts_exception",
    "all_findings": "must_be_dispositioned_and_resolved",
    "post_merge_cleanup": "only_exact_corresponding_worktree_local_branch_remote_branch",
}
GLOBAL_MANIFEST_KEYS = {"version", "registry", "skills"}
GLOBAL_REGISTRY_DESCRIPTOR = {
    "repository": "tonglam/codex-workspace-config",
    "ref": "7e92336ec04d38f7bb95620e304ce6ec6567c896",
    "path": "registry/workspace-assets.json",
    "sha256": "fa1a2a5448e34376c4dccfe43c6c8a901adb9b62df3995b1f11d3aa4b9b77cb6",
}
CANONICAL_CONFIG_COMMIT = "312eaf56264f65bcc74fd7b81d8981a3517eca02"
IGNORED_PARTS = {".git", "node_modules", ".next"}
UNMANAGED_INSTRUCTION_PREFIXES = {
    (".agents", "skills"),
}


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
    # A quote starts a YAML scalar after a mapping key as well as at column
    # zero (for example, ``description: "Discuss # literally"``).  Do not
    # treat an apostrophe in a plain scalar such as ``user's route`` as a
    # quote opener.
    mapping = re.match(r"^[A-Za-z_][A-Za-z0-9_-]*:(?:[ \t]+|$)", value)
    scalar_start = mapping.end() if mapping else 0
    quote: str | None = None
    escaped = False
    skip_single_escape = False
    for index, char in enumerate(value):
        if skip_single_escape:
            skip_single_escape = False
            continue
        if quote == '"' and escaped:
            escaped = False
            continue
        if quote == '"' and char == "\\":
            escaped = True
            continue
        if quote == "'":
            if char == "'":
                # YAML escapes an apostrophe inside a single-quoted scalar by
                # doubling it; it must not close the scalar before a hash.
                if index + 1 < len(value) and value[index + 1] == "'":
                    skip_single_escape = True
                else:
                    quote = None
            continue
        if char in {'"', "'"} and quote is None and index == scalar_start:
            quote = char
        elif char == "#" and quote is None and (index == 0 or value[index - 1].isspace()):
            return value[:index].rstrip()
    return value.rstrip()


def _parse_scalar(value: str, path: Path, line_number: int, *, scalar_only: bool = False) -> Any:
    value = _strip_yaml_comment(value.strip())
    if not value:
        raise ValueError(f"{path}:{line_number}: empty YAML value")
    if FORBIDDEN_YAML_CONTROL_RE.search(value):
        raise ValueError(f"{path}:{line_number}: YAML scalar contains a forbidden control character")
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
            if FORBIDDEN_YAML_CONTROL_RE.search(decoded):
                raise ValueError(f"{path}:{line_number}: YAML scalar contains a forbidden control character")
            return decoded
        index = 1
        while index < len(value) - 1:
            if value[index] != "'":
                index += 1
                continue
            if index + 1 < len(value) - 1 and value[index + 1] == "'":
                index += 2
                continue
            raise ValueError(f"{path}:{line_number}: invalid single-quoted YAML scalar")
        decoded = value[1:-1].replace("''", "'")
        if FORBIDDEN_YAML_CONTROL_RE.search(decoded):
            raise ValueError(f"{path}:{line_number}: YAML scalar contains a forbidden control character")
        return decoded
    if value[0] not in "[{":
        # Apostrophes and brackets are ordinary characters in a YAML plain
        # scalar (for example, "user's route" or "[locale]").
        if value[0] in "]}!&*@`>|%,?" or value[0] == "#":
            raise ValueError(f"{path}:{line_number}: reserved YAML indicator must be quoted")
        if re.match(r"[-?:](?:\s|$)", value):
            raise ValueError(f"{path}:{line_number}: reserved YAML indicator must be quoted")
        if re.search(r":\s", value):
            raise ValueError(f"{path}:{line_number}: colon followed by whitespace must be quoted in a YAML scalar")
        if value.endswith(":"):
            raise ValueError(f"{path}:{line_number}: a plain YAML scalar may not end with a colon")
        # Instruction metadata is consumed as strings. Reject the remaining
        # YAML implicit scalar forms instead of accepting a value that a real
        # loader would deserialize as a number, boolean, null, or timestamp.
        implicit_number = re.fullmatch(
            r"(?i)[+-]?(?:(?:0|[1-9][0-9_]*)(?:\.[0-9_]*)?(?:e[+-]?[0-9]+)?|0x[0-9a-f_]+|0o[0-7_]+|0b[01_]+|\.[0-9_]+(?:e[+-]?[0-9]+)?)",
            value,
        )
        implicit_special = re.fullmatch(r"(?i)[+-]?\.(?:inf|nan)", value)
        implicit_bool = re.fullmatch(r"(?i)(?:yes|no|on|off)", value)
        implicit_timestamp = re.fullmatch(r"\d{4}-\d{1,2}-\d{1,2}(?:$|[Tt ][0-9])", value)
        if implicit_number or implicit_special or implicit_bool or implicit_timestamp:
            if scalar_only:
                raise ValueError(f"{path}:{line_number}: YAML scalar uses an implicit non-string type")
            return 0
        if re.fullmatch(r"(?i)(?:null|~)", value):
            if scalar_only:
                raise ValueError(f"{path}:{line_number}: YAML null is not a string scalar")
            return None
        if re.fullmatch(r"(?i)(?:true|false)", value):
            if scalar_only:
                raise ValueError(f"{path}:{line_number}: YAML boolean is not a string scalar")
            return value.casefold() == "true"
        if re.fullmatch(r"[-+]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", value):
            if scalar_only:
                raise ValueError(f"{path}:{line_number}: YAML number is not a string scalar")
            return float(value) if "." in value else int(value)
        return value
    # The metadata used by these skills only requires mappings and scalar
    # interface fields. Reject flow-style collections instead of pretending to
    # parse them; accepting an empty list/map would let malformed YAML such as
    # ``[a,,b]`` pass while a real YAML loader rejects it.
    raise ValueError(f"{path}:{line_number}: flow-style YAML collections are unsupported")


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
        separator = content.find(":")
        if separator + 1 < len(content) and not content[separator + 1].isspace():
            raise ValueError(f"{path}:{line_number}: YAML mapping colon must be followed by whitespace")
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


def _has_symlink_component(path: Path, root: Path) -> bool:
    """Return whether a repository-relative path traverses a symlink."""

    path = path.absolute()
    root = root.absolute()
    try:
        relative = path.relative_to(root)
    except ValueError:
        return False
    current = root
    for part in relative.parts:
        current /= part
        if current.is_symlink():
            return True
    return False


def _is_unmanaged_instruction_path(relative: Path) -> bool:
    """Return whether a relative path belongs to an installer-owned tree."""

    parts = relative.parts
    return any(part in IGNORED_PARTS for part in parts) or any(
        len(parts) >= len(prefix) and parts[: len(prefix)] == prefix
        for prefix in UNMANAGED_INSTRUCTION_PREFIXES
    )


def _is_unmanaged_plugin_skill_path(path: Path, repo: Path) -> bool:
    """Return whether a reference targets the legacy plugin skill mount.

    Repositories may keep `.claude/skills/*` symlinks created by their existing
    skill installer.  Those links are intentionally outside this governance
    contract; do not recurse into or reject them while validating a governed
    root instruction file.  Contract-listed `.agents/skills/*` remain fully
    governed through ``validate_skill``.
    """

    try:
        relative = path.absolute().relative_to(repo.absolute())
    except ValueError:
        return False
    if len(relative.parts) < 3 or relative.parts[:2] != (".claude", "skills"):
        return False
    # Keep the narrow legacy exemption for installer-created symlink aliases;
    # a regular Claude skill directory is repository-owned and must be
    # discovered and governed like every other instruction entrypoint.
    return (repo / ".claude" / "skills" / relative.parts[2]).is_symlink()


def resolve_path(
    repo: Path,
    value: str,
    *,
    allow_absolute_inside_repo: bool = False,
    allow_external: bool = False,
) -> Path:
    candidate = Path(value)
    lexical = candidate if candidate.is_absolute() else repo / candidate
    if candidate.is_absolute():
        if not allow_absolute_inside_repo:
            raise ValueError(f"required instruction path must be repository-relative: {value}")
        resolved = lexical.resolve()
    else:
        if ".." in candidate.parts:
            raise ValueError(f"required instruction path may not escape the repository: {value}")
        resolved = lexical.resolve()
    root = repo.resolve()
    if not allow_external and not _is_within(resolved, root):
        raise ValueError(f"required instruction path escapes the repository: {value}")
    if not allow_external and _has_symlink_component(lexical, repo):
        raise ValueError(f"required instruction path may not be a symlink: {value}")
    return lexical.absolute()


def _without_markdown_code(text: str) -> str:
    """Remove fenced and inline code before extracting operative links."""

    lines: list[str] = []
    # Keep the block-quote container depth with a fence.  A Markdown fence
    # inside ``> ...`` is still code, but the leading ``>`` means the old
    # space-only detector never entered fence mode and scanned its examples as
    # operative links.
    # (marker character, minimum run length, quote depth, list content indent)
    fence: tuple[str, int, int, int | None] | None = None
    active_list_content_indent: int | None = None
    for line in text.splitlines(keepends=True):
        body = line.rstrip("\r\n")
        marker: tuple[str, int, int, str] | None = None
        list_content_indent: int | None = None
        # A blank line does not end a list item. Remember the content column
        # so a four-space continuation (``- item`` followed by
        # ``    [link](required.md)``) is treated as list content rather than
        # as a top-level indented code block. Reset only when a non-list line
        # returns to a shallower top-level indentation.
        list_context = re.match(r"^( {0,3})([-+*]|\d+[.)])([ \t]+)", body)
        if list_context:
            active_list_content_indent = (
                len(list_context.group(1))
                + len(list_context.group(2))
                + len(list_context.group(3))
            )
        elif body.strip() and not body.startswith(">") and active_list_content_indent is not None:
            leading = len(body) - len(body.lstrip(" "))
            if leading < active_list_content_indent:
                active_list_content_indent = None
        # CommonMark permits up to three spaces before a block-quote marker,
        # an optional space after each marker, and up to three spaces before
        # the fenced-code marker.  Counting ``>`` markers keeps nested quotes
        # from accidentally closing an outer fence.
        quote_match = re.match(r"^( {0,3}(?:> ?)+)( {0,3})(`{3,}|~{3,})(.*)$", body)
        if quote_match:
            prefix = quote_match.group(1)
            run = quote_match.group(3)
            marker = (run[0], len(run), prefix.count(">"), quote_match.group(4))
        else:
            # A fenced block may be the contents of a list item.  The list
            # marker is a container prefix, not part of the fence itself;
            # retain the quote depth so a nested quote cannot close it.
            list_match = re.match(
                r"^( {0,3}(?:> ?)*)( {0,3})([-+*]|\d+[.)])([ \t]+)(`{3,}|~{3,})(.*)$",
                body,
            )
            if list_match:
                prefix = list_match.group(1)
                run = list_match.group(5)
                list_content_indent = (
                    (0 if ">" in prefix else len(prefix))
                    + len(list_match.group(2))
                    + len(list_match.group(3))
                    + len(list_match.group(4))
                )
                marker = (run[0], len(run), prefix.count(">"), list_match.group(6))
            else:
                normal_match = re.match(r"^( {0,3})(`{3,}|~{3,})(.*)$", body)
                if normal_match:
                    run = normal_match.group(2)
                    marker = (run[0], len(run), 0, normal_match.group(3))
        if marker is not None:
            if fence is None:
                fence = (*marker[:3], list_content_indent)
            elif (
                marker[0] == fence[0]
                and marker[1] >= fence[1]
                and marker[2] == fence[2]
                and not marker[3].strip()
            ):
                fence = None
            lines.append("\n" if line.endswith("\n") else "")
            continue
        if fence is not None:
            if fence[3] is not None:
                indented_close = re.match(r"^( *)(`{3,}|~{3,})[ \t]*$", body)
                if (
                    indented_close
                    and len(indented_close.group(1)) >= fence[3]
                    and indented_close.group(2)[0] == fence[0]
                    and len(indented_close.group(2)) >= fence[1]
                ):
                    fence = None
                    lines.append("\n" if line.endswith("\n") else "")
                    continue
            quote_prefix = re.match(r"^ {0,3}(?:> ?)+", body)
            quote_depth = quote_prefix.group(0).count(">") if quote_prefix else 0
            if quote_depth < fence[2]:
                fence = None
            elif fence[3] is not None and body.strip():
                prefix = quote_prefix.group(0) if quote_prefix else ""
                content = body[len(prefix) :]
                if len(content) - len(content.lstrip(" ")) < fence[3]:
                    fence = None
            if fence is not None:
                lines.append("\n" if line.endswith("\n") else "")
                continue
        # Four-space indentation is an indented CommonMark code block. Keep
        # its newlines so line-oriented parsing still works, but do not let
        # example links or governance clauses become operative text.
        code_indent = (active_list_content_indent + 4) if active_list_content_indent is not None else 4
        if len(body) - len(body.lstrip(" ")) >= code_indent and body.strip():
            lines.append("\n" if line.endswith("\n") else "")
            continue
        # Inline-code spans are masked in one pass below so a delimiter run
        # can legally cross a physical newline.
        lines.append(line)
    masked_text = "".join(lines)
    # Inline code spans may cross a physical newline. Scan delimiter runs
    # explicitly so a two-backtick opener cannot be mistaken for two adjacent
    # one-backtick spans, and preserve all line positions while masking them.
    masked_chars = list(masked_text)
    index = 0
    while index < len(masked_text):
        if masked_text[index] != "`" or (index and masked_text[index - 1] == "\\"):
            index += 1
            continue
        end = index
        while end < len(masked_text) and masked_text[end] == "`":
            end += 1
        delimiter = masked_text[index:end]
        closing = masked_text.find(delimiter, end)
        while closing >= 0:
            before = masked_text[closing - 1] if closing else ""
            after_index = closing + len(delimiter)
            after = masked_text[after_index] if after_index < len(masked_text) else ""
            # A delimiter must be an exact-length run. Do not close a
            # two-backtick span on the first two characters of a
            # three-backtick run (or vice versa).
            if before != "`" and after != "`":
                break
            closing = masked_text.find(delimiter, closing + 1)
        if closing < 0:
            index = end
            continue
        for position in range(index, closing + len(delimiter)):
            if masked_chars[position] != "\n":
                masked_chars[position] = " "
        index = closing + len(delimiter)
    masked_text = "".join(masked_chars)
    # HTML comments are non-operative Markdown. Mask them after code removal
    # so links in commented examples cannot become required files.
    masked_text = re.sub(
        r"<!--.*?(?:-->|$)",
        lambda match: "".join("\n" if char == "\n" else " " for char in match.group(0)),
        masked_text,
        flags=re.S,
    )
    # Raw HTML blocks do not contain operative Markdown links. Only recognize
    # a tag at a Markdown block start (up to three spaces or block-quote
    # markers); inline and backslash-escaped tags remain operative text.
    block_start = r"^(?: {0,3}>[ \t]?)* {0,3}(?<!\\)"
    closed_block = re.compile(
        block_start + r"<(pre|script|style|textarea|xmp|plaintext)\b[^>]*>.*?(?:</\1\s*>|\Z)",
        flags=re.IGNORECASE | re.MULTILINE | re.DOTALL,
    )
    blank_terminated = re.compile(
        block_start + r"<(iframe|noembed|noframes)\b[^>]*>.*?(?:</\1\s*>|(?=\n[ \t]*\n|\Z))",
        flags=re.IGNORECASE | re.MULTILINE | re.DOTALL,
    )
    for pattern in (closed_block, blank_terminated):
        masked_text = pattern.sub(
            lambda match: "".join("\n" if char == "\n" else " " for char in match.group(0)),
            masked_text,
        )
    return masked_text


def _markdown_targets(text: str) -> Iterable[str]:
    # The usual regular expression form stops at the first closing parenthesis
    # and rejects legitimate destinations such as ``guide_(v2).md``. Walk the
    # destination so balanced parentheses and escaped characters are retained.
    text = _without_markdown_code(text)
    # Collect markers first instead of advancing past each destination. This
    # preserves an enclosing marker in linked-image syntax such as
    # ``[![alt](image.md)](page.md)``.
    for marker_match in re.finditer(r"\]\(", text):
        marker = marker_match.start()
        # Track unescaped bracket nesting. The top of the stack is the opener
        # for this closing bracket; an enclosing link is visited by its own
        # later marker.
        stack: list[int] = []
        scan = 0
        while scan < marker:
            if text[scan] == "\\":
                scan += 2
                continue
            if text[scan] == "[":
                stack.append(scan)
            elif text[scan] == "]" and stack:
                stack.pop()
            scan += 1
        opener = stack[-1] if stack else -1
        if opener < 0:
            continue
        slashes = 0
        index = opener - 1
        while opener >= 0 and index >= 0 and text[index] == "\\":
            slashes += 1
            index -= 1
        if opener >= 0 and slashes % 2 == 1:
            continue
        index = marker + 2
        while index < len(text) and text[index].isspace():
            index += 1
        if index >= len(text):
            continue
        if text[index] == "<":
            end = text.find(">", index + 1)
            if end < 0:
                # A malformed angle destination must not hide later valid
                # links in the same instruction file.
                continue
            yield text[index + 1 : end]
            continue
        start = index
        depth = 0
        escaped = False
        for index in range(start, len(text)):
            char = text[index]
            if escaped:
                escaped = False
                continue
            if char == "\\":
                escaped = True
                continue
            if char == "(":
                depth += 1
            elif char == ")":
                if depth == 0:
                    raw = text[start:index].strip()
                    yield raw.split(None, 1)[0] if raw else raw
                    break
                depth -= 1
        else:
            # Keep scanning after an unmatched destination so a later link
            # can still be validated.
            continue
    html_target = re.compile(
        r'''(?ix)\b(?:href|src)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'<>`]+))'''
    )
    for match in html_target.finditer(text):
        for value in match.groups():
            if value is not None:
                yield value
                break
    for match in REFERENCE_DEF_RE.finditer(text):
        raw = match.group(2)
        yield raw[1:-1] if raw.startswith("<") and raw.endswith(">") else raw


def _is_external_target(target: str) -> bool:
    """Return whether a Markdown target is a URI rather than a file path."""

    return target.startswith(("#", "//")) or bool(URI_SCHEME_RE.match(target))


def _unescape_markdown_destination(target: str) -> str:
    """Decode backslash escapes used by Markdown link destinations."""

    return re.sub(r"\\([!\"#$%&'()*+,./:;<=>?@\[\\\]^_`{|}~-])", r"\1", target)


def _normalize_reference_target(raw_target: str) -> str:
    """Decode Markdown escapes/percent-encoding before URI/path handling."""

    target = _unescape_markdown_destination(raw_target.strip())
    # Strip literal URI query/fragment delimiters before percent-decoding. A
    # filename containing an encoded ``%3F``/``%23`` must not be truncated as
    # if the decoded character had been present in the original destination.
    target = target.split("#", 1)[0].split("?", 1)[0].strip()
    # Percent-encoded schemes (for example ``https%3A//example.test``) must
    # be classified as external before the path is resolved locally.
    return unquote(target).strip()


def check_reference_links(
    instruction_file: Path,
    repo: Path,
    errors: list[str],
    *,
    allow_external: bool = False,
) -> None:
    text = instruction_file.read_text(encoding="utf-8")
    for raw_target in _markdown_targets(text):
        target = _normalize_reference_target(raw_target)
        if not target or _is_external_target(target):
            continue
        lexical = instruction_file.parent / target
        if not allow_external and _is_unmanaged_plugin_skill_path(lexical, repo):
            continue
        candidate = lexical.resolve()
        if not allow_external and _has_symlink_component(lexical, repo):
            errors.append(f"{instruction_file}: relative reference may not be a symlink: {target}")
            continue
        if not allow_external and not _is_within(candidate, repo.resolve()):
            errors.append(f"{instruction_file}: relative reference escapes repository: {target}")
        elif not candidate.exists():
            errors.append(f"{instruction_file}: missing relative reference {target}")
        elif candidate.is_dir():
            errors.append(f"{instruction_file}: relative reference must target a file: {target}")


def scan_reference_graph(
    entrypoint: Path,
    repo: Path,
    policy: dict[str, Any],
    errors: list[str],
    *,
    allow_external: bool = False,
) -> None:
    """Scan repository-local Markdown/config references, not just their links."""

    queue = [entrypoint]
    visited: set[Path] = set()
    while queue:
        current = queue.pop()
        try:
            current_resolved = current.resolve()
        except OSError:
            continue
        if current_resolved in visited:
            continue
        visited.add(current_resolved)
        try:
            text = current.read_text(encoding="utf-8")
        except OSError:
            continue
        for raw_target in _markdown_targets(text):
            target = _normalize_reference_target(raw_target)
            if not target or _is_external_target(target):
                continue
            lexical = current.parent / target
            if not allow_external and _is_unmanaged_plugin_skill_path(lexical, repo):
                continue
            try:
                candidate = lexical.resolve()
            except OSError:
                continue
            if not allow_external and not _is_within(candidate, repo.resolve()):
                continue
            if not candidate.is_file():
                continue
            if not allow_external and (_has_symlink_component(lexical, repo) or not _is_within(candidate, repo.resolve())):
                errors.append(f"{lexical}: referenced instruction must remain inside the repository and may not be a symlink")
                continue
            try:
                raw = candidate.read_bytes()
                if b"\0" in raw[:8192]:
                    if policy.get("forbid_secrets_in_instructions") and has_secret_bytes(raw):
                        errors.append(f"{candidate}: possible secret/token pattern")
                    continue
                reference_text = raw.decode("utf-8")
            except OSError as exc:
                errors.append(f"{candidate}: cannot read referenced instruction: {exc}")
                continue
            except UnicodeDecodeError:
                if policy.get("forbid_secrets_in_instructions") and has_secret_bytes(raw):
                    errors.append(f"{candidate}: possible secret/token pattern")
                continue
            if not reference_text.strip():
                errors.append(f"{candidate}: referenced instruction is empty")
            is_reference_text = candidate.suffix.casefold() in REFERENCE_TEXT_SUFFIXES or candidate.suffix == ""
            if is_reference_text and candidate.suffix.casefold() == ".md" and candidate.stat().st_size > int(policy.get("max_skill_bytes", 32768)):
                errors.append(f"{candidate}: referenced instruction exceeds max_skill_bytes")
            if policy.get("forbid_secrets_in_instructions") and has_secret_bytes(raw):
                errors.append(f"{candidate}: possible secret/token pattern")
            # Only recurse through known instruction/config text (plus
            # extensionless files, which are commonly executable instruction
            # entrypoints). Linked source/binary files are still scanned for
            # secrets but are not parsed as Markdown.
            if is_reference_text:
                check_reference_links(candidate, repo, errors, allow_external=allow_external)
                queue.append(candidate)


def check_governance_binding(path: Path, text: str, errors: list[str]) -> None:
    """Keep the policy's operative review rules visible in loaded AGENTS.md."""

    # Treat wrapped Markdown lines as one clause while retaining word
    # boundaries; otherwise a harmless line wrap can disable the check.
    section, outside = _governance_parts(text)
    if section is None:
        errors.append(f"{path}: must contain exactly one operative '## Governance and review' section")
        lowered = ""
    else:
        lowered = section.casefold()
        conflicts = (
            r"\b(?:ignore|disregard|bypass|waive)\b.{0,160}\b(?:review|finding|thread|ci|cleanup|quota|unresolved|undispositioned)\b",
            r"\b(?:merge|ship|release)\b.{0,160}\b(?:without|even\s+with)\b.{0,80}\b(?:review|finding|thread|ci|cleanup|unresolved|undispositioned)\b",
            r"\b(?:allow|permit)\b.{0,160}\b(?:merge|ship|release)\b.{0,80}\b(?:unresolved|undispositioned)\b",
        )
        if any(re.search(pattern, section, flags=re.I | re.S) for pattern in conflicts):
            errors.append(f"{path}: Governance and review section conflicts with the mandatory review rules")
        if any(re.search(pattern, outside, flags=re.I | re.S) for pattern in conflicts):
            errors.append(f"{path}: operative text outside Governance and review conflicts with the mandatory review rules")
    required_clauses = {
        "quota rule": (
            "a review may be skipped only after two consecutive explicit quota-limit responses",
            "this never waives ci, findings, or cleanup",
        ),
        "tests/scripts exception": (
            "every p0-p3 finding must be dispositioned and its thread resolved",
            "only a finding confined to tests/scripts gets the time exception",
            "implement p0/p1",
            "explain plus resolve p2/p3",
        ),
        "all-path severity rule": ("p2/p3 anywhere else must be actually fixed and verified",),
        "finding disposition rule": (
            "merge is prohibited while any finding is undispositioned or any review thread is unresolved",
        ),
        "cleanup rule": (
            "after merge, clean only the exact corresponding worktree, local branch, and remote branch",
        ),
    }
    for label, clauses in required_clauses.items():
        if not all(clause in lowered for clause in clauses):
            errors.append(f"{path}: missing operative {label} clause")


def _governance_parts(text: str) -> tuple[str | None, str]:
    """Return the operative governance section and text outside it."""

    # Headings in fenced/indented Markdown examples are not operative.  A
    # duplicate operative heading is rejected rather than allowing the first
    # one to hide a contradictory later section.
    lines = _without_markdown_code(text).splitlines()
    matches = [
        index
        for index, line in enumerate(lines)
        if re.match(r"^\s*##\s+Governance and review\s*$", line, flags=re.I)
    ]
    if len(matches) != 1:
        return None, ""
    start = matches[0]
    end = len(lines)
    for index in range(start + 1, len(lines)):
        if re.match(r"^\s*##\s+", lines[index]):
            end = index
            break
    section = " ".join("\n".join(lines[start:end]).split())
    outside = " ".join("\n".join(lines[:start] + lines[end:]).split()).casefold()
    return section, outside


def _governance_section(text: str) -> str | None:
    """Return a whitespace-normalized governance section for parity checks."""

    section, _ = _governance_parts(text)
    return section


def check_agents_claude_consistency(repo: Path, errors: list[str]) -> None:
    """Keep an optional Claude consumer's governance section equal to AGENTS."""

    agents_path = repo / "AGENTS.md"
    claude_path = repo / "CLAUDE.md"
    if not agents_path.is_file() or not claude_path.is_file():
        return
    try:
        agents_section = _governance_section(agents_path.read_text(encoding="utf-8"))
        claude_section = _governance_section(claude_path.read_text(encoding="utf-8"))
    except OSError as exc:
        errors.append(f"{repo}: cannot compare AGENTS.md and CLAUDE.md governance sections: {exc}")
        return
    if agents_section is None or claude_section is None:
        errors.append(f"{claude_path}: must contain the same '## Governance and review' section as AGENTS.md")
    elif agents_section != claude_section:
        errors.append(f"{claude_path}: governance section must match AGENTS.md")


def _looks_like_placeholder(value: str) -> bool:
    normalized = value.strip().casefold()
    # Secret-value captures often include a JSON/YAML or expression
    # delimiter (for example ``process.env.PASSWORD,``). Remove only trailing
    # delimiters before matching complete environment lookups; literal values
    # remain subject to the normal secret heuristics below.
    normalized = normalized.rstrip(",;").strip()
    if "\n" in normalized:
        lines = [line.strip() for line in normalized.splitlines() if line.strip()]
        return bool(lines) and all(_looks_like_placeholder(line) for line in lines)
    # Exempt only a complete environment lookup. A lookup with a literal
    # fallback (or a literal suffix/prefix) is still a committed value and
    # must continue through the normal secret heuristics.
    if re.fullmatch(r"(?:os\.)?environ(?:\s*\[[^\]]+\]|\.[a-z_][a-z0-9_]*)", normalized):
        return True
    if re.fullmatch(r"(?:os\.)?environ\.get\(\s*['\"][^'\"]+['\"]\s*\)", normalized):
        return True
    if re.fullmatch(r"(?:os\.)?getenv\(\s*['\"][^'\"]+['\"]\s*\)", normalized):
        return True
    if re.fullmatch(r"process\.env(?:\s*\[[^\]]+\]|\.[a-z_][a-z0-9_]*)", normalized):
        return True
    fallback = re.fullmatch(
        r"(?:os\.)?getenv\(\s*['\"][^'\"]+['\"]\s*,\s*(.+)\s*\)",
        normalized,
        flags=re.S,
    )
    if fallback:
        return _looks_like_placeholder(fallback.group(1))
    fallback = re.fullmatch(
        r"(?:os\.)?environ\.get\(\s*['\"][^'\"]+['\"]\s*,\s*(.+)\s*\)",
        normalized,
        flags=re.S,
    )
    if fallback:
        return _looks_like_placeholder(fallback.group(1))
    fallback = re.fullmatch(
        r"process\.env(?:\s*\[[^\]]+\]|\.[a-z_][a-z0-9_]*)\s*\|\|\s*(.+)",
        normalized,
        flags=re.S,
    )
    if fallback:
        return _looks_like_placeholder(fallback.group(1))
    if normalized.startswith("${"):
        # Shell defaults such as ${TOKEN:-live-value} are not placeholders;
        # inspect the fallback while retaining ${TOKEN} as a placeholder.
        if not normalized.endswith("}"):
            return False
        body = normalized[2:-1]
        # Bash pattern substitution embeds a literal replacement operand. A
        # secret in `${TOKEN/pattern/replacement}` must not be treated as a
        # harmless environment placeholder merely because the expansion is
        # syntactically valid.
        substitution = re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*//?[^/]*/(.+)", body, flags=re.S)
        if substitution:
            return _looks_like_placeholder(substitution.group(1))
        # Shell parameter expansions support both colon and non-colon forms
        # (`-`, `=`, `?`, `+`). Inspect every fallback rather than treating
        # only the `:-` spelling as a placeholder.
        match = re.match(r"^[A-Za-z_][A-Za-z0-9_]*(?::?[-+=?])(.*)$", body, flags=re.S)
        if match:
            return _looks_like_placeholder(match.group(1))
        return True
    normalized = normalized.rstrip(",;").strip()
    if not normalized:
        return True
    # Strip one complete grouping/container layer and inspect its contents.
    # This keeps parenthesized literals and literal list/dict values subject
    # to the secret check instead of treating every bracketed expression as a
    # harmless placeholder.
    pairs = {"(": ")", "[": "]", "{": "}"}
    if normalized[0] in pairs and normalized[-1] == pairs[normalized[0]]:
        depth = 0
        balanced = True
        for index, char in enumerate(normalized):
            if char in pairs:
                depth += 1
            elif char in pairs.values():
                depth -= 1
                if depth == 0 and index != len(normalized) - 1:
                    balanced = False
                    break
                if depth < 0:
                    balanced = False
                    break
        if balanced and depth == 0:
            return _looks_like_placeholder(normalized[1:-1])
    # A call/expression with embedded quoted literals is only a placeholder
    # when all embedded literals are placeholders. This prevents
    # ``decrypt("live-secret")`` and similar wrappers from bypassing scans,
    # while preserving ordinary ``value.casefold()`` assignments.
    literals = []
    for match in re.finditer(r'''"((?:\\.|[^"\\])*)"|'((?:''|[^'])*)' ''', normalized, flags=re.X):
        literals.append(match.group(1) if match.group(1) is not None else match.group(2))
    if literals:
        return all(_looks_like_placeholder(literal) for literal in literals)
    # A generic ``token``/``secret`` variable is frequently assigned from a
    # parser or environment expression. With no embedded literal, keep it out
    # of the literal-secret heuristic while the surrounding source remains
    # subject to normal review.
    if re.search(r"[()\[\]{}]", normalized) or re.search(r"\.\w+\s*\(", normalized):
        return True
    return (
        normalized in PLACEHOLDER_VALUES
        or (normalized.startswith("<") and normalized.endswith(">"))
        or normalized in {"your-api-key", "your-access-token", "replace-me"}
    )


def _has_private_ip_literal(text: str) -> bool:
    """Reject private, loopback, link-local, and unspecified IP literals."""

    for match in IP_LITERAL_RE.finditer(text):
        value = match.group(0).strip("[]")
        try:
            address = ipaddress.ip_address(value)
        except ValueError:
            continue
        # Loopback literals are common in test instructions (often alongside
        # ``localhost``/``loopback`` and a ``*_test`` database). URL-shaped
        # origins are still covered by PRIVATE_ORIGIN_RE above; suppress only
        # this explicit documentation pattern to avoid noisy false positives.
        if value in {"127.0.0.1", "::1"} and re.search(r"\b(?:localhost|loopback|test)\b", text, re.IGNORECASE):
            continue
        # TEST-NET ranges are documentation-only and should not be treated as
        # private deployment origins when they appear in examples.
        if any(address in ipaddress.ip_network(network) for network in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "2001:db8::/32")):
            continue
        if address.is_private or address.is_loopback or address.is_link_local or address.is_unspecified:
            return True
    return False


def has_secret(text: str) -> bool:
    # Local development endpoints are valid documentation when they contain
    # no userinfo. Scrub only that exact host/port/path form; a credentialed
    # URL (or any other private origin) remains visible to the scanner.
    scrubbed = SAFE_LOCAL_ORIGIN_RE.sub(" ", text)
    if PEM_RE.search(text) or PRIVATE_ORIGIN_RE.search(scrubbed) or _has_private_ip_literal(scrubbed):
        return True
    for pattern in SECRET_VALUE_RES:
        for match in pattern.finditer(text):
            value = match.group(1) if match.lastindex else match.group(0)
            if not _looks_like_placeholder(value):
                return True
    return False


LOCKED_CREDENTIAL_KEY_RE = re.compile(
    r"(?i)\b(?:api[_ -]?(?:key|token)|access[_ -]?(?:token|key)|"
    r"private[_ -]?key|client[_ -]?secret|service[_ -]?(?:role[_ -]?)?"
    r"(?:key|token)|secret[_ -]?(?:access[_ -]?)?(?:key|token)|"
    r"notification[_ -]?(?:api[_ -]?)?token|metrics[_ -]?token|"
    r"telegram[_ -]?bot[_ -]?token|session[_ -]?(?:cookie|token)|cookie)"
)


def has_locked_skill_secret(text: str) -> bool:
    """Scan installed plugin content without enforcing repository skill metadata."""

    if (
        PEM_RE.search(text)
        or BASIC_AUTH_RE.search(text)
        or SECRET_VALUE_RES[-1].search(text)
    ):
        return True
    for pattern in (CLI_CREDENTIAL_RE, AWS_CREDENTIAL_ARGUMENT_RE):
        for match in pattern.finditer(text):
            value = match.group(1) if match.lastindex else match.group(0)
            if not _looks_like_placeholder(value):
                return True
    for pattern in SECRET_VALUE_RES[:-1]:
        if pattern in {CLI_CREDENTIAL_RE, AWS_CREDENTIAL_ARGUMENT_RE}:
            continue
        for match in pattern.finditer(text):
            if pattern is BASIC_AUTH_RE:
                value = match.group(1) if match.lastindex else match.group(0)
                return True
            if not LOCKED_CREDENTIAL_KEY_RE.search(match.group(0)):
                continue
            value = match.group(1) if match.lastindex else match.group(0)
            if not _looks_like_placeholder(value):
                return True
    return False


def _json_field_has_secret(field: str, *, locked: bool = False) -> bool:
    """Check whether a decoded JSON field name is a credential-bearing key."""

    probe = f'"{field}": "credential-probe-value"'
    return has_locked_skill_secret(probe) if locked else has_secret(probe)


def has_secret_bytes(raw: bytes) -> bool:
    """Scan binary/text references without losing UTF-16/UTF-32 credentials."""

    candidates = [raw.decode("latin-1")]
    # UTF-16/32 files commonly contain NUL bytes and are otherwise skipped as
    # binary. Decode the bounded candidate set before falling back to the
    # byte-preserving representation; malformed encodings are harmlessly
    # ignored and remain covered by the latin-1 scan.
    for encoding in ("utf-8-sig", "utf-16", "utf-16-le", "utf-16-be", "utf-32", "utf-32-le", "utf-32-be"):
        try:
            decoded = raw.decode(encoding)
            candidates.append(decoded)
            # JSON consumers decode escaped object keys/values before using
            # them. Scan a normalized serialization as well so an escaped
            # ``passw\\u006frd`` key cannot hide a literal credential.
            try:
                # Keep objects as tuples of pairs so duplicate keys remain
                # visible without retaining or serializing every descendant
                # subtree for every ancestor pair.
                parsed = json.loads(decoded, object_pairs_hook=lambda items: tuple(items))
            except (TypeError, ValueError, json.JSONDecodeError, RecursionError):
                pass
            else:
                if has_secret(json.dumps(parsed, ensure_ascii=False)):
                    return True
                pending = [(parsed, None, None)]
                while pending:
                    current, field, inherited_field = pending.pop()
                    sensitive_field = inherited_field
                    if field is not None and _json_field_has_secret(field):
                        sensitive_field = field
                    if isinstance(current, tuple):
                        for key, value in reversed(current):
                            pending.append((value, key, sensitive_field))
                    elif isinstance(current, list):
                        for value in reversed(current):
                            pending.append((value, field, sensitive_field))
                    elif sensitive_field is not None:
                        if has_secret(f'"{sensitive_field}": {json.dumps(current, ensure_ascii=False)}'):
                            return True
                    elif field is not None:
                        if has_secret(f'"{field}": {json.dumps(current, ensure_ascii=False)}'):
                            return True
                    elif isinstance(current, str) and has_secret(current):
                        return True
        except UnicodeDecodeError:
            continue
    return any(has_secret(candidate) for candidate in candidates)


def has_locked_skill_secret_bytes(raw: bytes) -> bool:
    """Scan locked skill bytes across common text encodings."""

    candidates = [raw.decode("latin-1")]
    for encoding in ("utf-8-sig", "utf-16", "utf-16-le", "utf-16-be", "utf-32", "utf-32-le", "utf-32-be"):
        try:
            decoded = raw.decode(encoding)
        except UnicodeDecodeError:
            continue
        candidates.append(decoded)
        try:
            parsed = json.loads(decoded, object_pairs_hook=lambda items: tuple(items))
        except (TypeError, ValueError, json.JSONDecodeError, RecursionError):
            continue
        if has_locked_skill_secret(json.dumps(parsed, ensure_ascii=False)):
            return True
        pending = [(parsed, None, None)]
        while pending:
            current, field, inherited_field = pending.pop()
            sensitive_field = inherited_field
            if field is not None and _json_field_has_secret(field, locked=True):
                sensitive_field = field
            if isinstance(current, tuple):
                for key, value in reversed(current):
                    pending.append((value, key, sensitive_field))
            elif isinstance(current, list):
                for value in reversed(current):
                    pending.append((value, field, sensitive_field))
            elif sensitive_field is not None:
                if has_locked_skill_secret(f'"{sensitive_field}": {json.dumps(current, ensure_ascii=False)}'):
                    return True
            elif field is not None:
                if has_locked_skill_secret(f'"{field}": {json.dumps(current, ensure_ascii=False)}'):
                    return True
            elif isinstance(current, str) and has_locked_skill_secret(current):
                return True
    return any(has_locked_skill_secret(candidate) for candidate in candidates)


def skill_tree_digest(path: Path) -> str:
    """Hash every regular file by sorted relative path and raw bytes."""

    files: list[tuple[str, bytes]] = []
    for item in path.rglob("*"):
        relative = item.relative_to(path)
        if any(part in {".git", "node_modules"} for part in relative.parts):
            continue
        if item.is_symlink():
            raise ValueError(f"{item}: locked skill tree may not contain a symlink")
        if item.is_dir():
            continue
        if not item.is_file():
            raise ValueError(f"{item}: locked skill tree contains an unsupported entry")
        files.append((relative.as_posix(), item.read_bytes()))
    digest = hashlib.sha256()
    # ``skills`` computes hashes with JavaScript's default locale ordering;
    # case-folding is the stable cross-platform equivalent for these paths.
    # Length-prefix both fields so concatenation cannot make two distinct
    # path/content sequences hash identically.
    for relative, raw in sorted(files, key=lambda value: value[0].casefold()):
        relative_bytes = relative.encode("utf-8")
        digest.update(len(relative_bytes).to_bytes(8, "big"))
        digest.update(relative_bytes)
        digest.update(len(raw).to_bytes(8, "big"))
        digest.update(raw)
    return digest.hexdigest()


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
    if skill_name and isinstance(interface.get("default_prompt"), str):
        token = re.compile(rf"\${re.escape(skill_name)}(?![A-Za-z0-9_-])")
        if not token.search(interface["default_prompt"]):
            errors.append(f"{path}: interface.default_prompt must invoke ${skill_name}")


def _skill_entrypoints(root: Path, repo: Path) -> Iterable[Path]:
    """Yield skill entrypoints, including a sentinel for symlinked directories."""

    if not root.exists() and not root.is_symlink():
        return
    pending = [root]
    while pending:
        current = pending.pop()
        if current.is_symlink():
            # Do not descend through a directory symlink.  Yielding its
            # expected entrypoint lets the normal path validation report the
            # symlink instead of silently omitting the skill from discovery.
            if current.name == "SKILL.md":
                yield current
            else:
                yield current / "SKILL.md"
            continue
        if not current.is_dir():
            continue
        try:
            children = list(current.iterdir())
        except OSError:
            continue
        for child in children:
            relative = child.relative_to(repo)
            if any(part in IGNORED_PARTS for part in relative.parts):
                continue
            if child.name == "SKILL.md":
                yield child
            elif child.is_symlink():
                if child.is_dir() or not child.exists():
                    yield child / "SKILL.md"
            elif child.is_dir():
                pending.append(child)


def _validate_skill_inventory(repo: Path, skills: list[Any], errors: list[str]) -> dict[str, str]:
    """Reject unowned repository skill directories without touching plugins.

    ``.agents/skills`` can contain both repository-owned skills and installed
    third-party mounts.  The contract names the former; ``skills-lock.json``
    records the latter.  Anything else is an untracked skill that could evade
    the governed surface, so fail closed while leaving the locked plugin trees
    untouched.
    """

    root = repo / ".agents" / "skills"
    if not root.exists() and not root.is_symlink():
        return {}
    if root.is_symlink():
        errors.append(f"{root}: skill inventory root may not be a symlink")
        return {}
    contracted: set[str] = set()
    for raw in skills:
        relative = Path(str(raw))
        parts = relative.parts
        if not relative.is_absolute() and len(parts) >= 3 and parts[:2] == (".agents", "skills"):
            contracted.add(parts[2])
    locked: dict[str, str] = {}
    lock_path = repo / "skills-lock.json"
    if lock_path.exists():
        try:
            lock = load_json(lock_path)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            errors.append(f"{lock_path}: cannot read skill lock: {exc}")
        else:
            value = lock.get("skills")
            if not isinstance(value, dict):
                errors.append(f"{lock_path}: skills must be a mapping")
            else:
                for name, metadata in value.items():
                    skill_name = str(name)
                    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", skill_name):
                        errors.append(f"{lock_path}: invalid locked skill name: {skill_name!r}")
                        continue
                    if not isinstance(metadata, dict):
                        errors.append(f"{lock_path}: metadata for {skill_name!r} must be a mapping")
                        continue
                    source = metadata.get("source")
                    source_type = metadata.get("sourceType")
                    computed_hash = metadata.get("computedHash")
                    if not isinstance(source, str) or not source.strip():
                        errors.append(f"{lock_path}: {skill_name!r} must declare a non-empty source")
                        continue
                    if not isinstance(source_type, str) or not re.fullmatch(
                        r"[a-z0-9]+(?:-[a-z0-9]+)*", source_type
                    ):
                        errors.append(f"{lock_path}: {skill_name!r} has invalid sourceType")
                        continue
                    if not isinstance(computed_hash, str) or not re.fullmatch(
                        r"[0-9a-fA-F]{64}", computed_hash
                    ):
                        errors.append(f"{lock_path}: {skill_name!r} must declare a SHA-256 computedHash")
                        continue
                    locked[skill_name] = computed_hash
    allowed = contracted | set(locked)
    try:
        children = sorted(root.iterdir(), key=lambda path: path.name)
    except OSError as exc:
        errors.append(f"{root}: cannot inspect skill inventory: {exc}")
        return locked
    for child in children:
        if child.name not in allowed:
            errors.append(
                f"{child}: skill is not listed in the instruction contract or skills-lock.json"
            )
    return locked


def _instruction_paths(
    repo: Path,
    *,
    include_discovery: bool,
    contracted_skill_names: set[str] | None = None,
) -> list[Path]:
    if not include_discovery:
        return []
    contracted_skill_names = contracted_skill_names or set()
    paths: set[Path] = set()
    # Discover repository-owned scoped entrypoints at every depth.  Installed
    # plugin/global skill trees are preserved inputs; their nested instruction
    # files are not silently promoted into this repository's contract.  The
    # contract-listed repository skills are checked separately by validate_skill.
    def should_descend(relative: Path) -> bool:
        parts = relative.parts
        if len(parts) >= 2 and parts[:2] == (".agents", "skills"):
            return len(parts) < 3 or parts[2] in contracted_skill_names
        return not _is_unmanaged_instruction_path(relative)

    for root, directories, files in os.walk(repo, followlinks=False):
        root_path = Path(root)
        relative_root = root_path.relative_to(repo)
        if relative_root.parts == (".agents", "skills") and not contracted_skill_names:
            directories[:] = []
            continue
        if len(relative_root.parts) >= 3 and relative_root.parts[:2] == (".agents", "skills"):
            if relative_root.parts[2] not in contracted_skill_names:
                directories[:] = []
                continue
        if len(relative_root.parts) >= 2 and relative_root.parts[:2] == (".claude", "skills"):
            # Skill trees are handled as entrypoints below.  Do not let their
            # nested helper files become unrelated instruction discoveries.
            directories[:] = []
            continue
        if _is_unmanaged_instruction_path(relative_root) and not (
            (
                relative_root.parts == (".agents", "skills")
                and contracted_skill_names
            )
            or (
                len(relative_root.parts) >= 3
                and relative_root.parts[:2] == (".agents", "skills")
                and relative_root.parts[2] in contracted_skill_names
            )
        ):
            directories[:] = []
            continue
        directories[:] = [
            name
            for name in directories
            if should_descend(relative_root / name)
        ]
        for name in files:
            if name in {"AGENTS.md", "AGENTS.override.md", "CLAUDE.md"}:
                paths.add((root_path / name).absolute())
    for claude_root in (repo / ".claude" / "agents", repo / ".claude" / "rules"):
        if claude_root.is_dir():
            for path in claude_root.rglob("*.md"):
                if path.is_file() or path.is_symlink():
                    if not _is_unmanaged_instruction_path(path.relative_to(repo)):
                        paths.add(path.absolute())
    claude_skills_root = repo / ".claude" / "skills"
    if claude_skills_root.is_dir():
        for skill in claude_skills_root.iterdir():
            if skill.is_symlink() or not skill.is_dir():
                continue
            entry = skill / "SKILL.md"
            if entry.is_file():
                paths.add(entry.absolute())
    return sorted(paths)


def _validate_claude_skill_aliases(
    repo: Path,
    allowed_skill_names: set[str],
    errors: list[str],
) -> None:
    """Validate legacy Claude skill symlinks without exempting retargets."""

    root = repo / ".claude" / "skills"
    root_exists = root.exists()
    root_symlink = root.is_symlink()
    if not root_exists and not root_symlink:
        return
    if root_symlink:
        errors.append(f"{root}: Claude skill alias root may not be a symlink")
        return
    try:
        children = sorted(root.iterdir(), key=lambda path: path.name)
    except OSError as exc:
        errors.append(f"{root}: cannot inspect Claude skill aliases: {exc}")
        return
    for alias in children:
        if alias.is_symlink():
            expected = repo / ".agents" / "skills" / alias.name
            if alias.name not in allowed_skill_names:
                errors.append(f"{alias}: Claude skill alias is not contracted or lock-listed")
                continue
            try:
                target = alias.resolve(strict=True)
                expected_target = expected.resolve(strict=True)
            except OSError as exc:
                errors.append(f"{alias}: Claude skill alias target is unavailable: {exc}")
                continue
            if target != expected_target or not expected_target.is_dir():
                errors.append(f"{alias}: Claude skill alias must target {expected}")
            continue
        if not alias.is_dir():
            errors.append(f"{alias}: Claude skill entry must be a directory or validated symlink")
            continue
        entry = alias / "SKILL.md"
        if not entry.is_file():
            errors.append(f"{alias}: regular Claude skill directory must contain SKILL.md")


def _validate_instruction_file(
    path: Path,
    repo: Path,
    policy: dict[str, Any],
    errors: list[str],
    *,
    allow_external: bool = False,
    require_governance: bool = False,
) -> None:
    if not allow_external:
        try:
            resolved = path.resolve()
        except OSError as exc:
            errors.append(f"{path}: cannot resolve instruction path: {exc}")
            return
        if _has_symlink_component(path, repo) or not _is_within(resolved, repo.resolve()):
            errors.append(f"{path}: instruction path must remain inside the repository and may not be a symlink")
            return
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"{path}: cannot read instruction file: {exc}")
        return
    if not text.strip():
        errors.append(f"{path}: instruction file is empty")
    if path.name in {"AGENTS.md", "AGENTS.override.md", "CLAUDE.md"} and path.stat().st_size > int(policy.get("max_agents_bytes", 32768)):
        errors.append(f"{path}: exceeds max_agents_bytes")
    # Root instructions establish the policy. A scoped file explicitly listed
    # by a contract is an operative override, so it must repeat the policy
    # rather than silently weakening finding, review, or cleanup rules.
    if path.parent.resolve() == repo.resolve() or require_governance:
        check_governance_binding(path, text, errors)
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
            frontmatter_match = FRONTMATTER_RE.match(text)
            if not frontmatter_match or not text[frontmatter_match.end() :].strip():
                errors.append(f"{path}: skill instruction body must be nonempty after frontmatter")
        yaml_path = path.parent / "agents" / "openai.yaml"
        if yaml_path.exists():
            if not allow_external and (_has_symlink_component(yaml_path, repo) or not _is_within(yaml_path.resolve(), repo.resolve())):
                errors.append(f"{yaml_path}: metadata path must remain inside the repository and may not be a symlink")
            else:
                check_yaml_shape(yaml_path, errors, skill_name=path.parent.name)
                if policy.get("forbid_secrets_in_instructions") and has_secret(yaml_path.read_text(encoding="utf-8")):
                    errors.append(f"{yaml_path}: possible secret/token pattern")
        else:
            errors.append(f"{path.parent}: missing agents/openai.yaml")
    check_reference_links(path, repo, errors, allow_external=allow_external)
    scan_reference_graph(path, repo, policy, errors, allow_external=allow_external)
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
        elif len(set(value)) != len(value):
            errors.append(f"{key} must not contain duplicate entries")
    globals_value = contract.get("required_global_skills", [])
    if not isinstance(globals_value, list) or not globals_value or not all(
        isinstance(item, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]*", item) for item in globals_value
    ):
        errors.append("required_global_skills must be a non-empty list of skill names")
    elif len(set(globals_value)) != len(globals_value):
        errors.append("required_global_skills must not contain duplicate entries")


def _validate_policy(policy: dict[str, Any], errors: list[str]) -> None:
    required_keys = {
        "version",
        "required_frontmatter",
        "max_agents_bytes",
        "max_skill_bytes",
        "require_skill_entrypoint",
        "reference_policy",
        "forbid_secrets_in_instructions",
        "review_rules",
    }
    unknown = sorted(set(policy) - required_keys)
    if unknown:
        errors.append(f"policy contains unknown keys: {', '.join(unknown)}")
    missing = sorted(required_keys - set(policy))
    if missing:
        errors.append(f"policy is missing required security keys: {', '.join(missing)}")
    if policy.get("version") != SUPPORTED_VERSION:
        errors.append(f"unsupported policy version: {policy.get('version')!r}")
    frontmatter = policy.get("required_frontmatter")
    if not isinstance(frontmatter, list) or not frontmatter or not all(isinstance(item, str) and item.strip() for item in frontmatter):
        errors.append("policy required_frontmatter must be a non-empty string list")
    for key in ("max_agents_bytes", "max_skill_bytes"):
        value = policy.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            errors.append(f"policy {key} must be a positive integer")
    if not isinstance(policy.get("require_skill_entrypoint"), str) or not policy.get("require_skill_entrypoint").strip():
        errors.append("policy require_skill_entrypoint must be a nonempty string")
    if not isinstance(policy.get("reference_policy"), str) or not policy.get("reference_policy").strip():
        errors.append("policy reference_policy must be a nonempty string")
    if policy.get("forbid_secrets_in_instructions") is not True:
        errors.append("policy forbid_secrets_in_instructions must remain true")
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


def _validate_policy_against_trusted(
    policy: dict[str, Any],
    trusted: dict[str, Any],
    errors: list[str],
    *,
    allow_policy_update: bool = False,
) -> None:
    """Allow reviewed policy evolution only when it cannot weaken the gate."""

    if policy.get("version") != trusted.get("version"):
        errors.append("proposed policy version differs from the trusted policy")
    trusted_frontmatter = set(trusted.get("required_frontmatter", []))
    proposed_frontmatter = set(policy.get("required_frontmatter", []))
    if trusted_frontmatter - proposed_frontmatter:
        errors.append("proposed policy removes trusted required frontmatter fields")
    for key in ("max_agents_bytes", "max_skill_bytes"):
        try:
            if int(policy.get(key)) > int(trusted.get(key)):
                errors.append(f"proposed policy increases {key} and weakens the gate")
        except (TypeError, ValueError):
            errors.append(f"proposed policy has an invalid {key}")
    if policy.get("require_skill_entrypoint") != trusted.get("require_skill_entrypoint"):
        errors.append("proposed policy changes the required skill entrypoint")
    if policy.get("reference_policy") != trusted.get("reference_policy"):
        errors.append("proposed policy changes the reference policy")
    if policy.get("forbid_secrets_in_instructions") is not True:
        errors.append("proposed policy must keep forbid_secrets_in_instructions enabled")
    trusted_rules = trusted.get("review_rules", {})
    proposed_rules = policy.get("review_rules", {})
    if not isinstance(trusted_rules, dict) or not isinstance(proposed_rules, dict):
        errors.append("proposed policy review_rules must remain a mapping")
        return
    if allow_policy_update:
        # An approved governance update may move the policy pin, but it may
        # not replace an operative clause with a marker-only paraphrase (or
        # reverse its meaning while retaining the same keywords). Require the
        # exact canonical rule text for every review rule.
        for key, expected in CANONICAL_REVIEW_RULES.items():
            if proposed_rules.get(key) != expected:
                errors.append(f"approved policy review_rules.{key} must match the canonical rule")
    else:
        for key in REVIEW_RULE_KEYS:
            if proposed_rules.get(key) != trusted_rules.get(key):
                errors.append(f"proposed policy changes trusted review_rules.{key}")


def _validate_against_trusted_contract(
    contract: dict[str, Any],
    trusted: dict[str, Any],
    errors: list[str],
    *,
    allow_config_commit_update: bool = False,
) -> None:
    """Prevent a PR from weakening the protected asset list or config pin."""

    if contract.get("asset_id") != trusted.get("asset_id"):
        errors.append("contract asset_id does not match the trusted base contract")
    if not allow_config_commit_update and contract.get("canonical_config_commit") != trusted.get("canonical_config_commit"):
        errors.append("contract canonical_config_commit differs from the trusted base contract")
    if allow_config_commit_update and not re.fullmatch(r"[0-9a-fA-F]{40}", str(contract.get("canonical_config_commit", ""))):
        errors.append("approved contract canonical_config_commit must be a full 40-character revision")
    if contract.get("policy_profile") != trusted.get("policy_profile"):
        errors.append("contract policy_profile differs from the trusted base contract")
    for key in ("required_agents", "required_skills", "required_global_skills"):
        proposed = set(contract.get(key, []))
        baseline = set(trusted.get(key, []))
        missing = sorted(baseline - proposed)
        if missing:
            errors.append(f"contract {key} removes trusted entries: {', '.join(missing)}")


def _validate_global_manifest(
    manifest_path: Path,
    manifest: dict[str, Any],
    expected_skills: list[str],
    errors: list[str],
    *,
    registry_source: Path | None = None,
    allow_config_commit_update: bool = False,
    expected_contract_commit: str | None = None,
) -> None:
    unknown = sorted(set(manifest) - GLOBAL_MANIFEST_KEYS)
    if unknown:
        errors.append(f"{manifest_path}: global manifest contains unknown keys: {', '.join(unknown)}")
    if manifest.get("version") != 1:
        errors.append(f"{manifest_path}: unsupported global manifest version {manifest.get('version')!r}")
    registry = manifest.get("registry")
    if not allow_config_commit_update and registry != GLOBAL_REGISTRY_DESCRIPTOR:
        errors.append(
            f"{manifest_path}: registry must pin {GLOBAL_REGISTRY_DESCRIPTOR['repository']}@{GLOBAL_REGISTRY_DESCRIPTOR['ref']}:{GLOBAL_REGISTRY_DESCRIPTOR['path']} with the trusted content digest"
        )
    elif isinstance(registry, dict):
        if registry.get("repository") != GLOBAL_REGISTRY_DESCRIPTOR["repository"] or registry.get("path") != GLOBAL_REGISTRY_DESCRIPTOR["path"]:
            errors.append(f"{manifest_path}: registry repository/path must remain the trusted workspace registry")
        if not re.fullmatch(r"[0-9a-f]{40}", str(registry.get("ref", ""))):
            errors.append(f"{manifest_path}: registry ref must be a full 40-character lowercase commit")
        if not re.fullmatch(r"[0-9a-f]{64}", str(registry.get("sha256", ""))):
            errors.append(f"{manifest_path}: registry sha256 must be a 64-character lowercase hex digest")
    else:
        errors.append(f"{manifest_path}: registry must be an object")
    advertised = manifest.get("skills")
    if not isinstance(advertised, list):
        errors.append(f"{manifest_path}: advertised skills do not match required_global_skills")
    elif len(set(advertised)) != len(advertised):
        errors.append(f"{manifest_path}: advertised skills must not contain duplicates")
    elif set(advertised) != set(expected_skills):
        errors.append(f"{manifest_path}: advertised skills do not match required_global_skills")
    if registry_source is None or not isinstance(registry, dict):
        return
    source_root = registry_source.resolve()
    source_path = source_root / str(registry.get("path", ""))
    try:
        source_resolved = source_path.resolve()
    except OSError as exc:
        errors.append(f"{manifest_path}: pinned registry cannot be resolved from checkout: {exc}")
        return
    if source_path.is_symlink() or not _is_within(source_resolved, source_root) or not source_resolved.is_file():
        errors.append(f"{manifest_path}: pinned registry path is missing, external, or symlinked in checkout")
        return
    try:
        source_bytes = source_resolved.read_bytes()
        source_manifest = load_json(source_resolved)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        errors.append(f"{manifest_path}: pinned registry content is invalid: {exc}")
        return
    digest = hashlib.sha256(source_bytes).hexdigest()
    if digest != registry.get("sha256"):
        errors.append(f"{manifest_path}: pinned registry content digest does not match its descriptor")
    if not isinstance(source_manifest.get("assets"), list):
        errors.append(f"{manifest_path}: pinned registry does not contain an assets array")
    source_metadata = source_manifest.get("source")
    source_revision = source_metadata.get("revision") if isinstance(source_metadata, dict) else None
    expected_revision = expected_contract_commit if allow_config_commit_update else CANONICAL_CONFIG_COMMIT
    if not isinstance(source_metadata, dict) or source_revision != expected_revision:
        errors.append(f"{manifest_path}: pinned registry source revision is not the trusted canonical configuration")
    governance = source_manifest.get("governance")
    allowlist = governance.get("global_skill_allowlist", []) if isinstance(governance, dict) else []
    source_skill_names = {
        Path(str(item)).name
        for item in allowlist
        if isinstance(item, str) and item.strip()
    }
    if isinstance(advertised, list):
        missing = sorted(set(str(item) for item in advertised) - source_skill_names)
        if missing:
            errors.append(f"{manifest_path}: pinned registry is missing advertised global skills: {', '.join(missing)}")


def validate_skill(
    path: Path,
    repo: Path,
    policy: dict[str, Any],
    errors: list[str],
    *,
    allow_external: bool = False,
) -> None:
    if not path.is_dir():
        errors.append(f"{path}: contracted skill must be a directory containing SKILL.md")
        return
    entry = path / policy.get("require_skill_entrypoint", "SKILL.md")
    if not entry.exists():
        errors.append(f"{path}: missing {policy.get('require_skill_entrypoint', 'SKILL.md')}")
        return
    _validate_instruction_file(entry, repo, policy, errors, allow_external=allow_external)
    # References are part of the skill's executable instruction surface. Scan
    # them recursively so a secret or broken link cannot hide behind SKILL.md.
    for reference in path.rglob("*"):
        if reference == entry:
            continue
        if reference.is_symlink():
            if not allow_external:
                errors.append(f"{reference}: skill tree may not contain a symlink")
            continue
        if not reference.is_file():
            continue
        if not allow_external and not _is_within(reference.resolve(), repo.resolve()):
            errors.append(f"{reference}: skill reference must remain inside the repository and may not be a symlink")
            continue
        try:
            raw = reference.read_bytes()
            if b"\0" in raw[:8192]:
                if policy.get("forbid_secrets_in_instructions") and has_secret_bytes(raw):
                    errors.append(f"{reference}: possible secret/token pattern")
                continue
            reference_text = raw.decode("utf-8")
        except OSError as exc:
            errors.append(f"{reference}: cannot read skill reference: {exc}")
            continue
        except UnicodeDecodeError:
            if policy.get("forbid_secrets_in_instructions") and has_secret_bytes(raw):
                errors.append(f"{reference}: possible secret/token pattern")
            continue
        is_reference = reference.suffix.casefold() in REFERENCE_TEXT_SUFFIXES
        if is_reference and not reference_text.strip():
            errors.append(f"{reference}: skill reference is empty")
        if is_reference and reference.suffix.casefold() == ".md" and reference.stat().st_size > int(policy.get("max_skill_bytes", 32768)):
            errors.append(f"{reference}: exceeds max_skill_bytes")
        if is_reference:
            check_reference_links(reference, repo, errors, allow_external=allow_external)
        if policy.get("forbid_secrets_in_instructions") and has_secret_bytes(raw):
            errors.append(f"{reference}: possible secret/token pattern")


def validate_locked_skill(
    path: Path,
    policy: dict[str, Any],
    errors: list[str],
    *,
    expected_hash: str | None = None,
) -> None:
    """Check lock-listed plugin bytes while allowing third-party metadata shapes."""

    if not path.is_dir():
        errors.append(f"{path}: locked skill must be a directory")
        return
    entry = path / "SKILL.md"
    if not entry.is_file():
        errors.append(f"{path}: locked skill must contain a regular SKILL.md entrypoint")
    if expected_hash:
        try:
            actual_hash = skill_tree_digest(path)
        except (OSError, ValueError) as exc:
            errors.append(f"{path}: cannot hash locked skill tree: {exc}")
        else:
            if actual_hash.casefold() != expected_hash.casefold():
                errors.append(
                    f"{path}: locked skill content hash {actual_hash} does not match skills-lock.json computedHash"
                )
    for reference in path.rglob("*"):
        if reference.is_symlink():
            errors.append(f"{reference}: locked skill tree may not contain a symlink")
            continue
        if not reference.is_file():
            continue
        try:
            raw = reference.read_bytes()
        except OSError as exc:
            errors.append(f"{reference}: cannot read locked skill content: {exc}")
            continue
        if policy.get("forbid_secrets_in_instructions") and has_locked_skill_secret_bytes(raw):
            errors.append(f"{reference}: possible secret/token pattern")


def validate_asset(
    asset: dict[str, Any],
    policy: dict[str, Any],
    *,
    registry_only: bool = False,
    expected_config_commit: str | None = None,
    trusted_contract: dict[str, Any] | None = None,
    trusted_policy: dict[str, Any] | None = None,
    allow_config_commit_update: bool = False,
    registry_source: Path | None = None,
) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    repo = Path(str(asset["root"]))
    contract = asset.get("instruction_contract") or {}
    if contract:
        _validate_contract_shape(contract, errors)
        if trusted_contract:
            _validate_against_trusted_contract(
                contract,
                trusted_contract,
                errors,
                allow_config_commit_update=allow_config_commit_update,
            )
    if trusted_policy is not None:
        _validate_policy_against_trusted(
            policy,
            trusted_policy,
            errors,
            allow_policy_update=allow_config_commit_update,
        )
    if expected_config_commit and not allow_config_commit_update and contract.get("canonical_config_commit") != expected_config_commit:
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
        locked_skills = _validate_skill_inventory(repo, skills, errors)
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
            else:
                _validate_instruction_file(
                    path,
                    repo,
                    policy,
                    errors,
                    allow_external=allow_absolute,
                    require_governance=path.parent.resolve() != repo.resolve(),
                )
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
        # Lock-listed third-party mounts are still repository-resident input.
        # Validate their current contents before treating the lock as an
        # inventory exemption; otherwise a modified plugin tree could hide
        # secrets or broken references behind its trusted name.
        for name in sorted(locked_skills):
            path = repo / ".agents" / "skills" / name
            if path.exists() or path.is_symlink():
                validate_locked_skill(path, policy, errors, expected_hash=locked_skills[name])

        contracted_skill_names = {
            Path(str(raw)).parts[2]
            for raw in skills
            if len(Path(str(raw)).parts) >= 3
            and Path(str(raw)).parts[:2] == (".agents", "skills")
        }
        _validate_claude_skill_aliases(
            repo,
            contracted_skill_names | set(locked_skills),
            errors,
        )
        discovered = _instruction_paths(
            repo,
            include_discovery=asset.get("kind") != "instruction-system",
            contracted_skill_names=contracted_skill_names,
        )
        discovered_set = set(discovered)
        for path in discovered:
            relative_parts = path.relative_to(repo).parts
            governed_entrypoint = path.name == "CLAUDE.md" or (
                len(relative_parts) >= 3
                and relative_parts[:2] in {(".claude", "agents"), (".claude", "rules")}
            ) or (
                len(relative_parts) >= 4
                and relative_parts[:2] == (".agents", "skills")
                and relative_parts[2] in contracted_skill_names
                and path.name in {"AGENTS.md", "AGENTS.override.md", "CLAUDE.md"}
            )
            _validate_instruction_file(
                path,
                repo,
                policy,
                errors,
                require_governance=governed_entrypoint,
            )
            # CLAUDE.md is an operative consumer entrypoint in repositories
            # that provide it, even when the legacy contract lists only
            # AGENTS.md. Treat it as governed automatically rather than
            # allowing a conflicting file to hide as an unlisted extra.
            if path.name == "CLAUDE.md" or (
                len(relative_parts) >= 3
                and relative_parts[:2] == (".claude", "agents")
            ) or (
                len(relative_parts) >= 3
                and relative_parts[:2] == (".claude", "rules")
            ) or (
                len(relative_parts) >= 4
                and relative_parts[:2] == (".agents", "skills")
                and relative_parts[2] in contracted_skill_names
                and path.name in {"AGENTS.md", "AGENTS.override.md", "CLAUDE.md"}
            ):
                required_paths.add(path)
        for path in sorted(discovered_set - required_paths):
            errors.append(f"{path}: instruction entrypoint is not listed in the contract")
        check_agents_claude_consistency(repo, errors)

        manifest_path = repo / ".codex" / "global-skills.json"
        globals_value = contract.get("required_global_skills", []) if contract else []
        if globals_value:
            if not manifest_path.exists():
                errors.append(f"{manifest_path}: missing required global skill manifest")
            else:
                try:
                    manifest = load_json(manifest_path)
                    _validate_global_manifest(
                        manifest_path,
                        manifest,
                        globals_value,
                        errors,
                        registry_source=registry_source,
                        allow_config_commit_update=allow_config_commit_update,
                        expected_contract_commit=str(contract.get("canonical_config_commit", "")),
                    )
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
    parser.add_argument("--trusted-policy", type=Path)
    parser.add_argument(
        "--registry-source",
        type=Path,
        help="optional trusted checkout of the pinned global registry for content verification",
    )
    parser.add_argument(
        "--allow-config-commit-update",
        action="store_true",
        help="allow a maintainer-approved canonical config pin update",
    )
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
            contract_path = args.contract
            repo_root = args.repo.resolve()
            resolved_contract = contract_path.resolve()
            if contract_path.is_symlink() or not _is_within(resolved_contract, repo_root):
                raise ValueError("--contract must be a regular file inside --repo")
            contract = load_json(resolved_contract)
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
        trusted_policy = load_json(args.trusted_policy) if args.trusted_policy else None
        if trusted_policy is not None:
            trusted_policy_errors: list[str] = []
            _validate_policy(trusted_policy, trusted_policy_errors)
            if trusted_policy_errors:
                raise ValueError("trusted policy is invalid: " + "; ".join(trusted_policy_errors))
        result = validate_asset(
            asset,
            policy,
            registry_only=args.registry_only,
            expected_config_commit=args.expected_config_commit,
            trusted_contract=trusted_contract,
            trusted_policy=trusted_policy,
            allow_config_commit_update=args.allow_config_commit_update,
            registry_source=args.registry_source,
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
