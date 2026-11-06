# jXRvis

**Talk to your AI coding agent from inside the headset.**

You are testing your WebXR app on a Quest. Something looks wrong. Hold **B**, say what it is, let go. jXRvis saves what your eyes saw, what you said and what the app was doing to a folder on your dev PC. Your agent (Claude Code, Codex, Cursor, Aider, a script) picks the take up, fixes the code, and answers in your view: *"Agent: Done: ball moved down, reload to see."* You never take the headset off.

```
 headset (WebXR page)                      dev PC
 ┌──────────────────────┐   view + voice   ┌─────────────────────────────┐
 │ hold B / Y / F, talk │ ───────────────► │ feedback/inbox/<id>/        │
 │                      │                  │   view.png  voice.webm      │  ◄── agent reads,
 │ "Agent: On it: …"    │ ◄─────────────── │   transcript.txt context.json│      fixes code,
 │ "Agent: Done: …"     │   status.txt     │   status.txt                │      writes status
 └──────────────────────┘                  └─────────────────────────────┘
```

The core is a **folder and file contract** ([SPEC.md](SPEC.md)), not a framework. Every piece around it is replaceable:

| Piece | In this repo | Swap for |
| --- | --- | --- |
| Server | Vite plugin, connect middleware, standalone HTTPS server | anything that implements the four routes in SPEC.md |
| Transcriber | none (voice only), or the local Whisper server in `tools/` | any `transcribe(audio) → text` function or HTTP endpoint |
| Headset client | framework-agnostic core + three.js adapter | Babylon.js, A-Frame, IWSDK, or a native Unity/Unreal client following SPEC.md |
| Agent bridge | `jxrvis-mcp` (MCP over stdio), `jxrvis-watch` (one line per take), or plain files | any agent that can read a folder and write a text file |

**Privacy:** views and voice stay on your dev PC. Nothing in jXRvis talks to a cloud service; the inbox writes its own `.gitignore` so takes are never committed. (Your agent may of course send what it reads to its model provider, as it does with your code.)

## Try the example

```bash
git clone https://github.com/e-mric/jxrvis.git
```

```bash
cd jxrvis && npm install && npm run example
```

Open http://localhost:5173, hold **F**, talk, let go. Tick **Synthetic voice** if the PC has no microphone: it records a tone through the same path. The take lands in `example/feedback/inbox/<id>/`. Then, from another terminal:

```bash
npx jxrvis-watch --inbox example/feedback/inbox --include-existing --once
```

To answer the take, write a status line into its folder; within 3 seconds the page shows "Agent: …":

```bash
echo "Done: ball moved down, reload to see" >> example/feedback/inbox/<id>/status.txt
```

On a Quest: `npm run example:headset` serves HTTPS on your LAN (self-signed; accept the warning once in the Quest browser), then open `https://<your-pc-ip>:5173`, press **Enter VR** and hold **B** or **Y**.

## Add it to your project

### 1. Install

Until it is on npm, install from GitHub (the `prepare` script builds it):

```bash
npm install --save-dev github:e-mric/jxrvis
```

npm builds it while fetching it from git. Recent npm versions may then warn that jxrvis has a `prepare` script "not yet covered by allowScripts"; the package is already built, so the warning can be ignored (or silenced with `npm install-scripts approve jxrvis`).

Or from a local clone, after `npm install` in the clone: `npm install --save-dev ../jxrvis`.

The three.js adapter expects `three` (r160 or later) in your project; the rest has no 3D dependency.

Add the feedback folder to your `.gitignore` (the inbox ignores itself, but fix notes live next to it):

```gitignore
feedback/
```

### 2. Server (Vite)

```ts
// vite.config.ts
import {defineConfig} from 'vite';
import {jxrvis} from 'jxrvis/vite';

export default defineConfig({
  plugins: [jxrvis({
    inbox: 'feedback/inbox',                          // default
    transcribe: 'none',                               // or 'http://127.0.0.1:8788/transcribe', or async (audio, {type}) => text
  })],
});
```

