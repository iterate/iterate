import type { D1Database } from '@cloudflare/workers-types';

export type SelectRoutePatternsByRouteIdParams = {
	routeId: string;
}

export type SelectRoutePatternsByRouteIdResult = {
	id: number;
	route_id: string;
	pattern: string;
	target: string;
	headers: string;
	created_at: string;
	updated_at: string;
}

export async function selectRoutePatternsByRouteId(db: D1Database, params: SelectRoutePatternsByRouteIdParams): Promise<SelectRoutePatternsByRouteIdResult[]> {
	const sql = `
	SELECT id, route_id, pattern, target, headers, created_at, updated_at
	FROM route_patterns
	WHERE route_id = ?
	ORDER BY id ASC
	
	`
	return db.prepare(sql)
		.bind(params.routeId)
		.raw({ columnNames: false })
		.then(rows => rows.map(row => mapArrayToSelectRoutePatternsByRouteIdResult(row)));
}

function mapArrayToSelectRoutePatternsByRouteIdResult(data: any) {
	const result: SelectRoutePatternsByRouteIdResult = {
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