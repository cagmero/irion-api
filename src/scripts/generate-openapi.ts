import { buildApp } from "../app";
import * as fs from "fs";
import * as path from "path";

async function generate() {
  const app = await buildApp();
  await app.ready();
  
  const yaml = app.swagger({ yaml: true });
  const outputPath = path.join(__dirname, "../../../openapi.yaml");
  
  fs.writeFileSync(outputPath, yaml);
  console.log(`✅ Generated OpenAPI specification at ${outputPath}`);
  process.exit(0);
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
