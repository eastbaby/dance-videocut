"""Run with build/native-engine-venv-py312/bin/python tests/export-audio.py."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
ffmpeg = root / 'node_modules/ffmpeg-static/ffmpeg'
with tempfile.TemporaryDirectory(prefix='danceframe-export-audio-') as folder:
    folder = Path(folder)
    for audio in (False, True):
        source = folder / f'source-{audio}.mp4'
        output = folder / f'output-{audio}.mp4'
        command = [str(ffmpeg), '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30']
        if audio:
            command += ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100']
        command += ['-t', '0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-loglevel', 'error', str(source)]
        subprocess.run(command, check=True)
        job = {'inputPath': str(source), 'outputPath': str(output), 'static': True,
               'box': {'x': 100, 'y': 20, 'w': 80, 'h': 140}, 'aspect': '9:16'}
        result = subprocess.run([sys.executable, str(root / 'engine/export_video.py')],
                                input=json.dumps(job), capture_output=True, text=True, cwd=root, timeout=60)
        assert result.returncode == 0, result.stdout + result.stderr
        subprocess.run([str(ffmpeg), '-v', 'error', '-i', str(output), '-f', 'null', '-'], check=True)
        probe = subprocess.run([str(ffmpeg), '-hide_banner', '-i', str(output)], capture_output=True, text=True)
        assert ('Audio:' in probe.stderr) == audio, probe.stderr
        assert '1080x1920' in probe.stderr
        assert 'yuv420p' in probe.stderr
        print(f'PASS: audio={audio}, 1080x1920 H.264 yuv420p, output decodes')
