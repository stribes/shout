
import { Room } from "./room";

export { Room };

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/ws") {
      return new Response("Not found.", {
        status: 404,
      });
    }

    if (request.method !== "GET") {
      return new Response("Method not allowed.", {
        status: 405,
        headers: {
          Allow: "GET",
        },
      });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", {
        status: 426,
      });
    }

    const room = env.SHOUT_ROOM.getByName("global");

    return room.fetch(request);
  },
} satisfies ExportedHandler<Env>;
