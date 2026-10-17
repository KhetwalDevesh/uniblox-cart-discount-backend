import { createApp } from "../src/app";
import { loadConfig } from "../src/config/env";
import { createContainer } from "../src/container";

// Builds the spec in-process, so no running server or database connection is needed.
const app = createApp(createContainer(loadConfig()));
const response = await app.handle(new Request("http://localhost/swagger/json"));
if (!response.ok) throw new Error(`Failed to build the OpenAPI document: ${response.status}`);

const output = "openapi.json";
await Bun.write(output, `${JSON.stringify(await response.json(), null, 2)}\n`);
console.log(`OpenAPI document written to ${output}`);
process.exit(0);
