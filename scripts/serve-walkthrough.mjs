import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../.artifacts/walkthrough/', import.meta.url));
const files = new Map([
  ['index.html', 'text/html; charset=utf-8'],
  ['integration-replay-lab-desktop.mp4', 'video/mp4'],
  ['integration-replay-lab-mobile.mp4', 'video/mp4'],
  ['integration-replay-lab-desktop.webm', 'video/webm'],
  ['integration-replay-lab-mobile.webm', 'video/webm'],
]);
const port = Number(process.env.WALKTHROUGH_PORT ?? 8798);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port.');

createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let pathname;
  try {
    pathname = new URL(request.url, 'http://localhost').pathname;
  } catch {
    response.writeHead(400).end();
    return;
  }
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!files.has(name)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const filename = `${output}/${name}`;
    const { size } = await stat(filename);
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        return;
      }
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= size
      ) {
        response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        return;
      }
      status = 206;
    }
    response.writeHead(status, {
      'Content-Type': files.get(name),
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = createReadStream(filename, { start, end });
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  } catch {
    if (!response.headersSent) response.writeHead(404).end();
    else response.destroy();
  }
}).listen(port, '127.0.0.1', () => console.log(`Walkthrough: http://127.0.0.1:${port}`));
