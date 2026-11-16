"""Small metadata transforms; schema discovery stays in DataHub's Postgres source."""

import copy
import json
from pathlib import Path

from datahub.ingestion.transformer.dataset_transformer import DatasetTransformer
from datahub.metadata.schema_classes import (
    DatasetPropertiesClass,
    UpstreamClass,
    UpstreamLineageClass,
)
from datahub.metadata.urns import DatasetUrn

ROOT = Path(__file__).resolve().parent
MAPPING = json.loads((ROOT / "metadata.json").read_text())
TABLES = MAPPING["tables"]


def table_name(urn):
    return DatasetUrn.from_string(urn).name.rsplit(".", 1)[-1]


def sibling_urn(urn, table):
    parsed = DatasetUrn.from_string(urn)
    return str(
        DatasetUrn(
            platform=parsed.platform,
            name=parsed.name.rsplit(".", 1)[0] + "." + table,
            env=parsed.env,
        )
    )


class MappingTransformer(DatasetTransformer):
    @classmethod
    def create(cls, config_dict, ctx):
        if config_dict:
            raise ValueError(
                "CivicLoop transforms do not accept unreviewed configuration"
            )
        return cls()


class SafeSchema(MappingTransformer):
    def aspect_name(self):
        return "schemaMetadata"

    def transform_aspect(self, entity_urn, aspect_name, aspect):
        if aspect is None:
            return None
        table = table_name(entity_urn)
        if table not in TABLES:
            raise ValueError("Unexpected dataset outside the CivicLoop allowlist")
        result = copy.deepcopy(aspect)
        allowed = {sibling_urn(entity_urn, name) for name in TABLES}
        result.foreignKeys = [
            fk for fk in result.foreignKeys or [] if fk.foreignDataset in allowed
        ]
        # Do not copy arbitrary database comments into the catalog/model context.
        for field in result.fields:
            field.description = (
                TABLES[table].get("columns", {}).get(field.fieldPath, "")
            )
        return result


class DocumentedProperties(MappingTransformer):
    def aspect_name(self):
        return "datasetProperties"

    def transform_aspect(self, entity_urn, aspect_name, aspect):
        table = table_name(entity_urn)
        entry = TABLES[table]
        return DatasetPropertiesClass(
            name=table,
            description=entry["description"],
            customProperties={
                "metadata_scope": "Schema only; no records, samples, usage or profiling",
                "source_revision": MAPPING["source_revision"],
                "source_evidence": "; ".join(entry["evidence"]),
                "ownership": "Not configured; no owner inferred from DB roles",
            },
        )


class VerifiedLineage(MappingTransformer):
    def aspect_name(self):
        return "upstreamLineage"

    def transform_aspect(self, entity_urn, aspect_name, aspect):
        upstreams = TABLES[table_name(entity_urn)].get("upstreams", [])
        if not upstreams:
            return None
        return UpstreamLineageClass(
            upstreams=[
                UpstreamClass(dataset=sibling_urn(entity_urn, name), type="TRANSFORMED")
                for name in upstreams
            ]
        )
