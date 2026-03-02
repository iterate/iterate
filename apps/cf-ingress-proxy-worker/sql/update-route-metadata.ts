import type { D1Database } from '@cloudflare/workers-types';

export type UpdateRouteMetadataData = {
	metadata: string;
}

export type UpdateRouteMetadataParams = {
	routeId: string;
}

export type UpdateRouteMetadataResult = {
	changes: number;
}

export async function updateRouteMetadata(db: D1Database, data: UpdateRouteMetadataData, params: UpdateRouteMetadataParams): Promise<UpdateRouteMetadataResult> {
	const sql = `
	UPDATE routes
	SET metadata = ?, updated_at = CURRENT_TIMESTAMP
	WHERE id = ?
	
	`
	return db.prepare(sql)
		.bind(data.metadata, params.routeId)
		.run()
		.then(res => res.meta);
}