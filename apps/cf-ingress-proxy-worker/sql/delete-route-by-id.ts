import type { D1Database } from '@cloudflare/workers-types';

export type DeleteRouteByIdParams = {
	routeId: string;
}

export type DeleteRouteByIdResult = {
	changes: number;
}

export async function deleteRouteById(db: D1Database, params: DeleteRouteByIdParams): Promise<DeleteRouteByIdResult> {
	const sql = `
	DELETE FROM routes
	WHERE id = ?
	
	`
	return db.prepare(sql)
		.bind(params.routeId)
		.run()
		.then(res => res.meta);
}