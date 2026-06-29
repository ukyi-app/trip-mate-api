import { OpenAPIHono } from "@hono/zod-openapi";

export function createApp() {
  return new OpenAPIHono();
}
