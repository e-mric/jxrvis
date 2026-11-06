"""jXRvis transcriber: a local Whisper HTTP server. Audio in, text out; nothing leaves this PC.

Optional. Without it, takes keep their voice file and get no transcript (transcriber "none").

Setup once (Python 3.10-3.12, ffmpeg on PATH; the first start downloads the model, 1.6 GB for turbo):
  python -m venv .venv
  .venv/Scripts/pip install -r tools/requirements-whisper.txt      (Windows; macOS/Linux: .venv/bin/pip)
For an NVIDIA GPU, install the CUDA build of torch first (https://pytorch.org/get-started/locally/).

Run:
  .venv/Scripts/python tools/whisper-server.py [--port 8788] [--model turbo] [--language en] [--prompt "..."]

Then point jXRvis at it: transcribe: 'http://127.0.0.1:8788/transcribe' (Vite plugin) or
--transcribe http://127.0.0.1:8788/transcribe (jxrvis-server).

GET /health answers {"ok": true, "model": ..., "device": ...} once the model is loaded.
POST /transcribe takes audio in any format ffmpeg reads (webm, ogg, m4a, mp3, wav) and answers {"text": "..."}.
POST /transcribe?from=12.5 transcribes only from 12.5 s on: the headset sends the recording so far every
second or two to hear "take a screenshot" while the player talks.
It uses CUDA when torch sees a GPU, the CPU otherwise (slower: a long take can need minutes).
"""
import argparse
import json
from urllib.parse import parse_qs, urlsplit
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

RATE = 16000
MAX_BYTES = 30_000_000

parser = argparse.ArgumentParser(description='Local Whisper transcription server for jXRvis.')
parser.add_argument('--host', default='127.0.0.1', help='keep 127.0.0.1 unless the dev server runs on another machine')
parser.add_argument('--port', type=int, default=8788)
parser.add_argument('--model', default='turbo', help='tiny, base, small, medium, large-v3, turbo, ...')
parser.add_argument('--language', default=None, help='force a language code (e.g. en, es); default: detect per take')
parser.add_argument('--prompt', default=None, help='words to expect: names, jargon of your app')
parser.add_argument('--weights', default=None, help='folder for model weights (default: ~/.cache/whisper)')
parser.add_argument('--device', default=None, help='cuda or cpu (default: cuda when available)')
args = parser.parse_args()

import numpy as np  # noqa: E402  (after argparse so --help works without the heavy imports)
import torch  # noqa: E402
import whisper  # noqa: E402

DEVICE = args.device or ('cuda' if torch.cuda.is_available() else 'cpu')
FP16 = DEVICE == 'cuda'  # half precision only on the GPU
model = whisper.load_model(args.model, device=DEVICE, download_root=args.weights)
lock = Lock()


def transcribe(data, start=0.0):
    # -ss after -i: decode from the beginning and drop the audio before `start` (exact, and cheap for speech).
    seek = ['-ss', f'{start:.2f}'] if start > 0 else []
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', 'pipe:0', *seek, '-f', 'f32le', '-ac', '1', '-ar', str(RATE), 'pipe:1'],
                         input=data, capture_output=True, check=True).stdout
    audio = np.frombuffer(raw, np.float32).copy()
    if audio.size == 0:
        return ''
    with lock:
        return whisper.transcribe(model, audio, fp16=FP16, language=args.language, initial_prompt=args.prompt,
                                  condition_on_previous_text=False)['text'].strip()


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip('/') in ('/health', ''):
            return self.reply(200, {'ok': True, 'model': args.model, 'device': DEVICE})
        self.reply(404, {'error': 'not found'})

    def do_POST(self):
        url = urlsplit(self.path)
        if url.path.rstrip('/') != '/transcribe':
            return self.reply(404, {'error': 'POST /transcribe'})
        try:
            length = int(self.headers['content-length'])
            if length > MAX_BYTES:
                return self.reply(413, {'error': 'too large'})
            start = max(0.0, float(parse_qs(url.query).get('from', ['0'])[0]))
            self.reply(200, {'text': transcribe(self.rfile.read(length), start)})
        except subprocess.CalledProcessError as error:
            self.reply(400, {'error': 'ffmpeg could not read the audio: ' + error.stderr.decode(errors='replace')[:160]})
        except (KeyError, TypeError, ValueError) as error:
            self.reply(400, {'error': str(error)[:200]})

    def log_message(self, *_):
        pass


print(f'Whisper {args.model} ready on http://{args.host}:{args.port}/transcribe ({DEVICE})', flush=True)
ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
