// Frames on a host socket: one type byte, a 32-bit big-endian length, then the payload.
export const FRAME = {
  data: 0, // terminal input to the host, Pi output to the terminal
  attach: 1, // { cols, rows }
  resize: 2, // { cols, rows }
  status: 3, // request: empty; reply: host status
  detached: 4, // host to terminal: { reason: 'detach' | 'takeover', session }; terminal to host: empty, to detach
  exited: 5, // { session }
  control: 6, // Pi to host: { type: 'session', session } | { type: 'detach' }; host to Pi: { type: 'attached', attached }
};

export function frame(type, payload = '') {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

export function readFrames(socket, onFrame) {
  let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 5) {
      const length = buffer.readUInt32BE(1);
      if (buffer.length < 5 + length) break;
      const type = buffer[0], body = buffer.subarray(5, 5 + length);
      buffer = buffer.subarray(5 + length);
      onFrame(type, body);
    }
  });
}

export const json = body => JSON.parse(body.toString('utf8'));
