import type { D1Database } from '@cloudflare/workers-types';

export type InsertRoutePatternParams = {
	routeId: string;
	pattern: string;
	target: string;
	headers: string;
}

export type InsertRoutePatternResult = {
	changes: number;
	last_row_id: number;
}

export async function insertRoutePattern(db: D1Database, params: InsertRoutePatternParams): Promise<InsertRoutePatternResult> {
	const sql = `
	INSERT INTO route_patterns (route_id, pattern, target, headers)
	VALUES (?, ?, ?, ?)
	
	`
	return db.prepare(sql)
		.bind(params.routeId, params.pattern, params.target, params.headers)
		.run()
		.then(res => res.meta);
}