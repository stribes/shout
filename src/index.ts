
import { DurableObject } from "cloudflare:workers";

export class ShoutRoom extends DurableObject {
  async fetch(_request: Request): Promise<Response> {
    return new Response("Shout room is not implemented yet.", {
      status: 501,
    });
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const room = env.SHOUT_ROOM.getByName("global");

      return room.fetch(request);
    }

    return new Response("Not found.", {
      status: 404,
    });
  },
} satisfies ExportedHandler<Env>;
