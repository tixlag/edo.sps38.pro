import ts from "typescript";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "nestjs-test-metadata",
      enforce: "pre",
      transform(code, id) {
        const needsMetadata = [
          "/src/documents/",
          "/src/ocr/",
          "/src/storage/",
          "/src/auth/jwt.service.ts",
          "/src/auth/jwt-auth.guard.ts",
          "/src/auth/access-rule.guard.ts",
          "/src/audit/audit.service.ts",
        ].some((path) => id.includes(path));
        if (!needsMetadata || !id.endsWith(".ts")) return;
        const result = ts.transpileModule(code, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
            esModuleInterop: true,
            sourceMap: true,
          },
          fileName: id,
        });
        return { code: result.outputText, map: result.sourceMapText };
      },
    },
  ],
  test: {
    include: ["test/**/*.spec.ts"],
    maxWorkers: 4,
    minWorkers: 1,
    // Full reconciliation changes the whole disposable projection; infrastructure files must not overlap.
    fileParallelism: !process.env.EDO_TEST_DATABASE_URL,
  },
});
