import type { D1Database } from '@cloudflare/workers-types';

export type SelectPatternConflictsParams = {
	patterns: string[];
}

export type SelectPatternConflictsResult = {
	routeId: string;
	pattern: string;
}

export async function selectPatternConflicts(db: D1Database, params: SelectPatternConflictsParams): Promise<SelectPatternConflictsResult[]> {
	const sql = `
	SELECT route_id AS routeId, pattern
	FROM route_patterns
	WHERE pattern IN (${params.patterns.map(() => '?')})
	ORDER BY route_id ASC, pattern ASC
	
	`
	return db.prepare(sql)
		.bind(...params.patterns)
		.raw({ columnNames: false })
		.then(rows => rows.map(row => mapArrayToSelectPatternConflictsResult(row)));
}

function mapArrayToSelectPatternConflictsResult(data: any) {
	const result: SelectPatternConflictsResult = {
		routeId: data[0],
		pattern: data[1]
	}
	return result;
}