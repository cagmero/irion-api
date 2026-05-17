import { FastifyInstance } from "fastify";
declare const _default: (app: FastifyInstance) => Promise<void>;
export default _default;
declare module "fastify" {
    interface FastifyInstance {
        idempotency: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    }
}
//# sourceMappingURL=idempotency.d.ts.map