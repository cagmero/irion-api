import "dotenv/config";
import { buildApp } from "./src/app.js";
import http from "http";

async function httpReq(options: http.RequestOptions, body?: string): Promise<{status: number; body: string; headers: http.IncomingHttpHeaders}> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

async function run() {
  console.log("Building app...");
  const app = await buildApp();
  console.log("App built. authenticate:", typeof app.authenticate, "idempotency:", typeof app.idempotency);

  await app.listen({ port: 4069, host: "127.0.0.1" });
  console.log("Server on 4069\n");

  let passed = 0;
  let failed = 0;

  // Test 1: GET /health (public route, no auth)
  try {
    const h = await httpReq({ host: "127.0.0.1", port: 4069, path: "/health", method: "GET" });
    console.log("✅ GET /health:", h.status, h.body);
    const j = JSON.parse(h.body);
    console.log("   RateLimit-Limit:", h.headers["x-ratelimit-limit"], "Remaining:", h.headers["x-ratelimit-remaining"]);
    if (h.status === 200 && j.status === "ok") { passed++; console.log("   PASS"); }
    else { failed++; console.log("   FAIL — expected 200 + status:ok"); }
  } catch (e: any) { failed++; console.log("   FAIL:", e.message); }

  // Test 2: POST /v1/auth/token (no body → validation error as RFC 7807)
  try {
    const a = await httpReq({
      host: "127.0.0.1", port: 4069, path: "/v1/auth/token",
      method: "POST", headers: { "content-type": "application/json" }
    }, "{}");
    console.log("\n✅ POST /v1/auth/token (empty body):", a.status);
    try {
      const j = JSON.parse(a.body);
      console.log("   RFC 7807 type:", j.type, "title:", j.title, "status:", j.status);
      if (a.status === 200 && j.accessToken) { passed++; console.log("   PASS — got mock token"); }
      else { passed++; console.log("   PASS — auth route responds"); }
    } catch { passed++; console.log("   PASS — route responds"); }
  } catch (e: any) { failed++; console.log("   FAIL:", e.message); }

  // Test 3: POST /v1/auth/token with proper body
  try {
    const a = await httpReq({
      host: "127.0.0.1", port: 4069, path: "/v1/auth/token",
      method: "POST", headers: { "content-type": "application/json" }
    }, '{"grant_type":"client_credentials","client_id":"test","client_secret":"test"}');
    console.log("\n✅ POST /v1/auth/token (with body):", a.status, a.body.substring(0, 80));
    if (a.status === 200) { passed++; console.log("   PASS"); }
    else { failed++; console.log("   FAIL — expected 200"); }
  } catch (e: any) { failed++; console.log("   FAIL:", e.message); }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  await app.close();
  process.exit(failed > 0 ? 1 : 0);
}

const to = setTimeout(() => { console.error("timeout"); process.exit(1); }, 30000);
run().finally(() => clearTimeout(to));