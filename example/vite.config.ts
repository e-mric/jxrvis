// The example page: three.js + WebXR + jXRvis, served by Vite with the jXRvis plugin.
//   npm run example                  desktop, http://localhost:5173
//   npm run example:headset          HTTPS on the LAN, for a Quest (self-signed certificate)
// In your own project, import from 'jxrvis/vite' and 'jxrvis/three' instead of ../src.
import basicSsl from '@vitejs/plugin-basic-ssl';
import {resolve} from 'node:path';
import {defineConfig} from 'vite';
import {jxrvis} from '../src/server/vite.ts';

export default defineConfig(({mode})=>({
  plugins:[
    // Takes land in example/feedback/inbox (gitignored). JXRVIS_TRANSCRIBE=http://127.0.0.1:8788/transcribe
    // uses tools/whisper-server.py; without it the takes are voice only.
    jxrvis({transcribe:process.env.JXRVIS_TRANSCRIBE??'none'}),
    ...(mode==='headset'?[basicSsl()]:[]),
  ],
  resolve:{alias:{'jxrvis/three':resolve(import.meta.dirname,'../src/client/three.ts')}},
  server:{port:5173},
  build:{chunkSizeWarningLimit:1000},
}));
