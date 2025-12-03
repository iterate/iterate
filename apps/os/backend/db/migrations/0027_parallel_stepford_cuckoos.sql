CREATE TABLE "iterate_config_source" (
	"id" text PRIMARY KEY NOT NULL,
	"estate_id" text NOT NULL,
	"provider" text NOT NULL,
	"account_id" text NOT NULL,
	"repo_id" integer NOT NULL,
	"branch" text NOT NULL,
	"path" text,
	"deactivated_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

with stage_info as (
	select
      case
	    -- hard-code production and staging "iterate" orgs, since we need a different default installation id for each.
        when (select true from organization where id = 'org_01k76ps8rvfervj0ww76hfxvj7') then 'prd'
        when (select true from organization where id = 'org_01k865wn4ge03tgpxpe01rw14r') then 'stg'
        else 'dev'
      end as stage_name
),
github_installation_info as (
	select
		case
		    -- at time of writing (2025-12-03) these are the default installation ids for the "iterate" orgs. Source: doppler variables.
			when stage_info.stage_name = 'prd' then '89376446'
			when stage_info.stage_name = 'stg' then '91406805'
			else '89100408' -- default dev installation id
		end as default_installation_id
    from stage_info
),
old_connected_repo as (
	select
	   estate.id as estate_id,
	   estate.name as estate_name,
	   organization.name as organization_name,
	   connected_repo_id as repo_id,
	   connected_repo_ref as branch,
	   (
			select account.account_id
			from estate_accounts_permissions
			join account
			on
				account.id = estate_accounts_permissions.account_id
				and account.provider_id = 'github-app'
			where
				estate_accounts_permissions.estate_id = estate.id
			limit 1
	   ) as existing_account_id,
	   case
		 -- the default of "/" caused trouble and wasn't accurate - it implies an "absolute" root, better to just say there's no path to mean the root of the repo.
		 when connected_repo_path = '/' then null
		 else connected_repo_path
	   end as path
	from estate
	join organization on estate.organization_id = organization.id
    where connected_repo_id is not null
)
insert into iterate_config_source (
	id,
	estate_id,
	provider,
	account_id,
	repo_id,
	branch,
	path
)
select
    -- unfortunately we have yielded control of our id generation to drizzle, so we have to use a hack to generate a valid id here.
	replace(old_connected_repo.estate_id, 'es_', 'ics_') as id,
	estate_id,
	-- maybe we'll add other providers like gitlab, npm, s3 etc. in the future but at this point everything is github
	'github' as provider,
	coalesce(existing_account_id, github_installation_info.default_installation_id) as account_id,
	repo_id,
	branch,
	path
from
	old_connected_repo
join github_installation_info on true
returning id as source_id, estate_id;

--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "files" jsonb /*NOT NULL*/;--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "config" jsonb;--> statement-breakpoint

-- set empty defaults for all old builds - these *should* be overwritten by the backfills below.
update builds set files = '[]'::jsonb;
update builds set config = '{}'::jsonb;

alter table builds alter column files set not null;
-- note: config *is* nullable because we don't have it until the end of the build

ALTER TABLE "iterate_config" ADD COLUMN "build_id" text /*NOT NULL*/;--> statement-breakpoint

update iterate_config set build_id = (
	select id
	from builds
	where builds.estate_id = iterate_config.estate_id
	order by builds.created_at desc
	limit 1
);

-- if for some reason the above update failed, we'll just delete the rows.
-- this should only happen for super old configs that are likely useless anyway.
delete from iterate_config where build_id is null;

alter table iterate_config alter column build_id set not null;

-- just set the latest iterate_config.config for all old builds. rollback will be a no-op for these sadly. 
update builds set config = (
	select config
	from iterate_config
	where iterate_config.estate_id = builds.estate_id
	order by iterate_config.updated_at desc
	limit 1
);

-- just in case someone tries to re-apply changes from an old build, at least make it functional, even if it's ugly.
update builds set files = jsonb_build_array(
	jsonb_build_object(
        'path', 'package.json',
		'content', '{
			"name": "regenerated-estate",
			"version": "0.0.1-regenerated",
			"type": "module"
		}'
	),
	jsonb_build_object(
		'path', 'iterate.config.ts',
		'content', '// NOTE:\n' ||
		  '// this iterate config was regenerated from its json output\n' ||
		  '// it is not advised to use it directly\n' ||
		  '\n' ||
		  'export default ' || jsonb_pretty(config) || ';'
	)
);

ALTER TABLE "iterate_config_source" ADD CONSTRAINT "iterate_config_source_estate_id_estate_id_fk" FOREIGN KEY ("estate_id") REFERENCES "public"."estate"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "iterate_config_source_estate_id_provider_index" ON "iterate_config_source" USING btree ("estate_id","provider") WHERE "iterate_config_source"."deactivated_at" is null;--> statement-breakpoint
ALTER TABLE "iterate_config" ADD CONSTRAINT "iterate_config_build_id_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estate" DROP COLUMN "connected_repo_id";--> statement-breakpoint
ALTER TABLE "estate" DROP COLUMN "connected_repo_ref";--> statement-breakpoint
ALTER TABLE "estate" DROP COLUMN "connected_repo_path";--> statement-breakpoint
ALTER TABLE "iterate_config" DROP COLUMN "config";