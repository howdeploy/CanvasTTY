"""Exercise missing-frame rejection and a complete portable mascot build."""

import json
import hashlib
import subprocess
import sys
import tempfile
from urllib.request import urlopen
from urllib.error import HTTPError
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parent.parent


def run(script, config, should_pass=True, extra=()):
    result = subprocess.run(
        [sys.executable, str(ROOT / 'scripts' / script), str(config), *extra],
        text=True,
        capture_output=True,
        check=False,
    )
    if (result.returncode == 0) != should_pass:
        raise AssertionError(f'{script} returned {result.returncode}\n{result.stdout}\n{result.stderr}')
    return result


def draw_frame(path, hand_height):
    image = Image.new('RGBA', (128, 192), (0, 0, 0, 0))
    pen = ImageDraw.Draw(image)
    pen.ellipse((53, 25, 75, 47), fill=(235, 190, 180, 255))
    pen.rectangle((50, 48, 78, 125), fill=(70, 90, 175, 255))
    pen.rectangle((52, 126, 59, 164), fill=(40, 40, 60, 255))
    pen.rectangle((69, 126, 76, 164), fill=(40, 40, 60, 255))
    pen.line((77, 60, 91, hand_height), fill=(235, 190, 180, 255), width=5)
    pen.rectangle((25, 70, 38, 83), fill=(80, 120, 210, 80))
    image.save(path)


def approve_fixture(project):
    build = json.loads((project / 'build-report.json').read_text(encoding='utf-8'))
    manifest = {'limits': {'support_px': 2, 'landmark_px': 100, 'size_fraction': .1}, 'frames': {
        name: {'source_sha256': record['sha256'],
               'supports': [{'name': 'feet', 'region': [50, 150, 80, 172], 'alpha_threshold': 128, 'grounded': True}],
               'landmarks': {'face': [64, 36], 'hips': [64, 125]},
               'sizes': {'head_width': 23, 'torso_length': 78},
               'anatomy': 'Synthetic connected arm and two legs.', 'contact': 'Synthetic feet support.',
               'face': 'Synthetic static fixture; no generated character approval.'}
        for name, record in build['frames'].items() if name in build['placement']['frames']}}
    (project / 'continuity.json').write_text(json.dumps(manifest), encoding='utf-8')
    run('review_continuity.py', project / 'character.json')
    continuity = json.loads((project / 'continuity-report.json').read_text(encoding='utf-8'))
    review = {'build_id': build['build_id'], 'user_approved': True, 'installation_approved': True,
              'checks': {key: 'Synthetic fixture, no user artwork.' for key in
                         ('source', 'scale', 'neighbors', 'materials_contact', 'effects', 'main_loop', 'boundaries', 'browser')},
              'phases': {'wave': {'raise': 'Synthetic arm raised.', 'peak': 'Synthetic peak.'}},
              'coverage': {clip: {'steps': list(range(record['playback_steps'])), 'note': 'Synthetic test coverage.'}
                           for clip, record in build['clips'].items()},
              'playback': {'wave': {'main_loops': 2, 'entrance': True, 'exit': True, 'note': 'Synthetic test evidence.'}},
              'continuity_manifest_sha256': continuity['manifest_sha256'],
              'continuity_report_sha256': hashlib.sha256((project / 'continuity-report.json').read_bytes()).hexdigest(),
              'continuity_decisions': {}, 'unresolved': []}
    review['observations'] = {key: {'mode': 'observed_current_build', 'build_id': build['build_id'],
                                   'evidence': 'Synthetic test observation; no user artwork.'} for key in review['checks']}
    (project / 'review.json').write_text(json.dumps(review), encoding='utf-8')


