"""Validate a built mascot plugin and write the CanvasTTY handoff result.

Usage: python scripts/finalize_mascot.py path/to/character.json [--install-approved]
Default: record reviewed only. --install-approved requests host installation.
--verify-only validates the same evidence without rewriting the result.
"""

import argparse
import json
import hashlib
from pathlib import Path

from qa_frames import frame_path, referenced_names
from build_sprite import load_config, resolve_clips


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_build(config_path):
    """Check the current sources and package before preview or handoff."""
    config = load_config(config_path)
    project = Path(config_path).resolve().parent
    report_path = project / 'build-report.json'
    if not report_path.is_file():
        raise ValueError('build report is missing; rebuild the plugin')
    report = json.loads(report_path.read_text(encoding='utf-8'))
    if report.get('config_sha256') != digest(Path(config_path)):
        raise ValueError('build is stale: configuration changed')
    records = report.get('frames', {})
    if set(records) != set(referenced_names(config)):
        raise ValueError('build does not cover current clips')
    for name, record in records.items():
        source = frame_path(config['frames_dir'], name)
        if source is None or source.name != record.get('source') or digest(source) != record.get('sha256'):
            raise ValueError(f'build is stale: source changed: {name}')
    plugin = Path(config['plugin_dir'])
    actual = {p.relative_to(plugin).as_posix(): digest(p) for p in plugin.rglob('*') if p.is_file()}
    if not actual or actual != report.get('files'):
        raise ValueError('build is stale: plugin files changed')
    return report


def verify_review(config_path, build, draft=False):
    config = load_config(config_path)
    review_path = config_path.parent / ('draft-review.json' if draft else 'review.json')
    if not review_path.is_file():
        raise ValueError(f'{review_path.name} is missing; review the current build with the user')
    review = json.loads(review_path.read_text(encoding='utf-8'))
    if review.get('build_id') != build['build_id'] or review.get('draft_approved' if draft else 'user_approved') is not True:
        raise ValueError('current build has not been approved by the user')
    if draft and review.get('user_approved') is not False:
        raise ValueError('draft acceptance must not claim final visual approval')
    plan_path = config_path.parent / 'character-full-plan.json'
    deferred = []
    if draft or plan_path.is_file():
        if not plan_path.is_file() or review.get('full_plan_sha256') != digest(plan_path):
            raise ValueError('preserved full plan is missing or its review hash is stale')
        plan = json.loads(plan_path.read_text(encoding='utf-8'))
        for action in plan.get('deck', []):
            phases = plan.get('required_phases', {}).get(action)
            if not isinstance(phases, list) or not phases:
                raise ValueError(f'full plan has no required phases: {action}')
            actual = {p['id'] for p in config.get('required_phases', {}).get(action, [])} if action in config['deck'] else set()
            deferred.extend(f'{action}/{p["id"]}' for p in phases if p['id'] not in actual)
        if not plan.get('deck'):
            raise ValueError('full plan has no requested actions')
        if not draft and deferred:
            raise ValueError('final delivery is missing full-plan phases: ' + ', '.join(deferred))
        if draft and review.get('deferred_phases') != deferred:
            raise ValueError('draft must list every deferred full-plan phase in plan order')
    unresolved = review.get('unresolved')
    if not isinstance(unresolved, list) or any(not isinstance(item, str) or not item.strip() for item in unresolved):
        raise ValueError('unresolved must explicitly list known concerns')
    if draft:
        limits = review.get('limitations')
        if not isinstance(limits, list) or not limits or any(not isinstance(item, str) or not item.strip() for item in limits):
            raise ValueError('draft needs explicit user-accepted limitations')
        if not set(unresolved + deferred) <= set(limits):
            raise ValueError('draft limitations must retain all unresolved concerns and deferred phases')
    for check in ('source', 'scale', 'neighbors', 'materials_contact', 'effects', 'main_loop', 'boundaries', 'browser'):
        note = review.get('checks', {}).get(check)
        if not isinstance(note, str) or not note.strip():
            raise ValueError(f'missing observed review: {check}')
        observation = review.get('observations', {}).get(check, {})
        if not isinstance(observation.get('evidence'), str) or not observation['evidence'].strip():
            raise ValueError(f'missing observation provenance: {check}')
        mode = observation.get('mode')
        if mode == 'observed_current_build':
            if observation.get('build_id') != build['build_id']:
                raise ValueError(f'observation belongs to another build: {check}')
        elif mode == 'reused_unchanged_pixels' and check in ('source', 'materials_contact', 'effects'):
            hashes = observation.get('source_sha256')
            if (not isinstance(hashes, dict) or not hashes or not observation.get('previous_build_id')
                    or any(build['frames'].get(name, {}).get('sha256') != value for name, value in hashes.items())):
                raise ValueError(f'reused pixel evidence is stale: {check}')
        elif mode == 'unverified' and draft and check in unresolved:
            continue
        else:
            raise ValueError(f'fresh current-build observation is required: {check}')
    clips = resolve_clips(config)
    requirements = config.get('required_phases', {})
    for action in config['deck']:
        phases = requirements.get(action)
        if not isinstance(phases, list) or not phases:
            raise ValueError(f'required action phases are missing: {action}')
        seen = set()
        for phase in phases:
            name = phase.get('id')
            clip = phase.get('clip', action)
            frames = phase.get('frames')
            if not isinstance(name, str) or not name.strip() or name in seen:
                raise ValueError(f'invalid or duplicate phase: {action}')
            seen.add(name)
            if clip not in (action, f'{action}:in', f'{action}:out') or not frames:
                raise ValueError(f'phase has no valid clip/frames: {action}/{name}')
            if not set(frames) <= {f for f, _ in clips.get(clip, [])}:
                raise ValueError(f'phase frames are absent from its clip: {action}/{name}')
            note = review.get('phases', {}).get(action, {}).get(name)
            if not isinstance(note, str) or not note.strip():
                raise ValueError(f'phase was not visually reviewed: {action}/{name}')
    if not draft and unresolved != []:
        raise ValueError('review must explicitly report no unresolved concerns before approval')
    for clip, sequence in clips.items():
        coverage = review.get('coverage', {}).get(clip, {})
        steps = coverage.get('steps')
        if (not isinstance(steps, list) or any(type(step) is not int for step in steps)
                or sorted(steps) != list(range(len(sequence)))
                or not isinstance(coverage.get('note'), str) or not coverage['note'].strip()):
            raise ValueError(f'every built step must be inspected and recorded: {clip}')
    for action in config['deck']:
        playback = review.get('playback', {}).get(action, {})
        if draft and 'main_loop' in unresolved and playback.get('mode') == 'unverified':
            if not isinstance(playback.get('note'), str) or not playback['note'].strip():
                raise ValueError(f'unverified draft playback needs an explicit limitation: {action}')
            continue
        if (type(playback.get('main_loops')) is not int or playback['main_loops'] < 2
                or not isinstance(playback.get('note'), str) or not playback['note'].strip()
                or any(playback.get(phase) is not True for phase in ('entrance', 'exit')
                       if f'{action}:{"in" if phase == "entrance" else "out"}' in clips)):
            raise ValueError(f'full entrance/exit and two live main loops must be observed: {action}')
    manifest_path = config_path.parent / 'continuity.json'
    continuity_path = config_path.parent / 'continuity-report.json'
    if not manifest_path.is_file() or not continuity_path.is_file():
        raise ValueError('source-to-atlas continuity evidence is missing')
    continuity = json.loads(continuity_path.read_text(encoding='utf-8'))
    manifest_hash = digest(manifest_path)
    if (continuity.get('build_id') != build['build_id']
            or continuity.get('manifest_sha256') != manifest_hash
            or review.get('continuity_manifest_sha256') != manifest_hash
            or review.get('continuity_report_sha256') != digest(continuity_path)
            or set(continuity.get('frames', {})) != {name for seq in clips.values() for name, _ in seq}):
        raise ValueError('continuity evidence/review is stale or incomplete')
    for flag in continuity.get('flags', []):
        note = review.get('continuity_decisions', {}).get(flag['id'])
        if draft and flag['id'] in unresolved:
            continue
        if not isinstance(note, str) or not note.strip():
            raise ValueError(f'continuity flag needs an observed explanation or repair: {flag["id"]}')
    return review


