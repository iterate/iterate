import type { D1Database } from '@cloudflare/workers-types';

export type SelectRoutePatternsResult = {
	id: number;
	route_id: string;
	pattern: string;
	target: string;
	headers: string;
	created_at: string;
	updated_at: string;
}

export async function selectRoutePatterns(db: D1Database): Promise<SelectRoutePatternsResult[]> {
	const sql = `
	SELECT id, route_id, pattern, target, headers, created_at, updated_at
	FROM route_patterns
	ORDER BY route_id ASC, id ASC
	
	`
	return db.prepare(sql)
		.raw({ columnNames: false })
		.then(rows => rows.map(row => mapArrayToSelectRoutePatternsResult(row)));
}

function mapArrayToSelectRoutePatternsResult(data: any) {
	const result: SelectRoutePatternsResult = {
		id: data[0],
		route_id: data[1],
		pattern: data[2],
		target: data[3],
		headers: data[4],
		created_at: data[5],
		updated_at: data[6]
	}
	return result;
}