"""Real connector test against an isolated, disposable copy of the Prisma schema.

Requires Docker and the repo's installed Node dependencies. Does not contact GMS.
No operational CivicLoop database is used or modified.
"""

import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import uuid

import psycopg2
from psycopg2 import sql
from datahub.ingestion.run.pipeline import Pipeline

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "scripts")]
# Import the standalone integration without installing it in the app environment.
from ingest import load_recipe, validate_recipe, inspect_database, dataset_urn  # noqa: E402
from civicloop_metadata import TABLES, sibling_urn  # noqa: E402

IMAGE = "postgres:16-alpine@sha256:f377d590e5474681d4d7838635031a2b50647923b7abfa803ce9b5ff35d5c663"


def dataset_aspects(records):
    result = {}
    for record in records:
        if "proposedSnapshot" in record:
            snapshot = next(iter(record["proposedSnapshot"].values()))
            if not snapshot["urn"].startswith("urn:li:dataset:"):
                continue
            for item in snapshot["aspects"]:
                qualified_name, value = next(iter(item.items()))
                name = qualified_name.rsplit(".", 1)[-1]
                result[snapshot["urn"], name[0].lower() + name[1:]] = value
        elif record.get("entityType") == "dataset":
            result[record["entityUrn"], record["aspectName"]] = record["aspect"]["json"]
    return result


def assert_export(records, config, fields):
    aspects = dataset_aspects(records)
    expected = {dataset_urn(config, table) for table in TABLES}
    assert {urn for urn, _ in aspects} == expected
    for table in TABLES:
        urn = dataset_urn(config, table)
        schema = aspects[urn, "schemaMetadata"]
        assert {field["fieldPath"] for field in schema["fields"]} == set(fields[table])
        assert all(
            field["nativeDataType"].casefold()
            == fields[table][field["fieldPath"]].casefold()
            for field in schema["fields"]
        )
        assert all(
            fk["foreignDataset"] in expected for fk in schema.get("foreignKeys", [])
        )
        assert (
            aspects[urn, "datasetProperties"]["description"]
            == TABLES[table]["description"]
        )
        assert aspects[urn, "globalTags"]["tags"] == [{"tag": "urn:li:tag:CivicLoop"}]
        lineage = aspects.get((urn, "upstreamLineage"), {})
        assert {u["dataset"] for u in lineage.get("upstreams", [])} == {
            sibling_urn(urn, upstream)
            for upstream in TABLES[table].get("upstreams", [])
        }
    return set(aspects)


