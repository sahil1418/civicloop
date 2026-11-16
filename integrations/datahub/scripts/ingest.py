"""Validate and run CivicLoop's official PostgreSQL metadata ingestion recipe."""

import argparse
import json
import os
from pathlib import Path
import re
import sys

import psycopg2
import yaml
from dotenv import load_dotenv
from datahub.ingestion.run.pipeline import Pipeline
from datahub.ingestion.source.sql.postgres.source import PostgresConfig
from pydantic import ValidationError
from datahub.ingestion.graph.client import DataHubGraph, DatahubClientConfig
from datahub.metadata.schema_classes import (
    SchemaMetadataClass,
    UpstreamLineageClass,
    DatasetPropertiesClass,
    GlobalTagsClass,
)
from datahub.emitter.mce_builder import make_dataset_urn_with_platform_instance

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
# The standalone scripts load the local transformer without a package install.
from civicloop_metadata import TABLES, sibling_urn  # noqa: E402

DISABLED = (
    "include_views",
    "include_stored_procedures",
    "include_view_lineage",
    "include_view_column_lineage",
    "include_table_location_lineage",
    "include_query_lineage",
    "include_usage_statistics",
    "include_top_n_queries",
    "include_operational_stats",
    "include_read_operational_stats",
)


def load_recipe(require_catalog=True):
    load_dotenv(ROOT / ".env", override=False)
    recipe = yaml.safe_load((ROOT / "recipe.example.yml").read_text())

    def expand(value):
        if isinstance(value, dict):
            return {key: expand(item) for key, item in value.items()}
        if isinstance(value, list):
            return [expand(item) for item in value]
        if not isinstance(value, str):
            return value

        def variable(match):
            key = match[1]
            result = os.environ.get(key)
            if (
                key == "DATAHUB_GMS_TOKEN"
                and not require_catalog
                and (not result or result.startswith("replace-with-"))
            ):
                return ""
            if not result or result.startswith("replace-with-"):
                raise ValueError(
                    f"Set {key} in the environment or integrations/datahub/.env"
                )
            return result

        return re.sub(r"\$\{([A-Z][A-Z0-9_]*)\}", variable, value)

    return expand(recipe)


def validate_recipe(recipe):
    if (
        recipe["source"]["type"] != "postgres"
        or recipe["sink"]["type"] != "datahub-rest"
    ):
        raise ValueError("Use the official postgres source and datahub-rest sink")
    try:
        config = PostgresConfig.model_validate(recipe["source"]["config"])
    except ValidationError:
        # Pydantic's normal error display can include the input configuration.
        raise ValueError(
            "Recipe does not match the pinned Postgres connector configuration"
        ) from None
    if not config.database or not re.fullmatch(r"[a-zA-Z0-9_]+", config.database):
        raise ValueError("Configure one database with an alphanumeric/underscore name")
    raw = recipe["source"]["config"]
    if any(raw.get(key) is not False for key in DISABLED):
        raise ValueError(
            "Views, procedures, profiling, queries and usage must stay disabled"
        )
    if any(
        raw.get(key, {}).get("enabled") is not False
        for key in ("profiling", "classification", "stateful_ingestion")
    ):
        raise ValueError(
            "Profiling, classification and stateful deletion must stay disabled"
        )
    # Compare names, not the order of alternations, so the mapping stays readable.
    expression = raw["table_pattern"]["allow"]
    if (
        len(expression) != 1
        or not expression[0].startswith("^[^.]+\\.public\\.(")
        or not expression[0].endswith(")$")
    ):
        raise ValueError("Use the exact operational-table allowlist")
    included = expression[0][len("^[^.]+\\.public\\.(") : -2].split("|")
    if (
        set(included) != set(TABLES)
        or raw["table_pattern"].get("ignoreCase") is not False
    ):
        raise ValueError("Recipe table allowlist must match metadata.json exactly")
    if raw["schema_pattern"] != {"allow": ["^public$"], "ignoreCase": False}:
        raise ValueError("Only the public schema is supported")
    for name in TABLES:
        if not config.table_pattern.allowed(f"{config.database}.public.{name}"):
            raise ValueError(f"Required dataset excluded: {name}")
    for name in (
        "User",
        "Officer",
        "VerificationToken",
        "OtpCode",
        "_prisma_migrations",
        "SecretTable",
    ):
        if config.table_pattern.allowed(f"{config.database}.public.{name}"):
            raise ValueError("A sensitive or unknown table passed the recipe filter")
    return config


