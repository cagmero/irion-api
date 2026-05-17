import "dotenv/config";
import http from "http";

async function httpGet(host: string, port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method: "GET" }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

async function httpPost(host: string, port: number, path: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
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
  } catch (e: any) {
    console.error("Request failed:", e.message);
  }
}

run();