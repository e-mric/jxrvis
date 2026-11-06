# jXRvis — file and HTTP contract

Version 1. This document is the contract. Every part of this repo (server, transcriber, headset client, agent bridge) is one replaceable implementation of it. A Unity or Unreal client, a Python server or a different AI agent only has to follow this page to join the loop.

The loop:

1. In the headset, the player starts a take. The client saves what the player sees (the **view**) and what the app is doing (the **context**), then records the player's **voice**.
2. The dev PC stores the take as one folder in the **inbox** and, if a transcriber is configured, writes the **transcript**.
3. An AI agent on the PC notices the new folder, reads it, works on it and writes **status** lines into it.
4. The headset follows the take's status and shows each new line to the player, who keeps the headset on.

Everything stays on the dev PC. Views and voice are personal data; nothing in this contract sends them anywhere else.

## Inbox folder

The inbox is one folder on the dev PC (default `feedback/inbox` in the project). Each take is one sub-folder named by its **id**:

```
feedback/inbox/
  .gitignore                    "*": written by the server so takes are never committed
  2026-11-03_18-42-07/
    view.png                    the player's eye view as the take started (or view.jpg)
    view-2.png, view-3.png …    more views taken during the take ("take a screenshot", or a button)
    views.json                  when and why each extra view was taken; only with extra views
    context.json                what the app was doing; see below
    voice.webm                  the recording (or .ogg .m4a .mp3 .wav)
    transcript.txt              the transcript; absent when there is no transcriber or it failed
    status.txt                  written by the agent; absent until the agent starts
```

Anything else in the inbox (files, folders whose name is not an id) is ignored by every part of the loop. Agents may add their own files to a take folder (for example notes); clients and servers ignore them.

### Id

`YYYY-MM-DD_HH-MM-SS`, the server's local time when the view arrived, zero-padded. When that folder already exists, `-2`, `-3`, … is appended: `2026-11-03_18-42-07-2`.

Regex: `^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d(-\d+)?$`. Ids sort in time order as strings, except that suffixed ids sort after their base id. Every route and tool that takes an id must reject anything that does not match, so an id can never name a path outside the inbox.

### Files

| File | Written by | When | Content |
| --- | --- | --- | --- |
| `view.png` / `view.jpg` | server | first request of the take | The decoded image. The client chooses the moment: as a held button goes down, or a little after a menu tap so the player can look back at the scene. UI that belongs to the loop itself (the status label, the menu that started the take) should be left out. |
| `view-<n>.png` / `.jpg` | server | after the first view, before the voice | Extra views the player asked for during the take, numbered from 2 in the order they were taken. Same rules as the first view. |
| `views.json` | server | with each extra view | A JSON array, one entry per view including the first: `{"file":"view-2.png","seconds":4.2,"trigger":"voice"}`. `seconds` is the time since the recording started; `trigger` is `"start"` (the first view), `"voice"` (the player said "take a screenshot") or `"button"`. Entries may carry `head` like the context. |
| `context.json` | server | with the view | A JSON object, pretty-printed, newline at the end. |
| `voice.<ext>` | server | second request | The audio exactly as uploaded. `ext` comes from the Content-Type: `audio/webm` → `webm`, `audio/ogg` → `ogg`, `audio/mp4` → `m4a`, `audio/mpeg` → `mp3`, `audio/wav` or `audio/x-wav` → `wav`. Kept even when transcription fails. |
| `transcript.txt` | server (transcriber) | after the voice | Plain UTF-8 text, one trailing newline. Present only when a transcriber produced text. An empty transcript is written as an empty line. |
| `status.txt` | agent | while working on the take | Status lines; see below. |

A take is **complete** when it has a voice file. A take whose voice never arrives (the client crashed, the take was too short) stays as a view and context only; agents should treat it as a snapshot without words.

### context.json

The server adds `savedAt` and `transcriber`. Clients should send the other fields when they know them; the host app's own fields go under `app`.

