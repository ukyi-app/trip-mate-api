import { createApp } from "./core/openapi.ts";

const app = createApp();
app.get("/health", (c) => c.json({ status: "ok" }));

export default { port: 3000, fetch: app.fetch };
