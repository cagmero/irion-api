import "dotenv/config";
process.chdir(__dirname);
const { db } = require("./db/index.js");
console.log("db ok, type:", typeof db);