import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * Copies the Drizzle migrations alongside the compiled worker so a deploy has
 * everything it needs to bring a fresh database up to schema. Vite does not
 * treat `.sql` as an asset, so without this they simply do not reach `dist/`.
 */
export function packageMigrations(): Plugin {
  let root = process.cwd();

  return {
    name: "package-migrations",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    async closeBundle() {
      const source = resolve(root, "drizzle");
      const destination = resolve(root, "dist", "migrations");

      await rm(destination, { recursive: true, force: true });

      try {
        await cp(source, destination, { recursive: true });
      } catch (error) {
        // No migrations yet is a valid state; anything else is a real failure.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(destination, { recursive: true });
      }
    },
  };
}