def inspect_database(config):
    """Query only pg_catalog; refuse roles that can read or mutate application rows."""
    host, port = config.host_port.rsplit(":", 1)
    args = config.options["connect_args"]
    with psycopg2.connect(
        host=host,
        port=int(port),
        dbname=config.database,
        user=config.username,
        password=config.password.get_secret_value(),
        **args,
    ) as connection:
        connection.set_session(readonly=True)
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user"
            )
            if any(cursor.fetchone()):
                raise ValueError(
                    "The catalog role must not have elevated database privileges"
                )
            cursor.execute("""
                SELECT n.nspname, c.relname,
                  has_table_privilege(c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                  OR has_any_column_privilege(c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind IN ('r','p','v','m','f')
                  AND n.nspname NOT IN ('pg_catalog','information_schema')
                  AND n.nspname NOT LIKE 'pg_toast%%'
            """)
            relations = cursor.fetchall()
            if any(privileges for _, _, privileges in relations):
                raise ValueError(
                    "Catalog role has application table privileges; use the dedicated metadata-only role"
                )
            actual = {
                table
                for schema, table, _ in relations
                if schema == "public" and table in TABLES
            }
            if actual != set(TABLES):
                raise ValueError(
                    "Development schema is missing required tables: "
                    + ", ".join(sorted(set(TABLES) - actual))
                )
            cursor.execute("""
                SELECT c.relname, a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod)
                FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
                  AND c.relkind IN ('r','p')
                ORDER BY c.relname, a.attnum
            """)
            fields = {}
            for table, column, data_type in cursor.fetchall():
                if table in TABLES:
                    fields.setdefault(table, {})[column] = data_type
            return fields


def dataset_urn(config, table):
    return make_dataset_urn_with_platform_instance(
        "postgres",
        f"{config.database}.public.{table}",
        config.platform_instance,
        config.env,
    )


def verify_catalog(recipe, config, fields):
    sink = recipe["sink"]["config"]
    graph = DataHubGraph(
        DatahubClientConfig(
            server=sink["server"],
            token=sink["token"],
            timeout_sec=30,
            retry_max_times=1,
        )
    )
    # Search the entire stable instance prefix, not only the expected URNs.
    prefix = f"{config.platform_instance}.{config.database}."
    from datahub.metadata.urns import DatasetUrn

    found = set()
    for urn in graph.get_urns_by_filter(
        entity_types=["dataset"], platform="postgres", env=config.env
    ):
        parsed = DatasetUrn.from_string(urn)
        if parsed.name.startswith(prefix):
            found.add(urn)
    expected = {dataset_urn(config, table) for table in TABLES}
    if found != expected:
        raise ValueError(
            f"Catalog scope mismatch: missing={len(expected - found)}, unexpected={len(found - expected)}. Wait for indexing, then rerun verify."
        )
    evidence = []
    for table in sorted(TABLES):
        urn = dataset_urn(config, table)
        schema = graph.get_aspect(urn, SchemaMetadataClass)
        if schema is None or {f.fieldPath for f in schema.fields} != set(fields[table]):
            raise ValueError(f"Catalog schema does not match PostgreSQL: {table}")
        if any(
            field.nativeDataType.casefold() != fields[table][field.fieldPath].casefold()
            for field in schema.fields
        ):
            raise ValueError(f"Catalog column types do not match PostgreSQL: {table}")
        if any(fk.foreignDataset not in expected for fk in schema.foreignKeys or []):
            raise ValueError("Catalog contains a foreign key to an excluded dataset")
        properties = graph.get_aspect(urn, DatasetPropertiesClass)
        if properties is None or properties.description != TABLES[table]["description"]:
            raise ValueError(
                f"Catalog description does not match reviewed evidence: {table}"
            )
        tags = graph.get_aspect(urn, GlobalTagsClass)
        if tags is None or "urn:li:tag:CivicLoop" not in {tag.tag for tag in tags.tags}:
            raise ValueError(f"Missing CivicLoop tag: {table}")
        lineage = graph.get_aspect(urn, UpstreamLineageClass)
        upstreams = {item.dataset for item in lineage.upstreams} if lineage else set()
        if upstreams != {
            sibling_urn(urn, name) for name in TABLES[table].get("upstreams", [])
        }:
            raise ValueError(f"Unexpected or missing lineage: {table}")
        evidence.append(
            {
                "table": table,
                "urn": urn,
                "columns": fields[table],
                "upstreams": sorted(upstreams),
            }
        )
    output = ROOT / ".local" / "verified-catalog.json"
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(evidence, indent=2) + "\n")
    print(
        f"Verified {len(evidence)} datasets, their schemas, exclusions and lineage. Evidence: {output}"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["validate", "dry-run", "run", "verify"])
    args = parser.parse_args()
    recipe = load_recipe(require_catalog=args.action in ("run", "verify"))
    config = validate_recipe(recipe)
    fields = inspect_database(config)
    print(f"Validated metadata-only role and {len(fields)} operational table schemas")
    if args.action == "verify":
        verify_catalog(recipe, config, fields)
    elif args.action in ("run", "dry-run"):
        if args.action == "dry-run":
            # DataHub's CLI dry_run still connects its REST sink to GMS on startup.
            # A local file sink gives a genuinely offline, inspectable preview.
            preview = ROOT / ".local" / "preview-metadata.json"
            preview.parent.mkdir(exist_ok=True)
            recipe["sink"] = {"type": "file", "config": {"filename": str(preview)}}
        pipeline = Pipeline.create(recipe, report_to=None)
        pipeline.run()
        pipeline.pretty_print_summary()
        pipeline.raise_from_status()


if __name__ == "__main__":
    main()