def main(config_file, install_approved=False, verify_only=False, draft=False):
    config_path = Path(config_file).expanduser().resolve(strict=True)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    plugin = (config_path.parent / config["plugin_dir"]).resolve()
    required = ("canvastty.plugin.json", "index.html", "player.js", "frames.js")
    missing = [name for name in required if not (plugin / name).is_file()]
    sprites = sorted(plugin.glob("sprite-*.webp")) if plugin.is_dir() else []
    if missing or not sprites:
        raise ValueError(f"incomplete plugin: missing {missing or ['sprite-*.webp']}")
    manifest = json.loads((plugin / "canvastty.plugin.json").read_text(encoding="utf-8"))
    if manifest.get("id") != config["id"]:
        raise ValueError("plugin ID differs from character.json")
    actions = [name for name in config.get("deck", []) if name in config.get("clips", {})]
    if not actions:
        raise ValueError("no completed selectable actions are configured")
    frames = (config_path.parent / config["frames_dir"]).resolve()
    report_path = frames / "qa-report.json"
    if not report_path.is_file():
        raise ValueError("frame QA is missing")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report.get("config_sha256") != digest(config_path) or report.get("missing"):
        raise ValueError("frame QA is stale; rerun it and review the frames")
    if not draft and report.get("visual_review", {}).get("status") != "approved":
        raise ValueError("full-size visual review is pending")
    records = report.get("frames") or []
    if not records or any(record.get("issues") for record in records):
        raise ValueError("frame QA has unresolved issues")
    if {record.get("name") for record in records} != set(referenced_names(load_config(config_path))):
        raise ValueError("frame QA does not cover the current clips")
    for record in records:
        source = frame_path(frames, record["name"])
        if source is None or source.name != record.get("source") or digest(source) != record.get("sha256"):
            raise ValueError(f"frame changed after review: {record['name']}")
    build = verify_build(config_path)
    review = verify_review(config_path, build, draft)
    if install_approved and review.get('installation_approved') is not True:
        raise ValueError('installation needs the user\'s explicit approval for this build')
    if verify_only:
        print(f'Verified build: {build["build_id"]}')
        return
    result = {
        "schemaVersion": 1,
        "status": "ready_for_host" if install_approved else "reviewed",
        "buildId": build['build_id'],
        "installationApproved": install_approved,
        "delivery": "draft" if draft else "final",
        "limitations": review['limitations'] if draft else [],
        "id": config["id"],
        "name": config["name"],
        "pluginDirectory": str(plugin),
        "actions": list(dict.fromkeys(actions)),
        "presentation": {"transparentCard": True, "resizable": True},
    }
    target = config_path.parent / "mascot-result.json"
    temporary = target.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(target)
    print(f"handoff result: {target}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config')
    parser.add_argument('--install-approved', action='store_true')
    parser.add_argument('--verify-only', action='store_true')
    parser.add_argument('--draft', action='store_true', help='Accept an explicitly reviewed draft without claiming final approval')
    args = parser.parse_args()
    main(args.config, args.install_approved, args.verify_only, args.draft)
