import { FastifyInstance } from "fastify";
declare const _default: (app: FastifyInstance) => Promise<void>;
export default _default;
declare module "fastify" {
    interface FastifyInstance {
        authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    }
    interface FastifyRequest {
        institutionId: string;
        apiKeyId: string;
    }
}
//# sourceMappingURL=auth.d.ts.map