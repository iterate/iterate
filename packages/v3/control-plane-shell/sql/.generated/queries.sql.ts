import type {Client} from 'sqlfu';

const projectExistsSql = `SELECT id FROM projects WHERE id = ?;`;
const projectExistsQuery = (params: projectExists.Params) => ({
	name: "projectExists",
	sql: projectExistsSql,
	args: [params.id],
});

export const projectExists = Object.assign(
	async function projectExists(client: Client, params: projectExists.Params): Promise<projectExists.Result | null> {
		const rows = await client.all<projectExists.Result>(projectExistsQuery(params));
		return rows.length > 0 ? rows[0] : null;
	},
	{ sql: projectExistsSql, query: projectExistsQuery },
);

export namespace projectExists {
	export type Params = {
		id: string;
	};
	export type Result = {
		id: string;
	};
}

const createProjectSql = `
INSERT INTO projects (id) VALUES (?)
ON CONFLICT(id) DO NOTHING
RETURNING id, created_at;
`.trim();
const createProjectQuery = (params: createProject.Params) => ({
	name: "createProject",
	sql: createProjectSql,
	args: [params.id],
});

function createProjectMapResult(row: createProject.RawResult): createProject.Result {
	return {
		id: row.id,
		createdAt: row.created_at,
	};
}

export const createProject = Object.assign(
	async function createProject(client: Client, params: createProject.Params): Promise<createProject.Result> {
		const rows = await client.all<createProject.RawResult>(createProjectQuery(params));
		return createProjectMapResult(rows[0]!);
	},
	{ sql: createProjectSql, query: createProjectQuery, mapResult: createProjectMapResult },
);

export namespace createProject {
	export type Params = {
		id: string;
	};
	export type RawResult = {
		id: string;
		created_at: string;
	};
	export type Result = {
		id: string;
		createdAt: string;
	};
}

const listProjectsSql = `
SELECT id, created_at FROM projects ORDER BY created_at DESC LIMIT ?;
`.trim();
const listProjectsQuery = (params: listProjects.Params) => ({
	name: "listProjects",
	sql: listProjectsSql,
	args: [params.limit],
});

function listProjectsMapResult(row: listProjects.RawResult): listProjects.Result {
	return {
		id: row.id,
		createdAt: row.created_at,
	};
}

export const listProjects = Object.assign(
	async function listProjects(client: Client, params: listProjects.Params): Promise<listProjects.Result[]> {
		const rows = await client.all<listProjects.RawResult>(listProjectsQuery(params));
		return rows.map(listProjectsMapResult);
	},
	{ sql: listProjectsSql, query: listProjectsQuery, mapResult: listProjectsMapResult },
);

export namespace listProjects {
	export type Params = {
		limit: number;
	};
	export type RawResult = {
		id: string;
		created_at: string;
	};
	export type Result = {
		id: string;
		createdAt: string;
	};
}
