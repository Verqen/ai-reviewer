import type { FastifyInstance } from "fastify";

function healthRoute(app: FastifyInstance): void {
  app.get("/health", (_req, reply) => {
    return reply.status(200).send({ status: "ok" });
  });
}

export { healthRoute };
