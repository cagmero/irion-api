import "dotenv/config";
process.chdir(__dirname);
const { db } = await import("./db/index.js");
console.log("db ok, type:", typeof db);
const { apiKeys } = await import("./db/schema.js");
console.log("apiKeys ok:", typeof apiKeys);