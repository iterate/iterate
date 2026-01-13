CREATE UNIQUE INDEX "project_organization_id_name_index" ON "project" USING btree ("organization_id","name");
