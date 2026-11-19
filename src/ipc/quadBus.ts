import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppState, QuadRole } from '../types.ts';

export const QUAD_SOCKET_PATH = path.join(
  os.tmpdir(),
  `herdr-gemini-quad-${process.env.USER || 'anon'}.sock`
);

export const QUAD_STATE_FILE = path.join(
  os.tmpdir(),
  `herdr-gemini-quad-${process.env.USER || 'anon'}.json`
);

export interface QuadMessage {
  type: 'state' | 'action' | 'ping' | 'pong';
  role?: QuadRole;
  state?: Partial<AppState>;
  action?: string;
  payload?: any;
  timestamp?: number;
}

export class QuadBusServer {
  private server: net.Server | null = null;
  private clients: Set<net.Socket> = new Set();
  private onActionCallback?: (msg: QuadMessage) => void;
  // 선행 버그 #4 수정: 80ms 비원자적 writeFileSync 경합 → 250ms 쓰로틀 + dirty 체크 + 원자적 교체
  private lastWrittenJson: string | null = null;
  private lastFileWriteMs = 0;

  constructor(onAction?: (msg: QuadMessage) => void) {
    this.onActionCallback = onAction;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // 이전 소켓 파일 정리
      if (fs.existsSync(QUAD_SOCKET_PATH)) {
        try {
          fs.unlinkSync(QUAD_SOCKET_PATH);
        } catch {
          // 무시
        }
      }

      const server = net.createServer((socket) => {
        this.clients.add(socket);
        let buffer = '';

        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          let newlineIdx = buffer.indexOf('\n');
          while (newlineIdx !== -1) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (line) {
              try {
                const msg = JSON.parse(line) as QuadMessage;
                if (this.onActionCallback) {
                  this.onActionCallback(msg);
                }
              } catch {
                // 파싱 오류 무시
              }
            }
            newlineIdx = buffer.indexOf('\n');
          }
        });

        socket.on('error', () => {
          this.clients.delete(socket);
        });

        socket.on('close', () => {
          this.clients.delete(socket);
        });
      });

      server.on('error', (err) => {
        reject(err);
      });

      server.listen(QUAD_SOCKET_PATH, () => {
        this.server = server;
        resolve();
      });
    });
  }

  broadcast(msg: QuadMessage): void {
    msg.timestamp = Date.now();
    const data = JSON.stringify(msg) + '\n';
    for (const client of this.clients) {
      try {
        client.write(data);
      } catch {
        this.clients.delete(client);
      }
    }
    // 상태 파일에도 저장하여 신규 실행 프로세스가 바로 복원할 수 있도록 함
    // 선행 버그 #4 수정: 동일 페이로드 스킵 + 250ms 쓰로틀 + tmp→rename 원자적 교체
    if (msg.type === 'state' && msg.state) {
      try {
        const serialized = JSON.stringify(msg.state);
        const now = Date.now();
        if (serialized !== this.lastWrittenJson && now - this.lastFileWriteMs >= 250) {
          const tmpPath = `${QUAD_STATE_FILE}.tmp.${process.pid}`;
          fs.writeFileSync(tmpPath, serialized, 'utf8');
          fs.renameSync(tmpPath, QUAD_STATE_FILE);
          this.lastWrittenJson = serialized;
          this.lastFileWriteMs = now;
        }
      } catch {
        // 무시
      }
    }
  }

  close(): void {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (fs.existsSync(QUAD_SOCKET_PATH)) {
      try {
        fs.unlinkSync(QUAD_SOCKET_PATH);
      } catch {
        // 무시
      }
    }
  }
}

export class QuadBusClient {
  private socket: net.Socket | null = null;
  private onMessageCallback: (msg: QuadMessage) => void;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isClosed = false;

  constructor(onMessage: (msg: QuadMessage) => void) {
    this.onMessageCallback = onMessage;
  }

  connect(): void {
    if (this.isClosed) return;

    // 만약 소켓이 없으면 로컬 상태 파일이 있는지 먼저 확인하고 초기 상태 공급
    if (!fs.existsSync(QUAD_SOCKET_PATH) && fs.existsSync(QUAD_STATE_FILE)) {
      try {
        const raw = fs.readFileSync(QUAD_STATE_FILE, 'utf8');
        const state = JSON.parse(raw);
        this.onMessageCallback({ type: 'state', state });
      } catch {
        // 무시
      }
    }

    const socket = net.createConnection(QUAD_SOCKET_PATH);
    let buffer = '';

    socket.on('connect', () => {
      this.socket = socket;
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          try {
            const msg = JSON.parse(line) as QuadMessage;
            this.onMessageCallback(msg);
          } catch {
            // 무시
          }
        }
        newlineIdx = buffer.indexOf('\n');
      }
    });

    socket.on('error', () => {
      this.scheduleReconnect();
    });

    socket.on('close', () => {
      this.socket = null;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.isClosed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1000);
  }

  send(msg: QuadMessage): void {
    if (this.socket && !this.socket.destroyed) {
      msg.timestamp = Date.now();
      try {
        this.socket.write(JSON.stringify(msg) + '\n');
      } catch {
        // 무시
      }
    }
  }

  close(): void {
    this.isClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}