| Field | Type | Meaning |
| --- | --- | --- |
| `savedAt` | string | Added by the server: ISO 8601 time the view arrived. |
| `transcriber` | string | Added by the server: `"none"` when no transcript will come, so agents need not wait for one; otherwise the transcriber's name. |
| `summary` | string | One short phrase saying what the app was showing (for example `"menu: settings; level 3"`). The watcher prints it next to the transcript. |
| `seconds` | number | Length of the recording. |
| `xr` | boolean | Whether an immersive session was running. |
| `head` | `{position:[x,y,z], looking:[x,y,z]}` | World-space head position and view direction, metres. |
| `url` | string | The page (WebXR) or scene (native). |
| `userAgent` | string | Browser or engine/device. |
| `recentErrors` | string[] | The last console errors in the app, newest last. |
| `app` | object | Whatever the host app supplies (mode, level, selection, …). |
| `replyTo` | string | Set when the take answers an agent's question: the id of the take whose current status was that `Question`. See [Replies](#replies). |
| `question` | string | With `replyTo`: the `Question: …` line being answered. |

## Status lines

The agent tells the player what it is doing by writing lines to `status.txt`. Each line starts with one of four prefixes:

| Prefix | Meaning | Ends the take? |
| --- | --- | --- |
| `On it: …` | Started; says what the agent understood. | no |
| `Question: …` | The take is unclear or the fix is risky; the agent asks (and asks in its own chat too). | no |
| `Done: …` | Fixed and checked; usually ends with "reload to see". | yes |
| `Skipped: …` | Will not act on it; says why. | yes |

Rules:

- The **current status** is the last non-empty line of the file. Agents may overwrite the file with one line or append lines (appending keeps a history for the fix note); both are valid.
- Keep a line under about 70 characters. The headset label shows two short lines and cuts the rest.
- Write the line in one write call (write a temporary file and rename, or a single `write`), so a reader never sees half a line.
- Lines with another prefix are allowed but clients only stop following on `Done` and `Skipped`. (This repo's MCP tool only writes the four.)

## Replies

When a take's current status is a `Question: …`, the player answers by recording another take. The client marks that take with `replyTo` (the asking take's id) and `question` in its context. The reply is an ordinary take folder; only its context says what it answers.

- The agent continues on the **asking** take: it writes the next status (`On it`, `Done`, another `Question`) to the asking take's `status.txt`, because that is the take the headset follows.
- The reply take needs no visible status. The agent marks it handled with `Done: answer to <id>` so it does not show as pending; the headset does not follow reply takes.
- A client marks at most one take as a reply per question, and stops treating new takes as replies once the asking take gets a status that is not a `Question`.

## When a take is ready for an agent

A folder appears as soon as the view arrives, and the voice and transcript follow seconds or minutes later. An agent watching the inbox should start on a take when:

1. `transcript.txt` exists; or
2. a voice file exists and `context.json` says `"transcriber": "none"`; or
3. a voice file has existed for a while (default 60 s) without a transcript: transcription failed or is slow, so work from the voice, view and context; or
4. the folder has had no voice for that long: the take was cut short, so only the view and context exist.

Takes that were already in the inbox when the agent started watching are left alone unless the agent is asked to catch up; then only those without a `status.txt`.

## HTTP routes

Served by the dev server the headset page comes from (same origin), under a base path, default `/api/feedback`. All replies are JSON with `Cache-Control: no-store`.

