import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { ConnectorError, validateEndpoint, listTargets, isBossUrl, chooseBossTarget, CdpSession } from '../src/cdp.mjs';

const code = expected => error => error instanceof ConnectorError && error.code === expected;
const boss = { id: 'one', type: 'page', url: 'https://www.zhipin.com/web/user/' };

async function localServer(t, handler) {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { server, endpoint: `http://127.0.0.1:${server.address().port}` };
}

// Small loopback-only fake CDP server; no browser or external service is contacted.
async function fakeCdp(t, onCommand, { stallHandshake = false } = {}) {
  const { server, endpoint } = await localServer(t);
  server.on('upgrade', (request, socket, head) => {
    if (stallHandshake) return;
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = head;
    const reply = object => {
      const payload = Buffer.from(JSON.stringify(object));
      assert.ok(payload.length < 126, 'Fake response should fit a short frame');
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    };
    const consume = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        if (length === 127) throw new Error('Unexpected large test frame');
        const masked = !!(buffer[1] & 0x80);
        if (buffer.length < offset + (masked ? 4 : 0) + length) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : null;
        offset += masked ? 4 : 0;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        buffer = buffer.subarray(offset + length);
        if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode === 1) onCommand(JSON.parse(payload.toString()), reply, socket);
      }
    };
    socket.on('data', consume);
    if (head.length) consume(Buffer.alloc(0));
  });
  return { endpoint, wsUrl: endpoint.replace('http:', 'ws:') + '/devtools/page/test' };
}

test('endpoint validation accepts only explicit canonical loopback HTTP endpoints', () => {
  assert.equal(validateEndpoint('http://127.0.0.1:19223/').port, '19223');
  assert.equal(validateEndpoint('http://127.0.0.1:80').hostname, '127.0.0.1');
  for (const input of ['http://127.0.0.1', 'http://localhost:19223', 'http://127.1:19223', 'http://2130706433:19223',
    'http://0.0.0.0:19223', 'https://127.0.0.1:19223', 'http://127.0.0.1:0', 'http://127.0.0.1:65536',
    'http://127.0.0.1:19223/json', 'http://127.0.0.1:19223?x=1', 'http://127.0.0.1:19223#x',
    'http://name@127.0.0.1:19223', undefined]) {
    assert.throws(() => validateEndpoint(input), code('INVALID_ENDPOINT'));
  }
});

test('website scope rejects lookalikes, credentials, alternate ports and non-HTTPS', () => {
  assert.equal(isBossUrl('https://www.zhipin.com/web/chat?x=1'), true);
  assert.equal(isBossUrl('https://www.zhipin.com:443/'), true);
  for (const input of ['http://www.zhipin.com/', 'https://www.zhipin.com.evil.example/', 'https://zhipin.com/',
    'https://www.zhipin.com:444/', 'https://user@www.zhipin.com/', 'https://@www.zhipin.com/',
    'https://www.zhipin.com@evil.example/', '', undefined]) {
    assert.equal(isBossUrl(input), false, String(input));
  }
});

test('target selection does not silently choose between pages or accept stale foreign targets', () => {
  assert.equal(chooseBossTarget([boss]), boss);
  assert.throws(() => chooseBossTarget([]), code('NO_BOSS_TARGET'));
  assert.throws(() => chooseBossTarget([boss, { ...boss, id: 'two' }]), code('AMBIGUOUS_TARGET'));
  assert.equal(chooseBossTarget([boss, { ...boss, id: 'two' }], 'one'), boss);
  assert.throws(() => chooseBossTarget([{ ...boss, url: 'https://example.org/' }], 'one'), code('TARGET_NOT_ALLOWED'));
  assert.throws(() => chooseBossTarget([{ ...boss, type: 'iframe' }]), code('NO_BOSS_TARGET'));
  assert.throws(() => chooseBossTarget([boss], ''), code('INVALID_TARGET_ID'));
});

test('WebSocket validation binds the page target to the same loopback endpoint', () => {
  const options = { endpoint: 'http://127.0.0.1:19223' };
  const valid = new CdpSession('ws://127.0.0.1:19223/devtools/page/abc-123', options);
  valid.close();
  for (const input of ['ws://127.0.0.1:19222/devtools/page/abc', 'ws://localhost:19223/devtools/page/abc',
    'ws://127.0.0.1:19223/devtools/browser/abc', 'ws://evil.example:19223/devtools/page/abc',
    'ws://127.0.0.1:19223/devtools/page/abc?token=x', 'ws://user@127.0.0.1:19223/devtools/page/abc']) {
    assert.throws(() => new CdpSession(input, options), code('INVALID_WEBSOCKET'));
  }
  assert.throws(() => new CdpSession('ws://127.0.0.1:19223/devtools/page/abc'), code('INVALID_ENDPOINT'));
});

