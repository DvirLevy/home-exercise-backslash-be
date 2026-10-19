-- CreateTable
CREATE TABLE "graphs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "graphs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nodes" (
    "graph_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT,
    "language" TEXT,
    "path" TEXT,
    "public_exposed" BOOLEAN,
    "is_placeholder" BOOLEAN NOT NULL DEFAULT false,
    "vulnerabilities" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB,
    "extra" JSONB,

    CONSTRAINT "nodes_pkey" PRIMARY KEY ("graph_id","name")
);

-- CreateTable
CREATE TABLE "edges" (
    "graph_id" UUID NOT NULL,
    "from_name" TEXT NOT NULL,
    "to_name" TEXT NOT NULL,

    CONSTRAINT "edges_pkey" PRIMARY KEY ("graph_id","from_name","to_name")
);

-- CreateTable
CREATE TABLE "graph_filters" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "graph_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "definition" JSONB NOT NULL,
    "definition_version" INTEGER NOT NULL DEFAULT 1,
    "is_builtin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "graph_filters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "nodes_graph_id_position_idx" ON "nodes"("graph_id", "position");

-- CreateIndex
CREATE INDEX "edges_graph_id_to_name_idx" ON "edges"("graph_id", "to_name");

-- CreateIndex
CREATE UNIQUE INDEX "graph_filters_graph_id_key_key" ON "graph_filters"("graph_id", "key");

-- AddForeignKey
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_graph_id_fkey" FOREIGN KEY ("graph_id") REFERENCES "graphs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edges" ADD CONSTRAINT "edges_graph_id_fkey" FOREIGN KEY ("graph_id") REFERENCES "graphs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edges" ADD CONSTRAINT "edges_graph_id_from_name_fkey" FOREIGN KEY ("graph_id", "from_name") REFERENCES "nodes"("graph_id", "name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edges" ADD CONSTRAINT "edges_graph_id_to_name_fkey" FOREIGN KEY ("graph_id", "to_name") REFERENCES "nodes"("graph_id", "name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "graph_filters" ADD CONSTRAINT "graph_filters_graph_id_fkey" FOREIGN KEY ("graph_id") REFERENCES "graphs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written CHECK constraints (Prisma's schema language cannot express them).
-- Constraint names are asserted by tests/integration/db/constraints.test.ts.
-- ---------------------------------------------------------------------------

-- graphs: name is 1-200 characters once surrounding whitespace is trimmed; version starts at 1.
ALTER TABLE "graphs" ADD CONSTRAINT "graphs_name_length_check"
    CHECK (char_length(btrim("name")) BETWEEN 1 AND 200);
ALTER TABLE "graphs" ADD CONSTRAINT "graphs_version_check"
    CHECK ("version" >= 1);

-- nodes: a name is required, a real node must have a kind, and a placeholder holds no invented data.
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_name_not_empty_check"
    CHECK (char_length("name") > 0);
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_position_check"
    CHECK ("position" >= 0);
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_kind_required_check"
    CHECK ("is_placeholder" OR "kind" IS NOT NULL);
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_placeholder_empty_check"
    CHECK (
        NOT "is_placeholder" OR (
            "kind" IS NULL
            AND "language" IS NULL
            AND "path" IS NULL
            AND "public_exposed" IS NULL
            AND "metadata" IS NULL
            AND "extra" IS NULL
            AND "vulnerabilities" = '[]'::jsonb
        )
    );
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_vulnerabilities_array_check"
    CHECK (jsonb_typeof("vulnerabilities") = 'array');

-- graph_filters: URL-safe lowercase key (letters, digits, hyphens; starts with a letter, up to 63 chars),
-- a JSON object as rule, and a positive rule-format version.
ALTER TABLE "graph_filters" ADD CONSTRAINT "graph_filters_key_format_check"
    CHECK ("key" ~ '^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$');
ALTER TABLE "graph_filters" ADD CONSTRAINT "graph_filters_definition_object_check"
    CHECK (jsonb_typeof("definition") = 'object');
ALTER TABLE "graph_filters" ADD CONSTRAINT "graph_filters_definition_version_check"
    CHECK ("definition_version" >= 1);
