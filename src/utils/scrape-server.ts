import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import { getLogger } from './logger';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

interface WsClient {
  socket: Socket;
  send(data: string): void;
}

export class ScrapeServer {
  private server: Server;
  private clients: WsClient[] = [];
  private port: number;

  constructor(port = 0) {
    this.port = port;
    this.server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Argos Scrape Server — connect via WebSocket');
    });

    this.server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
      this.handleUpgrade(req, socket);
    });
  }

  /**
   * Broadcast a JSON message to all connected WebSocket clients.
   */
  broadcast(event: string, data: unknown): void {
    const message = JSON.stringify({ event, data, ts: Date.now() });
    for (const client of this.clients) {
      try { client.send(message); } catch { /* client disconnected */ }
    }
  }

  /**
   * Start the server. Returns the actual port if port=0 was used.
   */
  start(port?: number): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(port || this.port, () => {
        const addr = this.server.address();
        const actualPort = typeof addr === 'object' ? addr?.port : this.port;
        getLogger().info({ port: actualPort, clients: this.clients.length }, 'ScrapeServer started');
        resolve(actualPort || 0);
      });
    });
  }

  /**
   * Stop the server and close all WebSocket connections.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.clients) client.socket.destroy();
      this.clients = [];
      this.server.close(() => resolve());
      getLogger().info('ScrapeServer stopped');
    });
  }

  getPort(): number { return this.port; }
  getClientCount(): number { return this.clients.length; }

  private handleUpgrade(req: IncomingMessage, socket: Socket): void {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    const hash = require('crypto').createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + hash + '\r\n\r\n'
    );

    const client: WsClient = {
      socket,
      send: (data: string) => {
        const frame = this.encodeFrame(data);
        socket.write(frame);
      },
    };

    this.clients.push(client);
    getLogger().info({ clients: this.clients.length }, 'WebSocket client connected');

    socket.on('close', () => {
      this.clients = this.clients.filter(c => c !== client);
      getLogger().info({ clients: this.clients.length }, 'WebSocket client disconnected');
    });

    socket.on('error', () => {
      this.clients = this.clients.filter(c => c !== client);
    });
  }

  private encodeFrame(data: string): Buffer {
    const bytes = Buffer.from(data, 'utf-8');
    const len = bytes.length;
    let frame: Buffer;

    if (len < 126) {
      frame = Buffer.alloc(2 + len);
      frame[0] = 0x81; // FIN + text
      frame[1] = len;
      bytes.copy(frame, 2);
    } else if (len < 65536) {
      frame = Buffer.alloc(4 + len);
      frame[0] = 0x81;
      frame[1] = 126;
      frame.writeUInt16BE(len, 2);
      bytes.copy(frame, 4);
    } else {
      frame = Buffer.alloc(10 + len);
      frame[0] = 0x81;
      frame[1] = 127;
      frame.writeBigUInt64BE(BigInt(len), 2);
      bytes.copy(frame, 10);
    }
    return frame;
  }
}
