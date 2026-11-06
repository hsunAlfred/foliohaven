import { expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { open, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { MediaService } from '../../server/src/media/index.js';
import { sandbox, start, token } from '../fixtures/http/environment.mjs';

it('關閉的HTTP回應仍會清理尚未開始pipe的媒體FileHandle與串流', async () => {
  const root = await sandbox();
  const running = await start(root);
  const path = join(root, 'stream-lifecycle.webp');
  const bytes = Buffer.from('isolated media transport fixture');
  await writeFile(path, bytes);
  const handle = await open(path, 'r');
  const stream = handle.createReadStream({ autoClose: true });
  let entered: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi
    .spyOn(MediaService.prototype, 'openVariant')
    .mockImplementation(async (id, variant) => {
      entered();
      await gate;
      return {
        stream,
        output: {
          publicPath: `/media/${id}/${variant}`,
          mimeType: 'image/webp',
          width: 1,
          height: 1,
          byteSize: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
        status: 200,
        headers: {
          'Content-Type': 'image/webp',
          'Content-Length': '32',
          'Cache-Control': 'no-store',
        },
      };
    });
  const endpoint = new URL(running.url);
  const socket = connect(Number(endpoint.port), '127.0.0.1');
  socket.on('error', () => undefined);
  try {
    await once(socket, 'connect');
    socket.write(
      `GET /api/v1/media/files/${randomUUID()}/image.webp HTTP/1.1\r\nHost: 127.0.0.1\r\nx-alfred-process-token: ${token}\r\nConnection: close\r\n\r\n`,
    );
    await opened;
    expect(stream.destroyed).toBe(false);
    const closed = once(socket, 'close');
    // A TCP half-close waits for the server's close acknowledgement. The HTTP
    // response is therefore already destroyed when openVariant is released.
    socket.end();
    await closed;
    release();
    // Closing awaits all dispatch tasks, so cleanup cannot pass merely because
    // a destroy request was scheduled or because GC eventually closed the fd.
    await running.service.close();
    expect(stream.destroyed).toBe(true);
    expect(stream.closed).toBe(true);
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
  } finally {
    release();
    socket.destroy();
    stream.destroy();
    await finished(stream, { cleanup: true }).catch(() => undefined);
    await handle.close();
    await running.service.close();
    spy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