| Method and path | Request | Reply |
| --- | --- | --- |
| `GET {base}/health` | — | `200 {"ok":true,"transcriber":"none"\|"<name>","speech":"none"\|"<name>","listen":true\|false}` |
| `POST {base}` | `Content-Type: application/json`, body `{"image":"data:image/png;base64,…","context":{…}}`. `image` must be a PNG or JPEG data URL. Up to 16 MB. | `200 {"id":"…"}`. The take folder now holds the view and context. |
| `POST {base}/{id}/view` | `Content-Type: application/json`, body `{"image":"data:image/png;base64,…","seconds":4.2,"trigger":"voice"\|"button","head":{…}}`. Only before the voice arrives. | `200 {"id":"…","file":"view-2.png"}`. `409` once the take has its voice. |
| `POST {base}/listen?from=<s>` | Optional. The recording so far, raw audio as for the voice. `from`: seconds into it where to start listening (default 0). | `200 {"text":"…"}`: the transcript of the audio from `from` to the end. Clients poll it during a recording to hear spoken commands ("take a screenshot") while the player talks. `404` when the transcriber cannot listen (`"listen":false` in health). Nothing is stored. |
| `POST {base}/{id}/voice` | Body is the raw audio, `Content-Type` one of the audio types above (parameters such as `;codecs=opus` are allowed). Up to 30 MB. | `200 {"id":"…","transcript":"…"}`, or `200 {"id":"…","transcript":null}` with no transcriber, or `200 {"id":"…","transcript":null,"error":"…"}` when transcription failed (the voice is kept). |
| `GET {base}/{id}/status` | — | `200 {"status":"On it: …"}` (the current status) or `200 {"status":null}` before the agent writes one. |
| `POST {base}/speech` | Optional. `Content-Type: application/json`, body `{"text":"…"}`, up to 1000 characters. | `200` with the text spoken as audio (`audio/wav`, `audio/mpeg`, `audio/ogg` or `audio/webm`), for clients that cannot synthesise speech themselves. `404` when the server has no speech engine (`"speech":"none"` in health). |

Errors: `400 {"error":"…"}` for a bad body or unsupported audio type, `403` for a foreign origin, `404` for an unknown or malformed id or route, `413` for a body over the limit. Any path under the base that is not listed answers 404; paths outside the base are left to the rest of the server.

The view goes first, as its own request, so the id and the snapshot match the moment the take started, and so a long recording does not delay it. The voice follows when the take stops.

### Origin rule

The headset page and the inbox are on the same origin, so browsers send a matching `Origin` (or none). A request with an `Origin` header is refused with `403` unless the origin's `host` (hostname and port) equals the request's host. The request's host is the `Host` header, or, over HTTP/2 (which HTTPS dev servers usually speak), the `:authority` pseudo-header. Requests without `Origin` (curl, native clients, same-origin GETs) are let in. This keeps other web pages the player visits from writing into the inbox; it is not authentication. Serve the inbox on a trusted local network only.

### Secure context

Browsers give a page the microphone only in a secure context: `https://`, or `http://localhost`. On a standalone headset this means either HTTPS on the dev PC's LAN address, or `adb reverse tcp:<port> tcp:<port>` over USB so the headset can open `http://localhost:<port>`. See the README.

## Client behaviour

Not part of the wire contract, but every client should behave alike so players can switch projects without relearning:

- **Hold to talk**: a button (Quest: B or Y; desktop: F) starts on press and stops on release. The view is taken as the button goes down.
- **Toggle**: a menu button starts and stops. The view is taken about 1.5 s after the start so the player can look back from the menu.
- Takes shorter than 0.4 s are dropped. A recording stops by itself after 90 s.
- A label low in the player's view (head-locked, about 0.7 m ahead and 0.2 m down) says what is happening: recording, saving, the transcript, then each new status as `<Agent>: <status>`.
- After saving, poll `GET {base}/{id}/status` every 3 s for up to 20 minutes, until the status starts with `Done` or `Skipped`.
- If `GET {base}/health` fails, say that feedback needs the dev server, and do nothing else.
- **Spoken status**: `Question`, `Done` and `Skipped` lines are also read aloud (the player's eyes are busy), with the prefix spoken as a word ("Done. Ball moved down…"); `On it` gets a short sound only. A question ends with a hint on how to answer ("Hold the talk button to answer."). Clients use the server's `POST {base}/speech` when health reports a speech engine, else the platform's own text-to-speech, else stay silent. Players can turn speech off.
- **Replies**: while a followed take's current status is a `Question`, the next take is recorded as a reply (`replyTo` and `question` in its context, label "Answering…"). It is not followed itself; the client keeps following the asking take.
- **More views**: during a recording, the player can take more views. A button (Quest: A or X while recording; desktop: P) takes one at once. Saying "take a screenshot" takes one when the server can listen: the client sends the recording so far to `POST {base}/listen` about every 1.5 s, from just before where it last listened, and takes a view when the phrase shows up in the text. That view comes about a second after the words, so the player keeps looking. The label confirms each one ("Screenshot 2"). Extra views are uploaded after the first view and before the voice.