def main():
    name = "civicloop-metadata-test-" + uuid.uuid4().hex[:10]
    admin_password, catalog_password = (
        secrets.token_urlsafe(24),
        secrets.token_urlsafe(24),
    )
    database = "civicloop_metadata_test"
    env = {**os.environ, "POSTGRES_PASSWORD": admin_password}
    subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "-d",
            "--name",
            name,
            "-e",
            "POSTGRES_PASSWORD",
            "-e",
            f"POSTGRES_DB={database}",
            "-p",
            "127.0.0.1::5432",
            IMAGE,
        ],
        env=env,
        check=True,
        stdout=subprocess.DEVNULL,
    )
    try:
        port = (
            subprocess.check_output(["docker", "port", name, "5432"], text=True)
            .strip()
            .rsplit(":", 1)[-1]
        )
        admin = None
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            try:
                admin = psycopg2.connect(
                    host="127.0.0.1",
                    port=port,
                    dbname=database,
                    user="postgres",
                    password=admin_password,
                    connect_timeout=2,
                )
                break
            except psycopg2.OperationalError:
                time.sleep(0.5)
        if admin is None:
            raise RuntimeError("Disposable PostgreSQL did not become ready")
        ddl = subprocess.check_output(
            [
                "node",
                str(REPO / "apps/api/node_modules/prisma/build/index.js"),
                "migrate",
                "diff",
                "--from-empty",
                "--to-schema-datamodel",
                str(REPO / "apps/api/prisma/schema.prisma"),
                "--script",
            ],
            cwd=REPO,
            text=True,
        )
        with admin:
            with admin.cursor() as cursor:
                cursor.execute(ddl)
                cursor.execute(
                    "INSERT INTO \"Ward\" (id, \"cityCode\", name) VALUES ('test-ward', 'test-city', 'ROW_CANARY_MUST_NOT_BE_INGESTED')"
                )
                cursor.execute(
                    sql.SQL(
                        "CREATE ROLE civicloop_catalog LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS"
                    ).format(sql.Literal(catalog_password))
                )
                cursor.execute("GRANT USAGE ON SCHEMA public TO civicloop_catalog")
                cursor.execute(
                    "ALTER ROLE civicloop_catalog SET default_transaction_read_only = on"
                )
        os.environ.update(
            {
                "CIVICLOOP_PG_HOST_PORT": f"127.0.0.1:{port}",
                "CIVICLOOP_PG_DATABASE": database,
                "CIVICLOOP_PG_USER": "civicloop_catalog",
                "CIVICLOOP_PG_PASSWORD": catalog_password,
                "CIVICLOOP_PG_SSLMODE": "disable",
                "DATAHUB_ENV": "DEV",
                "DATAHUB_GMS_URL": "http://127.0.0.1:1",
                "DATAHUB_GMS_TOKEN": "offline-test-unused",
            }
        )
        recipe = load_recipe()
        config = validate_recipe(recipe)
        fields = inspect_database(config)
        subprocess.run(
            [sys.executable, str(ROOT / "scripts/ingest.py"), "validate"], check=True
        )
        subprocess.run(
            [sys.executable, str(ROOT / "scripts/ingest.py"), "dry-run"],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        assert_export(
            json.loads((ROOT / ".local/preview-metadata.json").read_text()),
            config,
            fields,
        )
        print("PASS: documented validate and offline dry-run commands work without GMS")
        with psycopg2.connect(
            host="127.0.0.1",
            port=port,
            dbname=database,
            user="civicloop_catalog",
            password=catalog_password,
        ) as restricted:
            try:
                with restricted.cursor() as cursor:
                    cursor.execute('SELECT * FROM "Ward" LIMIT 1')
            except psycopg2.errors.InsufficientPrivilege:
                restricted.rollback()
            else:
                raise AssertionError("Catalog role can read rows")
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "metadata.json"
            recipe["sink"] = {"type": "file", "config": {"filename": str(output)}}
            pipeline = Pipeline.create(recipe, report_to=None)
            pipeline.run()
            pipeline.raise_from_status()
            raw = output.read_text()
            assert "ROW_CANARY_MUST_NOT_BE_INGESTED" not in raw
            records = json.loads(raw)
            print("File sink records:", len(records))
            first_keys = assert_export(records, config, fields)
            # Save metadata-only evidence locally to help inspect connector compatibility.
            destination = ROOT / ".local" / "test-metadata.json"
            destination.parent.mkdir(exist_ok=True)
            destination.write_text(raw)
            for table in TABLES:
                assert dataset_urn(config, table) in raw, table
            for table in (
                "User",
                "VerificationToken",
                "OtpCode",
                "Officer",
                "_prisma_migrations",
            ):
                assert dataset_urn(config, table) not in raw, table
            for aspect in (
                "datasetProfile",
                "datasetUsageStatistics",
                "datasetOperation",
                "queryProperties",
            ):
                assert f'"{aspect}"' not in raw, aspect
            print(
                f"PASS: {len(fields)} real PostgreSQL schemas extracted, auth tables excluded, SELECT denied, row canary absent"
            )
            pipeline = Pipeline.create(recipe, report_to=None)
            pipeline.run()
            pipeline.raise_from_status()
            second_keys = assert_export(json.loads(output.read_text()), config, fields)
            assert first_keys == second_keys
            print(
                "PASS: second extraction has identical dataset/aspect identities, schemas, tags and verified lineage"
            )
        with admin:
            with admin.cursor() as cursor:
                cursor.execute('GRANT SELECT ON "Ward" TO civicloop_catalog')
        try:
            inspect_database(config)
        except ValueError:
            print("PASS: role with SELECT privileges rejected")
        else:
            raise AssertionError("Role with row access was accepted")
        with admin:
            with admin.cursor() as cursor:
                cursor.execute('REVOKE SELECT ON "Ward" FROM civicloop_catalog')
                cursor.execute('GRANT SELECT (name) ON "Ward" TO civicloop_catalog')
        try:
            inspect_database(config)
        except ValueError:
            print("PASS: role with column-level SELECT privileges rejected")
        else:
            raise AssertionError("Role with column-level row access was accepted")
        # Negative preflight: the application/DB owner is never accepted for ingestion.
        config.username = "postgres"
        from pydantic import SecretStr

        config.password = SecretStr(admin_password)
        try:
            inspect_database(config)
        except ValueError:
            print("PASS: elevated database role rejected")
        else:
            raise AssertionError("Elevated role was accepted")
        admin.close()
    finally:
        subprocess.run(
            ["docker", "rm", "-f", name], check=True, stdout=subprocess.DEVNULL
        )


if __name__ == "__main__":
    main()
