import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in bindings.json to `DB`, and make sure the deploy target injects the real binding values."
    );
  }

  return drizzle(env.DB, { schema });
}