def main():
    with tempfile.TemporaryDirectory() as temporary:
        opaque = Path(temporary) / 'opaque.png'
        Image.new('RGB', (32, 32), (255, 255, 255)).save(opaque)
        rejected = subprocess.run(
            [sys.executable, str(ROOT / 'scripts' / 'prepare_input.py'),
             '--image', str(opaque), '--project', str(Path(temporary) / 'rejected')],
            text=True, capture_output=True, check=False,
        )
        assert rejected.returncode == 0, rejected.stderr
        assert 'background removal required: True' in rejected.stdout
        jpeg = Path(temporary) / 'photo.JPEG'
        photo = Image.new('RGB', (32, 48), (35, 75, 125))
        ImageDraw.Draw(photo).rectangle((0, 0, 12, 18), fill=(220, 30, 40))
        exif = Image.Exif()
        exif[274] = 6
        photo.save(jpeg, exif=exif)
        jpeg_project = Path(temporary) / 'jpeg-project'
        normalized = subprocess.run([sys.executable, str(ROOT / 'scripts' / 'prepare_input.py'),
                                     '--image', str(jpeg), '--project', str(jpeg_project)],
                                    text=True, capture_output=True, check=False)
        assert normalized.returncode == 0, normalized.stderr
        assert (jpeg_project / 'references' / 'character.jpg').read_bytes() == jpeg.read_bytes()
        with Image.open(jpeg) as original, Image.open(jpeg_project / 'references' / 'character.png') as working:
            expected = ImageOps.exif_transpose(original).convert('RGBA')
            assert working.size == (48, 32)
            assert working.convert('RGBA').tobytes() == expected.tobytes(), 'JPEG normalization must only orient/encode decoded pixels'
        impostor = Path(temporary) / 'not-a-jpeg.jpg'
        Image.new('RGB', (32, 32)).save(impostor, format='GIF')
        invalid = subprocess.run([sys.executable, str(ROOT / 'scripts' / 'prepare_input.py'),
                                 '--image', str(impostor), '--project', str(Path(temporary) / 'invalid-input')],
                                text=True, capture_output=True, check=False)
        assert invalid.returncode != 0
        assert not (Path(temporary) / 'invalid-input').exists()
        intake = Path(temporary) / 'upload.png'
        draw_frame(intake, 100)
        project = Path(temporary) / 'project'
        prepared = subprocess.run(
            [sys.executable, str(ROOT / 'scripts' / 'prepare_input.py'),
             '--image', str(intake), '--project', str(project)],
            text=True, capture_output=True, check=False,
        )
        assert prepared.returncode == 0, prepared.stderr
        assert (project / 'references' / 'character.png').is_file()
        (project / 'references' / 'character.jpg').write_bytes(jpeg.read_bytes())
        config = json.loads((ROOT / 'examples' / 'character.example.json').read_text(encoding='utf-8'))
        config['name'] = 'Sample "Mascot"'
        config['description'] = 'A mascot with a "quoted" name.'
        config['clips']['wave'] = [['wave-01', 0.25], ['wave-02', 0.25], ['wave-03', 0.35]]
        config['deck'] = ['wave']
        config['labels']['wave'] = 'Wave'
        config['required_phases'] = {'wave': [
            {'id': 'raise', 'clip': 'wave', 'frames': ['wave-01', 'wave-02']},
            {'id': 'peak', 'clip': 'wave', 'frames': ['wave-03']},
        ]}
        config_path = project / 'character.json'
        config_path.write_text(json.dumps(config), encoding='utf-8')
        frames = project / 'frames'
        for name, hand in [('idle-01', 100), ('idle-02', 99), ('wave-01', 90), ('wave-02', 75),
                           ('to-wave', 100), ('from-wave', 100)]:
            draw_frame(frames / f'{name}.png', hand)
        with Image.open(frames / 'wave-02.png') as original:
            effect = original.copy()
        ImageDraw.Draw(effect).rectangle((30, 178, 35, 182), fill=(200, 210, 230, 4))
        effect.save(frames / 'wave-02.png')

        missing = run('qa_frames.py', config_path, should_pass=False)
        assert 'wave-03' in missing.stderr
        assert 'wave-03' in (frames / 'qa-report.json').read_text(encoding='utf-8')
        Image.new('RGBA', (100, 192), (255, 0, 0, 255)).save(frames / 'wave-03.png')
        invalid = run('qa_frames.py', config_path, should_pass=False)
        assert 'SIZE' in invalid.stderr
        draw_frame(frames / 'wave-03-fixed.png', 60)

        run('qa_frames.py', config_path)
        assert (frames / 'qa-sheet.png').is_file()
        report = json.loads((frames / 'qa-report.json').read_text(encoding='utf-8'))
        repaired = next(frame for frame in report['frames'] if frame['name'] == 'wave-03')
        assert repaired['source'] == 'wave-03-fixed.png'
        assert {'to-wave', 'from-wave'} <= {frame['name'] for frame in report['frames']}
        run('scaffold_plugin.py', config_path)
        run('build_sprite.py', config_path)
        run('build_sprite.py', config_path)
        pending = run('finalize_mascot.py', config_path, should_pass=False)
        assert 'visual review is pending' in pending.stderr
        run('qa_frames.py', config_path, extra=('--approve', 'Full-size frame, face, alpha edge, scale and motion review passed.'))
        pending = run('finalize_mascot.py', config_path, should_pass=False)
        assert 'review.json is missing' in pending.stderr
        approve_fixture(project)
        review_path = project / 'review.json'
        review = json.loads(review_path.read_text())
        del review['phases']['wave']['peak']
        review_path.write_text(json.dumps(review), encoding='utf-8')
        incomplete = run('finalize_mascot.py', config_path, should_pass=False)
        assert 'phase was not visually reviewed' in incomplete.stderr
        approve_fixture(project)
        review = json.loads(review_path.read_text())
        review['coverage']['wave']['steps'].pop()
        review_path.write_text(json.dumps(review), encoding='utf-8')
        incomplete = run('finalize_mascot.py', config_path, should_pass=False)
        assert 'every built step' in incomplete.stderr
        approve_fixture(project)
        continuity_path = project / 'continuity-report.json'
        continuity_path.write_text(continuity_path.read_text() + '\n', encoding='utf-8')
        stale = run('finalize_mascot.py', config_path, should_pass=False)
        assert 'continuity evidence/review is stale' in stale.stderr
        approve_fixture(project)
        review = json.loads(review_path.read_text())
        review['installation_approved'] = False
        review_path.write_text(json.dumps(review), encoding='utf-8')
        refused = run('finalize_mascot.py', config_path, should_pass=False, extra=('--install-approved',))
        assert 'explicit approval' in refused.stderr
        approve_fixture(project)
        run('finalize_mascot.py', config_path)
        assert json.loads((project / 'mascot-result.json').read_text())['status'] == 'reviewed'
        run('finalize_mascot.py', config_path, extra=('--install-approved',))

        # Draft consent keeps the full plan and known defects; it cannot become final approval.
        full_plan = json.loads(config_path.read_text())
        full_plan['required_phases']['wave'].append({'id': 'squat', 'clip': 'wave', 'frames': ['not-drawn']})
        full_plan_path = project / 'character-full-plan.json'
        full_plan_path.write_text(json.dumps(full_plan), encoding='utf-8')
        review = json.loads(review_path.read_text())
        review['full_plan_sha256'] = hashlib.sha256(full_plan_path.read_bytes()).hexdigest()
        review_path.write_text(json.dumps(review), encoding='utf-8')
        assert 'full-plan phases' in run('finalize_mascot.py', config_path, should_pass=False).stderr
        draft = dict(review, user_approved=False, draft_approved=True, deferred_phases=['wave/squat'],
                     unresolved=['Sharp transition.'], limitations=['wave/squat', 'Sharp transition.'])
        draft_path = project / 'draft-review.json'
        draft_path.write_text(json.dumps(draft), encoding='utf-8')
        run('finalize_mascot.py', config_path, extra=('--draft', '--install-approved'))
        result = json.loads((project / 'mascot-result.json').read_text())
        assert result['delivery'] == 'draft' and result['limitations'] == draft['limitations']
        run('finalize_mascot.py', config_path, extra=('--draft', '--verify-only', '--install-approved'))
        draft['limitations'] = ['wave/squat']
        draft_path.write_text(json.dumps(draft), encoding='utf-8')
        assert 'retain all unresolved' in run('finalize_mascot.py', config_path, should_pass=False, extra=('--draft',)).stderr
        draft['limitations'].append('Sharp transition.')
        draft['observations']['main_loop']['mode'] = 'reused_unchanged_pixels'
        draft_path.write_text(json.dumps(draft), encoding='utf-8')
        assert 'fresh current-build' in run('finalize_mascot.py', config_path, should_pass=False, extra=('--draft',)).stderr
        full_plan_path.unlink()  # Remove only this synthetic fixture's expanded draft plan.
        approve_fixture(project)
        run('finalize_mascot.py', config_path, extra=('--install-approved',))

        package = project / 'plugin'
        manifest = json.loads((package / 'canvastty.plugin.json').read_text(encoding='utf-8'))
        assert manifest['id'] == config['id']
        assert manifest['name'] == config['name']
        assert manifest['description'] == config['description']
        sprite = json.loads((package / 'frames.js').read_text(encoding='utf-8').removeprefix('window.SPRITE = ').removesuffix(';\n'))
        assert manifest['contributions'][0]['defaultSize']['width'] == max(
            128, round(manifest['contributions'][0]['defaultSize']['height'] * sprite['cell'][0] / sprite['cell'][1])
        )
        assert manifest['contributions'][0]['minSize']['width'] == 128
        assert (package / 'sprite-0.webp').is_file()
        alpha = Image.open(package / 'sprite-0.webp').getchannel('A')
        assert alpha.histogram()[40:110] != [0] * 70
        assert alpha.histogram()[4] > 0, 'soft alpha must not be thresholded away'
        index = sprite['clips']['wave'][1][0]
        sheet_index, local = divmod(index, sprite['perSheet'])
        with Image.open(package / sprite['sheets'][sheet_index]['file']) as atlas:
            x = local % sprite['cols'] * sprite['cell'][0]
            y = local // sprite['cols'] * sprite['cell'][1]
            assert atlas.getpixel((x + 60, y + 30)) == effect.getpixel((60, 30)), 'effect bounds must not move the body'
        assert 'wave' in (package / 'frames.js').read_text(encoding='utf-8')
        assert not any(path.name.startswith('idle-') for path in package.iterdir())
        handoff = json.loads((project / 'mascot-result.json').read_text(encoding='utf-8'))
        assert handoff['status'] == 'ready_for_host'
        assert handoff['actions'] == ['wave']
        assert handoff['presentation'] == {'transparentCard': True, 'resizable': True}
        build = json.loads((project / 'build-report.json').read_text(encoding='utf-8'))
        assert build['clips']['wave'] == {'unique_drawings': 3, 'playback_steps': 3, 'seconds': .85}
        assert build['build_id'] == sprite['buildId']
        run('preview_animation.py', config_path, extra=('--action', 'wave', '--height', '96'))
        assert (project / 'previews' / 'wave.webp').is_file()
        assert (project / 'previews' / 'wave-sheet.png').is_file()
        server = subprocess.Popen([sys.executable, str(ROOT / 'scripts' / 'serve_preview.py'), str(project)],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            url = json.loads(server.stdout.readline())['url']
            with urlopen(url + 'state', timeout=5) as response:
                state = json.load(response)
            assert state['project'] == project.name
            assert state['build'] == build['build_id']
            assert state['actions'][0]['id'] == 'wave'
            assert state['review']['sprite']['frameNames'][sprite['clips']['wave'][1][0]] == 'wave-02'
            assert state['review']['continuity']['frames']['wave-02']['supports']['feet']['built_y'] == 164
            assert any(item['name'] == 'character.png' for item in state['images'])
            assert any(item['name'] == 'character.jpg' for item in state['images'])
            for forbidden in ('character.json', '../review.json', 'plugin/'):
                try:
                    urlopen(url + forbidden, timeout=5)
                    raise AssertionError('private/non-file route was exposed')
                except HTTPError as error:
                    assert error.code == 404
        finally:
            server.terminate()
            server.wait(timeout=5)

        runtime = package / 'player.js'
        runtime.write_text(runtime.read_text(encoding='utf-8') + '\n// Changed fixture\n', encoding='utf-8')
        changed_package = run('finalize_mascot.py', config_path, should_pass=False)
        assert 'plugin files changed' in changed_package.stderr
        run('build_sprite.py', config_path)
        rebuilt = json.loads((project / 'build-report.json').read_text())
        assert rebuilt['build_id'] != build['build_id'], 'runtime/asset changes must invalidate old build approval'

        draw_frame(frames / 'wave-02.png', 80)
        run('qa_frames.py', config_path)
        run('qa_frames.py', config_path, extra=('--approve', 'Synthetic fixture review for changed hand; no user artwork.'))
        changed_source = run('finalize_mascot.py', config_path, should_pass=False)
        assert 'source changed' in changed_source.stderr
        run('build_sprite.py', config_path)
        approve_fixture(project)
        run('finalize_mascot.py', config_path)

        config['description'] = 'Updated fixture description.'
        config['clips']['wave'][0][1] = .3
        config_path.write_text(json.dumps(config), encoding='utf-8')
        run('qa_frames.py', config_path)
        run('qa_frames.py', config_path, extra=('--approve', 'Synthetic fixture review after timing and metadata update.'))
        changed_config = run('finalize_mascot.py', config_path, should_pass=False)
        assert 'configuration changed' in changed_config.stderr
        run('build_sprite.py', config_path)
        approve_fixture(project)
        run('finalize_mascot.py', config_path)
        assert json.loads((package / 'canvastty.plugin.json').read_text(encoding='utf-8'))['description'] == config['description']

        config['floor_y'] = 164
        config['cols'] = 100
        config['rows_per_sheet'] = 100
        config['ground_anchors'] = {'wave-02': 169}
        config_path.write_text(json.dumps(config), encoding='utf-8')
        run('build_sprite.py', config_path)
        approve_fixture(project)
        continuity = json.loads((project / 'continuity-report.json').read_text())
        assert continuity['frames']['wave-02']['supports']['feet']['built_y'] == 159
        assert continuity['frames']['wave-02']['supports']['feet']['source_y'] == 164
        assert any(flag['kind'] == 'support' for flag in continuity['flags'])
        run('qa_frames.py', config_path)
        run('qa_frames.py', config_path, extra=('--approve', 'Synthetic translated fixture.'))
        refused = run('finalize_mascot.py', config_path, should_pass=False)
        assert 'continuity flag needs' in refused.stderr
        shifted = json.loads((package / 'frames.js').read_text(encoding='utf-8').removeprefix('window.SPRITE = ').removesuffix(';\n'))
        index = shifted['clips']['wave'][1][0]
        sheet_index, local = divmod(index, shifted['perSheet'])
        with Image.open(package / shifted['sheets'][sheet_index]['file']) as atlas:
            assert max(atlas.size) <= 4096
            x = local % shifted['cols'] * shifted['cell'][0]
            y = local // shifted['cols'] * shifted['cell'][1]
            assert atlas.getpixel((x + 60, y + 25)) == (235, 190, 180, 255), 'explicit anchor translates the whole frame'
        config['ground_anchors'] = {'wave-02': 0}
        config_path.write_text(json.dumps(config), encoding='utf-8')
        clipped = run('build_sprite.py', config_path, should_pass=False)
        assert 'clips visible art' in clipped.stderr
        print('Portable mascot pipeline smoke test passed')


if __name__ == '__main__':
    main()
