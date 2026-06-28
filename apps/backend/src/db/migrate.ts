import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");
const maxAttempts = Number(process.env.DB_MIGRATE_ATTEMPTS ?? 30);

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function message(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
	const pool = new pg.Pool({ connectionString: databaseUrl });
	try {
		await pool.query(schema);
		await pool.end();
		console.log("database migrated");
		process.exit(0);
	} catch (error) {
		await pool.end().catch(() => undefined);
		if (attempt === maxAttempts) {
			console.error(`database migration failed after ${attempt} attempts: ${message(error)}`);
			throw error;
		}

		console.warn(`database not ready, retrying migration ${attempt}/${maxAttempts}: ${message(error)}`);
		await sleep(2000);
	}
}
