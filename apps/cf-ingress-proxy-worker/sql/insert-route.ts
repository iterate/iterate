import type { D1Database } from '@cloudflare/workers-types';

export type InsertRouteParams = {
	routeId: string;
	metadata: string;
}

export type InsertRouteResult = {
	changes: number;
	last_row_id: number;
}

export async function insertRoute(db: D1Database, params: InsertRouteParams): Promise<InsertRouteResult> {
	const sql = `
	INSERT INTO routes (id, metadata)
	VALUES (?, ?)
	
	`
	return db.prepare(sql)
		.bind(params.routeId, params.metadata)
		.run()
		.then(res => res.meta);
}