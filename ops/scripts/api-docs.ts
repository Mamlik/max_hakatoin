import { mkdir, writeFile } from "node:fs/promises";
process.env.VITEST = "documentation";
const { createApp } = await import("../../apps/api/main.js");
const { endpoints } = await import("../../packages/backend/http.js");
const { pool } = await import("../../packages/db/db.js");
const app = await createApp();
try {
  const result = await app.inject({ method: "GET", url: "/api/openapi.json" });
  if (result.statusCode !== 200) throw new Error("OpenAPI generation failed");
  await mkdir("docs", { recursive: true });
  await writeFile(
    "docs/openapi.json",
    JSON.stringify(result.json(), null, 2) + "\n",
  );
  // JSON is valid YAML 1.2; keep this inventory generated from the actual registered routes.
  await writeFile(
    "docs/DATA-API.yaml",
    JSON.stringify(
      {
        format: "project-api-inventory-v1",
        note: "Собственный формат проекта, не официальная схема организаторов.",
        basePath: "/api/v1",
        auth: "Bearer sessionToken после POST /auth/max",
        commands:
          "Idempotency-Key: UUID v4; expectedVersion для изменения существующих объектов",
        response: {
          success: "data + meta",
          failure: "error {code,message,details} + meta",
        },
        endpoints: endpoints.map((e) => ({
          method: e.method,
          path: e.path,
          role: e.scope,
          description: e.description,
          requestSchema: "См. docs/openapi.json",
          expectedStatus: e.successStatus,
        })),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Generated docs/openapi.json and docs/DATA-API.yaml (${endpoints.length} endpoints).`,
  );
} finally {
  await app.close();
  await pool.end();
}