The routes join the dev server (and `vite preview`) your page already comes from, so they share its origin and its HTTPS. They are not in production builds.

Other connect-style servers (Express, connect, webpack-dev-server's `setupMiddlewares`, a plain `node:http` server) take the middleware directly:

```ts
import {feedbackInbox} from 'jxrvis/server';
app.use(feedbackInbox({root: 'feedback/inbox', transcribe: 'none'}));
```

Not on Node at all? Run the standalone server next to your dev server and proxy `/api/feedback` to it, keeping the `Host` header (see [Standalone server](#standalone-server)).

### 3. Client (three.js)

```ts
import {attachFeedback} from 'jxrvis/three';

const feedback = attachFeedback({
  renderer, scene, camera,
  agentName: 'Claude',                                  // the label shows "Claude: Done: …"
  context: () => ({summary: `level ${level}; ${menu.open ? 'menu open' : 'playing'}`, level, score}),
  hidden: () => [menu.root],                            // left out of the snapshot
  holdButtons: [{hand: 'right', button: 5}, {hand: 'left', button: 5}],  // B and Y (default)
  key: 'f',                                             // desktop hold-to-talk (default); null for none
  sound: event => sfx.play(event),                      // 'start' | 'saved' | 'status' | 'error'
  onMessage: text => console.info(text),                // the same messages, outside XR
});

renderer.setAnimationLoop((time, frame) => {
  feedback.update(clock.getDelta());                    // polls B/Y, keeps the label in view
  renderer.render(scene, camera);
});

menuButton.onClick = () => feedback.toggle();           // a menu "Feedback" button (works with hands)
```

Hold B/Y (or F): the view is taken as the button goes down, the voice records until you let go. A menu toggle takes the view 1.5 s later, so you can look back at the scene. Takes under 0.4 s are dropped; recordings stop at 90 s. All of this is in `timing`.

### 3b. Client (any engine)

The core has no 3D in it. Give it a snapshot function and somewhere to show text:

```ts
import {createFeedbackClient, bindKey} from 'jxrvis/client';

const client = createFeedbackClient({
  snapshot: () => ({image: canvas.toDataURL('image/png'), details: {xr: inXR}}),
  context: () => ({summary: 'main menu'}),
  show: (text, seconds) => myLabel.set(text, seconds),
});
bindKey(client, {key: 'f'});
// controller: client.holdDown() on press, client.release() on release; menu: client.toggle()
```

Native Unity or Unreal clients: implement the four HTTP calls and the client behaviour in [SPEC.md](SPEC.md); everything else (server, agent bridge) works unchanged.

### 4. Agent

Copy [agents/snippet.md](agents/snippet.md) into your project's `AGENTS.md` (or `CLAUDE.md`), or install [agents/skills/jxrvis/SKILL.md](agents/skills/jxrvis/SKILL.md) as a skill. It holds the live-mode rules: small fixes go in without asking, risky or ambiguous ones are asked first, status lines stay under ~70 characters, and a fix note is written at the end.

Then connect the agent to the inbox in one of three ways.

**MCP** (Claude Code, Codex, Cursor, Windsurf, Cline, any MCP client). Tools: `next_feedback` (waits for the next take; returns transcript, context, file paths and the eye view as an image), `list_feedback`, `get_feedback`, `set_status(id, text)`.

```bash
claude mcp add jxrvis -- npx jxrvis-mcp --inbox feedback/inbox
```

Other clients, in their MCP config:

```json
{"mcpServers": {"jxrvis": {"command": "npx", "args": ["jxrvis-mcp", "--inbox", "feedback/inbox"]}}}
```

Then tell the agent "watch the feedback".

**Watcher**: for agents that can follow a command's output (Claude Code's Monitor tool, a terminal multiplexer, a script):

```bash
npx jxrvis-watch --inbox feedback/inbox
```

It prints `FEEDBACK <id> [<summary>]: <transcript>` once per new take, when the transcript is in.

**Plain files**: any agent can list `feedback/inbox/`, read a take and append a line to its `status.txt`. That is the whole contract.

## Transcription

Without a transcriber, takes keep their voice file and the agent works from the view and context (or listens, if it can). For transcripts, run the local Whisper server ([tools/whisper-server.py](tools/whisper-server.py)): it uses CUDA when there is an NVIDIA GPU and the CPU otherwise, and nothing leaves the PC.

```bash
python -m venv .venv
```

```bash
.venv/Scripts/pip install -r tools/requirements-whisper.txt
```

```bash
.venv/Scripts/python tools/whisper-server.py --model turbo
```

(macOS/Linux: `.venv/bin/…`. Needs ffmpeg on PATH. For a GPU, install the CUDA build of torch first. The first start downloads the model; `turbo` is 1.6 GB.) Then set `transcribe: 'http://127.0.0.1:8788/transcribe'`. Options: `--language en` to skip detection, `--prompt "Words your app uses"` for names and jargon, `--model small` for a faster CPU.

Any function works too: `transcribe: async (audio, {type}) => myService(audio, type)`. Return `null` for "no transcript"; throw and the voice is still kept.

## Headset: HTTPS and the microphone

The browser gives a page the microphone only over `https://` or on `http://localhost`. Pick one:

- **adb reverse (USB, no certificates)**: with the Quest plugged in and developer mode on, `adb reverse tcp:5173 tcp:5173`, then open `http://localhost:5173` in the Quest browser.
- **Self-signed HTTPS on the LAN**: `@vitejs/plugin-basic-ssl` (what the example uses) and `vite --host 0.0.0.0`. Open `https://<pc-ip>:5173` and accept the warning once.
- **A trusted local certificate**: `mkcert -install && mkcert 192.168.1.20 localhost` makes certificates your PC trusts. Pass them to Vite's `server.https` or to the standalone server's `--cert/--key`. The Quest does not trust the mkcert root by default, so you still accept the warning once there.

If your dev server speaks HTTP/2 (Vite does with HTTPS), the inbox checks the origin against `:authority`; that is handled.

## Standalone server

For projects not served by a Node dev server, for native clients, or to serve a built app:

```bash
npx jxrvis-server --inbox feedback/inbox --static dist --host 0.0.0.0 --cert pc.pem --key pc-key.pem --transcribe http://127.0.0.1:8788/transcribe
```

Without `--cert/--key` it speaks plain HTTP (fine for desktop and adb reverse). To use it beside another dev server, proxy `/api/feedback` to it and keep the original `Host` header (in Vite's `server.proxy`, leave `changeOrigin` off), because the inbox only accepts requests whose `Origin` matches the host.

## Develop

```bash
npm test
```

```bash
npm run verify
```

`verify` typechecks, runs the tests, builds the package and builds the example. TypeScript sources run directly under Node (`--experimental-strip-types`); `npm run build` writes `dist/`.

## Related

- **IWSDK's AI-assisted dev tooling** ([docs](https://developers.meta.com/horizon/documentation/web/iwsdk-ai-assisted-dev-tooling)): an MCP server beside Vite that lets an agent take canvas screenshots, read console logs, reload and drive emulated headset input. It is the agent looking at the app; jXRvis is the *player* in a real headset telling the agent what they saw, and hearing back. They work well together, and jXRvis does not duplicate those screenshot or control tools.
- **Meta's in-headset playtesting feedback**: captures and voice from the headset, sent to the Developer Dashboard for people to read. No agent, no live answer in the headset.
- **talkthrough-mcp**: narrated desktop screen recordings turned into issue drafts by a local MCP server.
- **MCPFeedback, MarkLayer** and similar: annotated web screenshots as bug reports for agents.

## Status

Version 0.1, extracted from the live feedback loop of a Quest 3 mixed-reality game, where the same loop is in use. As a package it is verified on desktop: the example page saves takes end to end (view, voice, context, Whisper transcript) and follows status lines. It has not yet been run on a Quest in this packaged form; the XR code paths (eye view of the left eye, B/Y buttons, head-locked label) are ported from the game, where they run on Quest 3.
