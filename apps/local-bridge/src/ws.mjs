import crypto from 'node:crypto';

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Encode a UTF-8 text or control frame per RFC 6455 (server -> client frames are unmasked).
 * @param {number} opcode
 * @param {Buffer|string} payload
 * @returns {Buffer}
 */
export function encodeWsFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;

  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, data]);
}

/**
 * Minimal zero-dependency RFC 6455 WebSocket hub for Extension + Mobile Companion sync.
 */
export class WebSocketHub {
  constructor() {
    this.clients = new Set();
  }

  /**
   * Handle an HTTP upgrade request.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:net').Socket} socket
   * @param {(client: {sendJson: Function}, message: string) => void} onMessage
   */
  handleUpgrade(req, socket, onMessage) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash('sha1')
      .update(`${key}${WS_MAGIC_GUID}`)
      .digest('base64');

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n'
      ].join('\r\n')
    );

    const client = {
      socket,
      sendJson: (obj) => {
        if (socket.destroyed) return;
        socket.write(encodeWsFrame(0x1, JSON.stringify(obj)));
      }
    };

    this.clients.add(client);
    let rxBuffer = Buffer.alloc(0);
    let fragChunks = [];
    let fragOpcode = 0;

    socket.on('data', (chunk) => {
      rxBuffer = Buffer.concat([rxBuffer, chunk]);
      while (true) {
        const decoded = this.#tryDecodeFrame(rxBuffer);
        if (!decoded) break;
        if (decoded.tooLarge) {
          socket.write(encodeWsFrame(0x8));
          socket.destroy();
          return;
        }
        rxBuffer = rxBuffer.subarray(decoded.consumed);

        if (decoded.opcode === 0x8) {
          socket.write(encodeWsFrame(0x8));
          socket.end();
          return;
        }
        if (decoded.opcode === 0x9) {
          socket.write(encodeWsFrame(0xa, decoded.payload));
          continue;
        }
        if (decoded.opcode === 0xa) {
          continue;
        }

        if (decoded.opcode !== 0x0) {
          fragOpcode = decoded.opcode;
          fragChunks = [decoded.payload];
        } else {
          fragChunks.push(decoded.payload);
        }

        if (decoded.fin && fragOpcode === 0x1 && onMessage) {
          const fullText = Buffer.concat(fragChunks).toString('utf8');
          fragChunks = [];
          fragOpcode = 0;
          onMessage(client, fullText);
        } else if (decoded.fin) {
          fragChunks = [];
          fragOpcode = 0;
        }
      }
    });

    const cleanup = () => this.clients.delete(client);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  broadcast(obj) {
    const frame = encodeWsFrame(0x1, JSON.stringify(obj));
    for (const client of this.clients) {
      if (!client.socket.destroyed) {
        client.socket.write(frame);
      }
    }
  }

  closeAll() {
    for (const client of this.clients) {
      if (!client.socket.destroyed) {
        client.socket.write(encodeWsFrame(0x8));
        client.socket.destroy();
      }
    }
    this.clients.clear();
  }

  #tryDecodeFrame(buf) {
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let payloadLen = buf[1] & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (buf.length < offset + 2) return null;
      payloadLen = buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (buf.length < offset + 8) return null;
      payloadLen = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }

    if (payloadLen > 2 * 1024 * 1024) {
      return { tooLarge: true };
    }

    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + payloadLen) return null;

    const maskKey = masked ? buf.subarray(offset, offset + 4) : null;
    offset += maskLen;

    const payload = Buffer.from(buf.subarray(offset, offset + payloadLen));
    if (maskKey) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= maskKey[i % 4];
      }
    }

    return {
      fin,
      opcode,
      payload,
      consumed: offset + payloadLen
    };
  }
}
