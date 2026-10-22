#!/usr/bin/python3
"""Plays a short chime when the agent is about to run a shell command that will probably wait for
you to click "Allow", i.e. one your Kiro permissions don't already allow.

Run by a PreToolUse hook. It must never block the tool, so it always exits 0, plays the sound
in the background, and ignores any error. Set LS_CHIME_DRYRUN=1 to print the decision instead.

Permissions are read from ~/.kiro/settings/permissions.yaml (Kiro IDE 1.x; override the path with
KIRO_PERMISSIONS) and, for Kiro 0.x, from "kiroAgent.trustedCommands" in the user settings.json.
"""
import fnmatch
import json
import os
import re
import subprocess
import sys
import time

SOUND = "/System/Library/Sounds/Glass.aiff"
SETTINGS = os.path.expanduser("~/Library/Application Support/Kiro/User/settings.json")
PERMISSIONS = os.environ.get("KIRO_PERMISSIONS") or os.path.expanduser("~/.kiro/settings/permissions.yaml")
STAMP = "/tmp/kiro-approval-chime.stamp"
MIN_GAP_SECONDS = 8  # don't chime repeatedly for a burst of commands
SHELL_CAPABILITIES = {"all", "builtin", "shell"}


def find_command(obj):
    """Returns the first string value stored under a key named 'command' (hook payload shape varies)."""
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key == "command" and isinstance(value, str):
                return value
            found = find_command(value)
            if found:
                return found
    elif isinstance(obj, list):
        for value in obj:
            found = find_command(value)
            if found:
                return found
    return None


def unquote(s):
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "'\"":
        return s[1:-1]
    return s


def load_rules(path):
    """Reads the `rules:` list of a Kiro permissions.yaml.

    A small reader for the documented shape (capability / effect / match / exclude), including
    patterns wrapped onto continuation lines, so the hook doesn't need PyYAML.
    """
    rules, rule, list_key, item_indent = [], None, None, None
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()
    for raw in lines:
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        text = raw.strip()
        m = re.match(r"^- ([A-Za-z_]+):\s*(.*)$", text)
        if m and (rule is None or indent < item_indent):
            # "- capability: shell": a new rule
            rule = {m.group(1): unquote(m.group(2))}
            rules.append(rule)
            list_key, item_indent = None, indent + 2
            continue
        if rule is None:
            continue
        m = re.match(r"^([A-Za-z_]+):\s*(.*)$", text)
        if m and indent <= item_indent:
            key, value = m.group(1), m.group(2).strip()
            if not value:
                rule[key], list_key = [], key
            elif value.startswith("["):
                try:
                    rule[key] = [str(v) for v in json.loads(value)]
                except ValueError:
                    rule[key] = [unquote(v) for v in value.strip("[]").split(",") if v.strip()]
                list_key = None
            else:
                rule[key], list_key = unquote(value), None
            continue
        if list_key and text.startswith("- "):
            rule[list_key].append(unquote(text[2:]))
        elif list_key and rule[list_key]:
            rule[list_key][-1] = (rule[list_key][-1] + " " + text).strip()  # wrapped pattern
    return rules


def rule_matches(rule, command):
    patterns = rule.get("match")
    if isinstance(patterns, str):
        patterns = [patterns]
    excludes = rule.get("exclude") or []
    if isinstance(excludes, str):
        excludes = [excludes]
    hit = not patterns or any(fnmatch.fnmatchcase(command, p) for p in patterns)  # no match = everything
    return hit and not any(fnmatch.fnmatchcase(command, p) for p in excludes)


def allowed_by_permissions(command):
    """True when an allow rule covers every part of the command and no ask/deny rule covers any part."""
    try:
        rules = [r for r in load_rules(PERMISSIONS) if r.get("capability") in SHELL_CAPABILITIES]
    except Exception:
        return False
    parts = [p.strip() for p in re.split(r"&&|\|\||;|\|", command) if p.strip()] or [command]
    for part in parts:
        if any(r.get("effect") in ("ask", "deny") and rule_matches(r, part) for r in rules):
            return False
        if not any(r.get("effect") == "allow" and rule_matches(r, part) for r in rules):
            return False
    return True


def allowed_by_legacy_settings(command):
    try:
        with open(SETTINGS, encoding="utf-8") as f:
            patterns = json.load(f).get("kiroAgent.trustedCommands", [])
    except Exception:
        return False
    cmd = command.strip()
    return any(isinstance(p, str) and (cmd == p.strip() or fnmatch.fnmatchcase(cmd, p.strip())) for p in patterns)


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception:
        payload = {}
    command = (find_command(payload) or "").strip()
    if command and (allowed_by_permissions(command) or allowed_by_legacy_settings(command)):
        decision = "skip (trusted command)"
    elif os.path.exists(STAMP) and time.time() - os.path.getmtime(STAMP) < MIN_GAP_SECONDS:
        decision = "skip (chimed recently)"
    else:
        decision = "chime"
    if os.environ.get("LS_CHIME_DRYRUN"):
        print(decision)
        return
    if decision == "chime":
        with open(STAMP, "w") as f:
            f.write(str(time.time()))
        subprocess.Popen(["/usr/bin/afplay", SOUND], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


try:
    main()
except Exception:
    pass
sys.exit(0)
