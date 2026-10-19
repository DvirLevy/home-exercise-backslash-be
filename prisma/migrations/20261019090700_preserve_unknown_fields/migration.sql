-- AlterTable
ALTER TABLE "edges" ADD COLUMN     "extra" JSONB;

-- AlterTable
ALTER TABLE "graphs" ADD COLUMN     "extra" JSONB;

-- ---------------------------------------------------------------------------
-- Hand-written CHECK constraints. "extra" holds the unknown fields of an uploaded object,
-- so when present it is always a JSON object (never an array or a scalar).
-- ---------------------------------------------------------------------------
ALTER TABLE "graphs" ADD CONSTRAINT "graphs_extra_object_check"
    CHECK ("extra" IS NULL OR jsonb_typeof("extra") = 'object');
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_extra_object_check"
    CHECK ("extra" IS NULL OR jsonb_typeof("extra") = 'object');
ALTER TABLE "edges" ADD CONSTRAINT "edges_extra_object_check"
    CHECK ("extra" IS NULL OR jsonb_typeof("extra") = 'object');
