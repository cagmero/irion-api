"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const http_1 = __importDefault(require("http"));
async function httpGet(host, port, path) {
    return new Promise((resolve, reject) => {
        const req = http_1.default.request({ host, port, path, method: "GET" }, (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => resolve(data));
        });
        req.on("error", reject);
        req.setTimeout(3000, () => { req.destroy(); reject(new Error("timeout")); });
        req.end();
    });
}
async function httpPost(host, port, path, body) {
    return new Promise((resolve, reject) => {
        const req = http_1.default.request({ host, port, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => resolve(data));
        });
        req.on("error", reject);
        req.setTimeout(3000, () => { req.destroy(); reject(new Error("timeout")); });
        req.write(body);
        req.end();
    });
}
async function run() {
    try {
        console.log("GET /health...");
        const health = await httpGet("127.0.0.1", 4000, "/health");
        console.log("  Response:", health);
        console.log("POST /v1/auth/token...");
        const auth = await httpPost("127.0.0.1", 4000, "/v1/auth/token", "{}");
        console.log("  Response:", auth);
    }
    catch (e) {
        console.error("Request failed:", e.message);
    }
}
run();
//# sourceMappingURL=http-test.js.map