import type { Readable, Writable } from "node:stream";

/**
 * Framing-safe NDJSON RPC transport over stdio (used between `SshWorkspaceBackend`
 * on the local laptop and `ide2 daemon --stdio` on a remote SSH host).
 *
 * Pre-handshake lines (e.g. `.bashrc` echo, MOTD banners) are safely ignored by the
 * client until `DAEMON_HANDSHAKE_PREFIX` is received on its own line.
 */
export const DAEMON_HANDSHAKE_PREFIX = "@@IDE2_DAEMON_V1@@";

export interface DaemonHandshakePayload {
  version: string;
  protocolVersion: 1;
  pid: number;
  platform: NodeJS.Platform;
  repoName: string;
  repoCommonDir: string;
}

export type StdioRpcFrame =
  | {
      kind: "req";
      id: string;
      method: string;
      params?: unknown;
    }
  | {
      kind: "res";
      id: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    }
  | {
      kind: "evt";
      event: unknown;
    };

export class StdioRpcPeer {
  private buffer = "";
  private nextId = 1;
  private handshakeReceived = false;
  private closed = false;
  private readonly pending = new Map<
    string,
    {
      resolve: (val: unknown) => void;
      reject: (err: Error) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly eventListeners = new Set<(event: unknown) => void>();
  private readonly closeListeners = new Set<(reason?: Error) => void>();
  private handshakeWaiters: Array<{
    resolve: (meta: DaemonHandshakePayload) => void;
    reject: (err: Error) => void;
  }> = [];
  private handshakeMeta: DaemonHandshakePayload | null = null;

  constructor(
    private readonly readable: Readable,
    private readonly writable: Writable,
    private readonly options: {
      role: "client" | "server";
      onRequest?: (method: string, params: unknown) => Promise<unknown> | unknown;
      onNonProtocolLine?: (line: string) => void;
    },
  ) {
    if (options.role === "server") {
      this.handshakeReceived = true;
    }

    this.readable.setEncoding("utf8");
    this.readable.on("data", (chunk: string) => this.onData(chunk));
    this.readable.on("end", () => this.dispose(new Error("RPC stream ended")));
    this.readable.on("error", (err) => this.dispose(err instanceof Error ? err : new Error(String(err))));
    this.writable.on("error", (err) => this.dispose(err instanceof Error ? err : new Error(String(err))));
  }

  sendHandshake(payload: DaemonHandshakePayload): void {
    this.writeRaw(`${DAEMON_HANDSHAKE_PREFIX}${JSON.stringify(payload)}\n`);
  }

  waitForHandshake(timeoutMs = 15000): Promise<DaemonHandshakePayload> {
    if (this.handshakeMeta) {
      return Promise.resolve(this.handshakeMeta);
    }
    if (this.closed) {
      return Promise.reject(new Error("RPC transport already closed before handshake"));
    }
    return new Promise<DaemonHandshakePayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handshakeWaiters = this.handshakeWaiters.filter((w) => w.resolve !== resolve);
        reject(new Error(`Timed out waiting for remote ide2 daemon handshake (${timeoutMs}ms)`));
      }, timeoutMs);
      this.handshakeWaiters.push({
        resolve: (meta) => {
          clearTimeout(timer);
          resolve(meta);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  call<T = unknown>(method: string, params?: unknown, timeoutMs = 30000): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`Cannot call "${method}": RPC transport is closed.`));
    }
    const id = `r${this.nextId++}`;
    const frame: StdioRpcFrame = { kind: "req", id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`RPC timeout (${timeoutMs}ms) calling "${method}".`));
            }, timeoutMs)
          : undefined;

      this.pending.set(id, {
        resolve: (val) => resolve(val as T),
        reject,
        timer,
      });

      this.writeFrame(frame);
    });
  }

  emitEvent(event: unknown): void {
    if (this.closed) return;
    this.writeFrame({ kind: "evt", event });
  }

  onEvent(listener: (event: unknown) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onClose(listener: (reason?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  dispose(reason?: Error): void {
    if (this.closed) return;
    this.closed = true;
    const err = reason ?? new Error("RPC transport disposed");

    for (const waiter of this.handshakeWaiters) {
      waiter.reject(err);
    }
    this.handshakeWaiters = [];

    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();

    for (const listener of this.closeListeners) {
      try {
        listener(reason);
      } catch {
        // ignore
      }
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newlineIdx = this.buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const rawLine = this.buffer.slice(0, newlineIdx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newlineIdx + 1);
      this.handleLine(rawLine);
      newlineIdx = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    if (!this.handshakeReceived) {
      const prefixIdx = line.indexOf(DAEMON_HANDSHAKE_PREFIX);
      if (prefixIdx >= 0) {
        const jsonPart = line.slice(prefixIdx + DAEMON_HANDSHAKE_PREFIX.length);
        try {
          const meta = JSON.parse(jsonPart) as DaemonHandshakePayload;
          this.handshakeReceived = true;
          this.handshakeMeta = meta;
          const waiters = [...this.handshakeWaiters];
          this.handshakeWaiters = [];
          for (const w of waiters) w.resolve(meta);
          return;
        } catch (err) {
          this.dispose(
            new Error(
              `Malformed ide2 daemon handshake: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
          return;
        }
      }
      this.options.onNonProtocolLine?.(line);
      return;
    }

    let parsed: StdioRpcFrame;
    try {
      parsed = JSON.parse(line) as StdioRpcFrame;
    } catch {
      this.options.onNonProtocolLine?.(line);
      return;
    }

    if (!parsed || typeof parsed !== "object") return;

    if (parsed.kind === "req") {
      void this.handleIncomingRequest(parsed.id, parsed.method, parsed.params);
    } else if (parsed.kind === "res") {
      const entry = this.pending.get(parsed.id);
      if (!entry) return;
      this.pending.delete(parsed.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (parsed.ok) {
        entry.resolve(parsed.result);
      } else {
        entry.reject(new Error(parsed.error ?? "Remote RPC error"));
      }
    } else if (parsed.kind === "evt") {
      for (const listener of this.eventListeners) {
        try {
          listener(parsed.event);
        } catch {
          // ignore listener errors
        }
      }
    }
  }

  private async handleIncomingRequest(id: string, method: string, params: unknown): Promise<void> {
    if (method === "__ping") {
      this.writeFrame({ kind: "res", id, ok: true, result: { pong: Date.now() } });
      return;
    }
    if (!this.options.onRequest) {
      this.writeFrame({
        kind: "res",
        id,
        ok: false,
        error: `No RPC request handler registered for "${method}"`,
      });
      return;
    }
    try {
      const result = await this.options.onRequest(method, params);
      this.writeFrame({ kind: "res", id, ok: true, result });
    } catch (err) {
      this.writeFrame({
        kind: "res",
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private writeFrame(frame: StdioRpcFrame): void {
    this.writeRaw(`${JSON.stringify(frame)}\n`);
  }

  private writeRaw(data: string): void {
    if (this.closed) return;
    try {
      this.writable.write(data);
    } catch (err) {
      this.dispose(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
