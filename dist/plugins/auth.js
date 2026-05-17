"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_plugin_1 = __importDefault(require("fastify-plugin"));
const jwt_1 = __importDefault(require("@fastify/jwt"));
const crypto_1 = __importDefault(require("crypto"));
const node_stream_1 = require("node:stream");
const secrets_js_1 = require("../lib/secrets.js");
const errors_js_1 = require("../lib/errors.js");
const index_js_1 = require("../db/index.js");
const schema_js_1 = require("../db/schema.js");
const drizzle_orm_1 = require("drizzle-orm");
const JWT_ISSUER = "irion-api";
const JWT_AUDIENCE = "irion-api-v1";
const HMAC_CACHE_TTL_MS = 60_000;
const hmacSecretCache = new Map();
function decryptHmacSecret(encrypted, masterKey) {
    const key = crypto_1.default.scryptSync(masterKey, "irion-pgcrypto-salt", 32);
    const iv = encrypted.subarray(0, 16);
    const tag = encrypted.subarray(16, 32);
    const ciphertext = encrypted.subarray(32);
    const decipher = crypto_1.default.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
function getCachedHmacSecret(institutionId, encrypted, masterKey) {
    const cached = hmacSecretCache.get(institutionId);
    if (cached && cached.expiresAt > Date.now())
        return cached.secret;
    const plain = decryptHmacSecret(encrypted, masterKey);
    hmacSecretCache.set(institutionId, { secret: plain, expiresAt: Date.now() + HMAC_CACHE_TTL_MS });
    return plain;
}
function constantTimeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    return crypto_1.default.timingSafeEqual(a, b);
}
function getClientIp(request) {
    return (request.ip ??
        request.headers["x-forwarded-for"]?.split(",")[0]?.trim() ??
        "unknown");
}
exports.default = (0, fastify_plugin_1.default)(async function authPlugin(app) {
    const masterKey = (0, secrets_js_1.getSecret)("WEBHOOK_SIGNING_SECRET");
    const jwtSecret = (0, secrets_js_1.getSecret)("JWT_SECRET");
    app.addHook("preParsing", async (request, _reply, payload) => {
        if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method))
            return payload;
        const chunks = [];
        for await (const chunk of payload) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        request.rawBody = Buffer.concat(chunks);
        return node_stream_1.Readable.from(request.rawBody);
    });
    await app.register(jwt_1.default, {
        secret: jwtSecret,
        sign: {
            iss: JWT_ISSUER,
            aud: JWT_AUDIENCE,
        },
        verify: {
            algorithms: ["HS256"],
            allowedIss: [JWT_ISSUER],
            allowedAud: [JWT_AUDIENCE],
        },
    });
    app.decorate("authenticate", async (request, reply) => {
        try {
            const authHeader = request.headers.authorization;
            if (!authHeader?.startsWith("Bearer ")) {
                return reply.status(401).send((0, errors_js_1.problemDetails)(request, "MISSING_SIGNATURE", "Bearer token is required"));
            }
            let decoded;
            try {
                await request.jwtVerify();
                decoded = request.user;
            }
            catch (jwtErr) {
                const msg = jwtErr instanceof Error ? jwtErr.message : String(jwtErr);
                if (msg.includes("expired") || msg.includes("iat")) {
                    return reply.status(401).send((0, errors_js_1.problemDetails)(request, "EXPIRED_TOKEN"));
                }
                return reply.status(401).send((0, errors_js_1.problemDetails)(request, "INVALID_TOKEN"));
            }
            const { sub: institutionId, kid: apiKeyId } = decoded;
            const [keyRecord] = await index_js_1.db
                .select()
                .from(schema_js_1.apiKeys)
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(schema_js_1.apiKeys.id, apiKeyId), (0, drizzle_orm_1.eq)(schema_js_1.apiKeys.status, "active")))
                .limit(1);
            if (!keyRecord) {
                return reply.status(401).send((0, errors_js_1.problemDetails)(request, "INSTITUTION_NOT_FOUND", "API key not found or revoked"));
            }
            if (keyRecord.allowedIps && keyRecord.allowedIps.length > 0) {
                const clientIp = getClientIp(request);
                if (!keyRecord.allowedIps.includes(clientIp)) {
                    return reply.status(403).send((0, errors_js_1.problemDetails)(request, "IP_BLOCKED", `IP ${clientIp} is not in the allowed list`));
                }
            }
            if (["POST", "PUT", "PATCH"].includes(request.method)) {
                const signatureHeader = request.headers["irion-signature"];
                if (!signatureHeader) {
                    return reply.status(401).send((0, errors_js_1.problemDetails)(request, "MISSING_SIGNATURE"));
                }
                const rawBody = request.rawBody;
                if (!rawBody) {
                    return reply.status(401).send((0, errors_js_1.problemDetails)(request, "INVALID_SIGNATURE", "Raw body not available for HMAC verification"));
                }
                if (!keyRecord.hmacSecret) {
                    return reply.status(401).send((0, errors_js_1.problemDetails)(request, "INVALID_SIGNATURE", "No HMAC secret configured for this API key"));
                }
                const hmacSecret = getCachedHmacSecret(institutionId, keyRecord.hmacSecret, masterKey);
                const expected = crypto_1.default.createHmac("sha256", hmacSecret).update(rawBody).digest();
                const provided = Buffer.from(signatureHeader, "hex");
                if (!constantTimeEqual(expected, provided)) {
                    return reply.status(401).send((0, errors_js_1.problemDetails)(request, "INVALID_SIGNATURE"));
                }
            }
            request.institutionId = institutionId;
            request.apiKeyId = apiKeyId;
        }
        catch (err) {
            request.log.error({ err }, "auth plugin error");
            return reply.status(401).send((0, errors_js_1.problemDetails)(request, "AUTH_FAILED"));
        }
    });
});
//# sourceMappingURL=auth.js.map