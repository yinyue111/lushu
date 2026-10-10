// Minimal in-process SMTP server for tests: EHLO, STARTTLS, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA, QUIT.
// Implicit TLS when given { implicitTls: true }. Never relays anything; it only records what arrived.
import net from 'node:net';
import tls from 'node:tls';

/**
 * @param {{ key?: string, cert?: string, implicitTls?: boolean, silent?: boolean }} [options]
 *   silent: accept connections but never send a greeting (for timeout tests)
 */
export async function startFakeSmtp({ key, cert, implicitTls = false, silent = false } = {}) {
  /** @type {{ from: string, to: string[], data: string, auth: string | null, tls: boolean }[]} */
  const messages = [];
  const sockets = new Set();
  const handle = (/** @type {net.Socket} */ raw) => {
    sockets.add(raw);
    raw.on('close', () => sockets.delete(raw));
    raw.on('error', () => {});
    if (silent) return;
    let socket = /** @type {net.Socket} */ (raw);
    let secure = implicitTls;
    let buffer = '';
    let inData = false;
    let pendingLogin = 0;
    let loginUser = '';
    let current = { from: '', to: /** @type {string[]} */ ([]), data: '', auth: /** @type {string | null} */ (null), tls: secure };
    const reply = (line) => socket.write(`${line}\r\n`);
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push({ ...current, tls: secure });
            current = { from: '', to: [], data: '', auth: current.auth, tls: secure };
            reply('250 2.0.0 queued');
          } else current.data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          continue;
        }
        if (pendingLogin === 1) {
          loginUser = Buffer.from(line, 'base64').toString();
          pendingLogin = 2;
          reply('334 UGFzc3dvcmQ6');
          continue;
        }
        if (pendingLogin === 2) {
          current.auth = `${loginUser}:${Buffer.from(line, 'base64').toString()}`;
          pendingLogin = 0;
          reply('235 2.7.0 ok');
          continue;
        }
        const [verb, ...rest] = line.split(' ');
        const arg = rest.join(' ');
        switch (verb.toUpperCase()) {
          case 'EHLO':
          case 'HELO':
            socket.write(`250-fake.smtp\r\n${!secure && cert ? '250-STARTTLS\r\n' : ''}250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n`);
            break;
          case 'STARTTLS': {
            reply('220 2.0.0 go ahead');
            socket.removeListener('data', onData);
            const upgraded = new tls.TLSSocket(socket, { isServer: true, key, cert });
            upgraded.on('error', () => {});
            socket = upgraded;
            secure = true;
            buffer = '';
            upgraded.on('data', onData);
            break;
          }
          case 'AUTH': {
            const [mech, initial] = arg.split(' ');
            if (mech.toUpperCase() === 'PLAIN') {
              const [, user, pass] = Buffer.from(initial ?? '', 'base64')
                .toString()
                .split('\0');
              current.auth = `${user}:${pass}`;
              reply('235 2.7.0 ok');
            } else {
              pendingLogin = 1;
              reply('334 VXNlcm5hbWU6');
            }
            break;
          }
          case 'MAIL':
            current.from = arg
              .replace(/^FROM:\s*/i, '')
              .replace(/[<>]/g, '')
              .split(' ')[0];
            reply('250 2.1.0 ok');
            break;
          case 'RCPT':
            current.to.push(
              arg
                .replace(/^TO:\s*/i, '')
                .replace(/[<>]/g, '')
                .split(' ')[0]
            );
            reply('250 2.1.5 ok');
            break;
          case 'DATA':
            inData = true;
            reply('354 end with .');
            break;
          case 'RSET':
          case 'NOOP':
            reply('250 ok');
            break;
          case 'QUIT':
            reply('221 bye');
            socket.end();
            break;
          default:
            reply('502 5.5.2 not implemented');
        }
      }
    };
    socket.on('data', onData);
    reply('220 fake.smtp ESMTP');
  };
  const server = implicitTls ? tls.createServer({ key, cert }, handle) : net.createServer(handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {net.AddressInfo} */ (server.address());
  return {
    port: address.port,
    messages,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
  };
}
