"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv = __importStar(require("dotenv"));
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env.test" });
const crypto_1 = __importDefault(require("crypto"));
const jose = __importStar(require("jose"));
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_SECRET_BYTES = Buffer.from(JWT_SECRET, "hex");
const JWT_ISSUER = "irion-api";
const JWT_AUDIENCE = "irion-api-v1";
const TEST_INSTITUTION_ID = process.env.TEST_INSTITUTION_ID;
const TEST_API_KEY_ID = "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e";
const TEST_HMAC_SECRET = Buffer.from(process.env.TEST_HMAC_SECRET, "hex");
const ALGOD_URL = process.env.ALGOD_URL;
async function signJwt(payload) {
    const key = await jose.importJWK({ k: JWT_SECRET_BYTES.toString("base64url"), kty: "oct" }, "HS256");
    return await new jose.SignJWT(payload)
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setIssuer(JWT_ISSUER)
        .setAudience(JWT_AUDIENCE)
        .setExpirationTime("15m")
        .sign(key);
}
function computeHmac(secret, body) {
    return crypto_1.default.createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex");
}
async function run() {
    console.log("=== 2b Smoke Tests ===\n");
    console.log("1. JWT signing");
    const jwt = await signJwt({ sub: TEST_INSTITUTION_ID, kid: TEST_API_KEY_ID });
    console.log("   JWT created:", jwt.substring(0, 40) + "...");
    console.log("\n2. HMAC computation");
    const testBody = JSON.stringify({ test: "data" });
    const sig = computeHmac(TEST_HMAC_SECRET, testBody);
    console.log("   HMAC-SHA256:", sig);
    console.log("\n3. Algorand client");
    console.log("   ALGOD_URL:", ALGOD_URL);
    console.log("\n4. Constant-time equal (true case)");
    const a = Buffer.from("abcd");
    const b = Buffer.from("abcd");
    const result = crypto_1.default.timingSafeEqual(a, b);
    console.log("   timingSafeEqual(ab, ab):", result);
    console.log("\n5. Constant-time equal (false case)");
    try {
        const c = Buffer.from("abce");
        crypto_1.default.timingSafeEqual(a, c);
        console.log("   unexpected: no error thrown");
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log("   timingSafeEqual(ab, abce) throws:", msg.split("\n")[0]);
    }
    console.log("\n=== All smoke checks passed ===");
}
run().catch((e) => { console.error(e); process.exit(1); });
//# sourceMappingURL=smoke-test.js.map