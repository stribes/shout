
import { DurableObject } from "cloudflare:workers";
import type { Shout, ServerMessage } from "./types";

const MAX_MESSAGE_LENGTH = 140;
const MAX_PAYLOAD_BYTES = 2_048;
const MAX_SHOUTS = 500;
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_MESSAGES = 5;
const RATE_LIMIT_CLEANUP_MS = 60_000;

async function hashIp(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(ip),
  );

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export class Room extends DurableObject<Env> {
  private readonly rateLimits = new Map<string, number[]>();
  private lastRateLimitCleanup = Date.now();

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

    const ip = request.headers.get("CF-Connecting-IP");
    const rateLimitKey = ip ? await hashIp(ip) : crypto.randomUUID();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ rateLimitKey });

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
    if (!this.allowMessage(this.getRateLimitKey(socket))) {
      this.sendError(socket, "You're shouting too fast. Please wait a moment.");
      return;
    }

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

  private getRateLimitKey(socket: WebSocket): string {
    const attachment = socket.deserializeAttachment() as {
      rateLimitKey?: unknown;
    } | null;

    return typeof attachment?.rateLimitKey === "string"
      ? attachment.rateLimitKey
      : "unknown";
  }

  private allowMessage(key: string): boolean {
    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW_MS;

    let timestamps = this.rateLimits.get(key);

    if (!timestamps) {
      timestamps = [];
      this.rateLimits.set(key, timestamps);
    }

    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= RATE_LIMIT_MAX_MESSAGES) {
      return false;
    }

    timestamps.push(now);

    if (now - this.lastRateLimitCleanup >= RATE_LIMIT_CLEANUP_MS) {
      this.cleanupRateLimits(cutoff);
      this.lastRateLimitCleanup = now;
    }

    return true;
  }

  private cleanupRateLimits(cutoff: number): void {
    for (const [key, timestamps] of this.rateLimits) {
      if (
        timestamps.length === 0 ||
        timestamps[timestamps.length - 1] <= cutoff
      ) {
        this.rateLimits.delete(key);
      }
    }
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
