import type { D1Database } from '@cloudflare/workers-types';

export type DeleteRoutePatternsByRouteIdParams = {
	routeId: string;
}

export type DeleteRoutePatternsByRouteIdResult = {
	changes: number;
}

export async function deleteRoutePatternsByRouteId(db: D1Database, params: DeleteRoutePatternsByRouteIdParams): Promise<DeleteRoutePatternsByRouteIdResult> {
	const sql = `
	DELETE FROM route_patterns
	WHERE route_id = ?
	
	`
	return db.prepare(sql)
		.bind(params.routeId)
		.run()
		.then(res => res.meta);
}