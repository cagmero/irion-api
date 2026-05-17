import "dotenv/config";
import Fastify from "fastify";
import authPlugin from "../plugins/auth.js";

async function run() {
  const app = Fastify({ logger: false });
  console.log("before register: has authenticate =", app.hasDecorator("authenticate"));
  await app.register(authPlugin);
  console.log("after register, before ready: has authenticate =", app.hasDecorator("authenticate"));
  await app.ready();
  console.log("after ready: has authenticate =", app.hasDecorator("authenticate"));
  console.log("authenticate type =", typeof app.authenticate);
  await app.close();
}

run().catch((e) => { console.error(e.message); process.exit(1); });