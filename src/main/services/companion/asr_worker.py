"""Bounded G2 PCM -> installed Handy/Nemotron; temporary WAV is removed."""
import array
import json
import math
import os
import signal
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

BINARY = sys.argv[1]
MODEL = sys.argv[2]
child = None


def stop(signum, _frame):
    if child is not None and child.poll() is None:
        child.terminate()
    raise SystemExit(128 + signum)


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
pcm = sys.stdin.buffer.read(960001)
if not 6400 <= len(pcm) <= 960000 or len(pcm) % 2:
    raise SystemExit(2)
samples = array.array('h', pcm)
if sys.byteorder != 'little':
    samples.byteswap()
rms = math.sqrt(sum(x*x for x in samples) / len(samples)) / 32768
text = ''
if rms >= 0.002:
    # Handys file mode never downloads models or writes dictation history.
    # Its WAV decoder needs an ordinary pathname, not /dev/fd.
    with tempfile.TemporaryDirectory(prefix='canvastty-g2-voice-') as directory:
        path = Path(directory) / 'utterance.wav'
        with wave.open(str(path), 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(pcm)
        path.chmod(0o600)
        try:
            child = subprocess.Popen(
                [BINARY, '--transcribe-file', str(path), '--model', MODEL, '--json'],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env={**os.environ, 'HF_HUB_OFFLINE': '1', 'HF_HUB_DISABLE_TELEMETRY': '1'},
            )
            output, _errors = child.communicate(timeout=52)
            if child.returncode != 0:
                raise SystemExit(3)
            result = json.loads(output)
            text = result.get('text', '')
            if not isinstance(text, str) or len(text) > 4000:
                raise SystemExit(4)
            text = text.strip()
        finally:
            if child is not None and child.poll() is None:
                child.kill()
                child.wait(timeout=2)
print(json.dumps({'text': text, 'model': MODEL, 'engine': 'Handy'}, ensure_ascii=False))
