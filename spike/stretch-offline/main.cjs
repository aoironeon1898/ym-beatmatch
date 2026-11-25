// Phase 0 spike: run signalsmith-stretch in a hidden Electron window (OfflineAudioContext)
// and print timing measurements as JSON. Usage: npx electron spike/stretch-offline/main.cjs
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript' };

const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

app.whenReady().then(() => {
  server.listen(0, '127.0.0.1', async () => {
    const { port } = server.address();
    const win = new BrowserWindow({ show: false });
    win.webContents.on('console-message', (event) => {
      const msg = event.message ?? '';
      if (msg.startsWith('RESULT ')) {
        console.log(msg.slice(7));
        app.quit();
      } else {
        console.log('[page]', msg);
      }
    });
    setTimeout(() => {
      console.log('TIMEOUT');
      app.quit();
    }, 60000);
    const page = process.env.PAGE ?? 'index.html';
    await win.loadURL(`http://127.0.0.1:${port}/spike/stretch-offline/${page}`);
  });
});