test('listTargets fetches the expected path and rejects invalid list shapes', async t => {
  let body = [boss];
  const { endpoint } = await localServer(t, (request, response) => {
    assert.equal(request.url, '/json/list');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
  });
  assert.deepEqual(await listTargets(endpoint), [boss]);
  for (const invalid of [{ targets: [] }, [null], [{ id: 'x', type: 'page' }]]) {
    body = invalid;
    await assert.rejects(listTargets(endpoint), code('INVALID_TARGET_LIST'));
  }
});

test('listTargets never follows a redirect', async t => {
  let redirected = 0;
  const { endpoint } = await localServer(t, (request, response) => {
    if (request.url === '/other') { redirected++; response.end('[]'); return; }
    response.writeHead(302, { location: '/other' }).end();
  });
  await assert.rejects(listTargets(endpoint), code('CDP_UNAVAILABLE'));
  assert.equal(redirected, 0);
});

test('listTargets enforces its deadline', async t => {
  const { endpoint } = await localServer(t, () => {});
  await assert.rejects(listTargets(endpoint, { timeoutMs: 50 }), code('CDP_UNAVAILABLE'));
});

test('concurrent replies are routed by ID, including out-of-order results and events', async t => {
  const commands = [];
  const options = await fakeCdp(t, (command, reply) => {
    commands.push(command);
    if (commands.length === 2) {
      reply({ method: 'Page.event', params: {} });
      reply({ id: commands[1].id, result: { value: 'second' } });
      reply({ id: commands[0].id, result: { value: 'first' } });
    }
  });
  const session = new CdpSession(options.wsUrl, { endpoint: options.endpoint, timeoutMs: 1000 });
  t.after(() => session.close());
  await Promise.all([session.connect(), session.connect()]);
  assert.deepEqual(await Promise.all([session.send('Runtime.evaluate', { expression: '1' }), session.send('Runtime.evaluate', { expression: '2' })]),
    [{ value: 'first' }, { value: 'second' }]);
});

test('command timeout does not consume a later command reply', async t => {
  const options = await fakeCdp(t, (command, reply) => {
    if (command.params.answer) reply({ id: command.id, result: { ok: true } });
  });
  const session = new CdpSession(options.wsUrl, { endpoint: options.endpoint, timeoutMs: 100 });
  t.after(() => session.close());
  await session.connect();
  await assert.rejects(session.send('Runtime.evaluate'), code('CDP_TIMEOUT'));
  assert.deepEqual(await session.send('Runtime.evaluate', { answer: true }), { ok: true });
});

test('close immediately rejects pending commands and prevents session reuse', async t => {
  const options = await fakeCdp(t, () => {});
  const session = new CdpSession(options.wsUrl, { endpoint: options.endpoint, timeoutMs: 1000 });
  await session.connect();
  const rejected = assert.rejects(session.send('Runtime.evaluate'), code('CDP_CLOSED'));
  session.close();
  await rejected;
  session.close();
  await assert.rejects(session.connect(), code('CDP_CLOSED'));
  await assert.rejects(session.send('Runtime.evaluate'), code('CDP_CLOSED'));
});

test('a dropped connection rejects all outstanding commands', async t => {
  const options = await fakeCdp(t, (_command, _reply, socket) => socket.destroy());
  const session = new CdpSession(options.wsUrl, { endpoint: options.endpoint, timeoutMs: 1000 });
  t.after(() => session.close());
  await session.connect();
  const results = await Promise.allSettled([session.send('Runtime.evaluate'), session.send('Page.getFrameTree')]);
  assert.ok(results.every(result => result.status === 'rejected'
    && ['CDP_CLOSED', 'CDP_CONNECTION_ERROR'].includes(result.reason.code)));
});

test('a stalled WebSocket handshake is bounded by the connection timeout', async t => {
  const options = await fakeCdp(t, () => {}, { stallHandshake: true });
  const session = new CdpSession(options.wsUrl, { endpoint: options.endpoint, timeoutMs: 50 });
  await assert.rejects(session.connect(), code('CDP_CONNECT_TIMEOUT'));
  session.close();
});

test('close during a pending handshake rejects the connect promise', async t => {
  const options = await fakeCdp(t, () => {}, { stallHandshake: true });
  const session = new CdpSession(options.wsUrl, { endpoint: options.endpoint, timeoutMs: 1000 });
  const rejected = assert.rejects(session.connect(), code('CDP_CLOSED'));
  session.close();
  await rejected;
});

test('browser command errors do not close an otherwise working session', async t => {
  const options = await fakeCdp(t, (command, reply) => {
    reply(command.params.fail ? { id: command.id, error: { code: -32601, message: 'No such method' } }
      : { id: command.id, result: { ok: true } });
  });
  const session = new CdpSession(options.wsUrl, { endpoint: options.endpoint, timeoutMs: 1000 });
  t.after(() => session.close());
  await session.connect();
  await assert.rejects(session.send('Page.missing', { fail: true }), code('CDP_COMMAND_FAILED'));
  assert.deepEqual(await session.send('Page.getFrameTree'), { ok: true });
});
