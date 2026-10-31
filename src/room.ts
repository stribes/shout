
import { DurableObject } from "cloudflare:workers";
import type { Shout, ServerMessage } from "./types";

const MAX_MESSAGE_LENGTH = 140;
const MAX_PAYLOAD_BYTES = 2_048;
const MAX_SHOUTS = 500;

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // init schema before accepting requests
    this.ctx.blockConcurrencyWhile(() => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS shouts (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", {
        status: 426,
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    this.send(server, {
      type: "history",
      shouts: this.getShouts(),
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") {
      this.sendError(socket, "Binary messages are not supported.");
      return;
    }

    if (new TextEncoder().encode(message).byteLength > MAX_PAYLOAD_BYTES) {
      this.sendError(socket, "Message payload is too large.");
      return;
    }

    let data: unknown;

    try {
      data = JSON.parse(message);
    } catch {
      this.sendError(socket, "Invalid JSON.");
      return;
    }

    if (
      typeof data !== "object" ||
      data === null ||
      Array.isArray(data)
    ) {
      this.sendError(socket, "Invalid message format.");
      return;
    }

    const payload = data as Record<string, unknown>;

    if (payload.type !== "shout" || typeof payload.content !== "string") {
      this.sendError(socket, "Unsupported message type.");
      return;
    }

    const content = payload.content.trim();

    if (content.length === 0) {
      this.sendError(socket, "Messages cannot be empty.");
      return;
    }

    if ([...content].length > MAX_MESSAGE_LENGTH) {
      this.sendError(
        socket,
        `Messages cannot exceed ${MAX_MESSAGE_LENGTH} characters.`,
      );
      return;
    }

    const shout: Shout = {
      id: crypto.randomUUID(),
      content,
      createdAt: Date.now(),
    };

    // insert our message
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO shouts (id, content, created_at)
         VALUES (?, ?, ?)`,
        shout.id,
        shout.content,
        shout.createdAt,
      );

      this.ctx.storage.sql.exec(
        `DELETE FROM shouts
         WHERE rowid NOT IN (
           SELECT rowid FROM shouts
           ORDER BY rowid DESC
           LIMIT ?
         )`,
        MAX_SHOUTS,
      );
    });

    this.broadcast({
      type: "shout",
      shout,
    });
  }

  private getShouts(): Shout[] {
    return this.ctx.storage.sql
      .exec<Shout>(
        `SELECT
           id,
           content,
           created_at AS createdAt
         FROM shouts
         ORDER BY rowid ASC`,
      )
      .toArray();
  }

  private broadcast(message: ServerMessage): void {
    for (const socket of this.ctx.getWebSockets()) {
      this.send(socket, message);
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      socket.send(JSON.stringify(message));
    } catch {
      // a disconnected socket should not prevent delivery to others
    }
  }

  private sendError(socket: WebSocket, message: string): void {
    this.send(socket, {
      type: "error",
      message,
    });
  }
}
