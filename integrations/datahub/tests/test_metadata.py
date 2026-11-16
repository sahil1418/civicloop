import copy
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from datahub.metadata.schema_classes import (
    SchemaMetadataClass,
    OtherSchemaClass,
    SchemaFieldClass,
    SchemaFieldDataTypeClass,
    StringTypeClass,
    ForeignKeyConstraintClass,
)

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]
# Import the standalone integration without installing it in the app environment.
from civicloop_metadata import (  # noqa: E402
    TABLES,
    SafeSchema,
    DocumentedProperties,
    VerifiedLineage,
    sibling_urn,
)
from ingest import load_recipe, validate_recipe, verify_catalog, dataset_urn  # noqa: E402

ENV = {
    "CIVICLOOP_PG_HOST_PORT": "localhost:15432",
    "CIVICLOOP_PG_DATABASE": "test_db",
    "CIVICLOOP_PG_USER": "catalog",
    "CIVICLOOP_PG_PASSWORD": "test-only",
    "CIVICLOOP_PG_SSLMODE": "disable",
    "DATAHUB_ENV": "DEV",
    "DATAHUB_GMS_URL": "http://localhost:18080",
    "DATAHUB_GMS_TOKEN": "test-only",
}
URN = "urn:li:dataset:(urn:li:dataPlatform:postgres,civicloop.test_db.public.Complaint,DEV)"


class RecipeTests(unittest.TestCase):
    def setUp(self):
        with patch.dict(os.environ, ENV):
            self.recipe = load_recipe()

    def test_exact_tables_and_sensitive_exclusions(self):
        config = validate_recipe(self.recipe)
        for table in TABLES:
            self.assertTrue(config.table_pattern.allowed(f"test_db.public.{table}"))
        for table in [
            "User",
            "OtpCode",
            "VerificationToken",
            "Officer",
            "_prisma_migrations",
            "Unknown",
            "ComplaintArchive",
            "complaint",
        ]:
            self.assertFalse(config.table_pattern.allowed(f"test_db.public.{table}"))
        self.assertFalse(config.table_pattern.allowed("test_db.private.Complaint"))

    def test_rejects_wildcard_and_sampling_and_usage(self):
        cases = [
            lambda c: c.update(table_pattern={"allow": [".*"]}),
            lambda c: c.update(profiling={"enabled": True}),
            lambda c: c.update(classification={"enabled": True}),
            lambda c: c.update(include_query_lineage=True),
            lambda c: c.update(include_stored_procedures=True),
            lambda c: c.update(stateful_ingestion={"enabled": True}),
        ]
        for change in cases:
            recipe = copy.deepcopy(self.recipe)
            change(recipe["source"]["config"])
            with self.assertRaises(ValueError):
                validate_recipe(recipe)

    def test_environment_values_are_not_parsed_as_yaml(self):
        with patch.dict(
            os.environ, {**ENV, "CIVICLOOP_PG_PASSWORD": "a: b\nprofiling: true"}
        ):
            recipe = load_recipe()
        self.assertEqual(
            recipe["source"]["config"]["password"], "a: b\nprofiling: true"
        )
        self.assertFalse(recipe["source"]["config"]["profiling"]["enabled"])

    def test_offline_commands_do_not_require_catalog_credentials(self):
        with patch.dict(
            os.environ,
            {**ENV, "DATAHUB_GMS_TOKEN": "replace-with-local-ingestion-token"},
        ):
            self.assertEqual(
                load_recipe(require_catalog=False)["sink"]["config"]["token"], ""
            )
            with self.assertRaises(ValueError):
                load_recipe(require_catalog=True)

    def test_catalog_verification_fails_when_unavailable_without_writing_evidence(self):
        config = validate_recipe(self.recipe)
        with tempfile.TemporaryDirectory() as temp:
            with (
                patch("ingest.ROOT", Path(temp)),
                patch(
                    "ingest.DataHubGraph", side_effect=ConnectionError("Unavailable")
                ),
            ):
                with self.assertRaises(ConnectionError):
                    verify_catalog(self.recipe, config, {})
            self.assertFalse((Path(temp) / ".local/verified-catalog.json").exists())

    def test_catalog_verification_rejects_excluded_assets(self):
        config = validate_recipe(self.recipe)
        urns = [dataset_urn(config, table) for table in [*TABLES, "User"]]
        with patch("ingest.DataHubGraph") as factory:
            factory.return_value.get_urns_by_filter.return_value = urns
            with self.assertRaisesRegex(ValueError, "unexpected=1"):
                verify_catalog(self.recipe, config, {})

    def test_mapping_refers_to_real_models_and_source_files(self):
        repo = ROOT.parents[1]
        schema = (repo / "apps/api/prisma/schema.prisma").read_text()
        for name, entry in TABLES.items():
            self.assertIn(f"model {name} {{", schema)
            for source in entry["evidence"]:
                self.assertTrue((repo / source.split(":")[0]).exists())


class MappingTests(unittest.TestCase):
    def test_auth_foreign_keys_and_arbitrary_comments_are_removed(self):
        schema = SchemaMetadataClass(
            schemaName="Complaint",
            platform="urn:li:dataPlatform:postgres",
            version=0,
            hash="",
            platformSchema=OtherSchemaClass(rawSchema=""),
            fields=[
                SchemaFieldClass(
                    fieldPath="title",
                    type=SchemaFieldDataTypeClass(type=StringTypeClass()),
                    nativeDataType="text",
                    description="unreviewed database comment",
                )
            ],
            foreignKeys=[
                ForeignKeyConstraintClass(
                    name="ward",
                    foreignDataset=sibling_urn(URN, "Ward"),
                    foreignFields=[],
                    sourceFields=[],
                ),
                ForeignKeyConstraintClass(
                    name="user",
                    foreignDataset=sibling_urn(URN, "User"),
                    foreignFields=[],
                    sourceFields=[],
                ),
            ],
        )
        output = SafeSchema().transform_aspect(URN, "schemaMetadata", schema)
        self.assertEqual([fk.name for fk in output.foreignKeys], ["ward"])
        self.assertEqual(output.fields[0].description, "")
        self.assertEqual(len(schema.foreignKeys), 2)

    def test_lineage_only_for_confirmed_metrics_flow(self):
        transformer = VerifiedLineage()
        self.assertIsNone(transformer.transform_aspect(URN, "upstreamLineage", None))
        urn = sibling_urn(URN, "PerformanceSnapshot")
        lineage = transformer.transform_aspect(urn, "upstreamLineage", None)
        self.assertEqual(
            {u.dataset for u in lineage.upstreams},
            {
                sibling_urn(URN, name)
                for name in ("Ward", "Complaint", "ComplaintEvent")
            },
        )

    def test_descriptions_include_evidence_without_invented_ownership(self):
        properties = DocumentedProperties().transform_aspect(
            URN, "datasetProperties", None
        )
        self.assertIn(
            "complaints.service.ts", properties.customProperties["source_evidence"]
        )
        self.assertIn("Not configured", properties.customProperties["ownership"])


if __name__ == "__main__":
    unittest.main()
