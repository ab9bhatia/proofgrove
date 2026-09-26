"""Archive discovery uses the same profile and paging contract as trace reads."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from azure.storage.blob import BlobPrefix

from proofgrove.evaluation.trace_archive import AzureBlobS3Adapter
from proofgrove.settings import Settings
from proofgrove.tracing.archive_gateway import TraceArchiveGateway


@pytest.mark.parametrize("auth_mode", ["accessKey", "workloadIdentity"])
def test_discovery_reuses_the_profile_selected_by_reader(monkeypatch, auth_mode):
    client = Mock()
    client.list_objects_v2.return_value = {"CommonPrefixes": []}
    azure = Mock(return_value=client)
    s3 = Mock(return_value=client)
    monkeypatch.setattr("proofgrove.evaluation.trace_archive.AzureBlobS3Adapter", azure)
    monkeypatch.setattr("proofgrove.evaluation.trace_archive.boto3.client", s3)
    gateway = TraceArchiveGateway(Settings(app_env="test", trace_archive_auth_mode=auth_mode))
    assert gateway._list_sync("tenant-a", 10) == []
    assert gateway.reader.client is client
    assert azure.call_count == (auth_mode == "workloadIdentity")
    assert s3.call_count == (auth_mode == "accessKey")


@pytest.mark.parametrize("delimiter", [None, "/"])
def test_azure_listing_preserves_folders_and_pagination(delimiter):
    adapter = AzureBlobS3Adapter.__new__(AzureBlobS3Adapter)
    blob = SimpleNamespace(name="root/trace=a/part.parquet", size=12)
    folder = BlobPrefix(name="root/trace=a/")
    class Pages:
        continuation_token = "next-page"
        def __iter__(self):
            return self
        def __next__(self):
            return [folder, blob] if delimiter else [blob]
    class Listing:
        def by_page(self, continuation_token=None):
            assert continuation_token == "previous-page"
            return Pages()
    container = Mock()
    container.walk_blobs.return_value = Listing()
    container.list_blobs.return_value = Listing()
    adapter._container = container
    result = adapter.list_objects_v2(Prefix="root/", MaxKeys=2, Delimiter=delimiter, ContinuationToken="previous-page")
    assert result["Contents"] == [{"Key": blob.name, "Size": 12}]
    assert result["CommonPrefixes"] == ([{"Prefix": folder.name}] if delimiter else [])
    assert result["IsTruncated"] is True
    assert result["NextContinuationToken"] == "next-page"
    if delimiter:
        container.walk_blobs.assert_called_once_with(
            delimiter="/", name_starts_with="root/", results_per_page=2, timeout=adapter._timeout
        )
    else:
        container.list_blobs.assert_called_once_with(
            name_starts_with="root/", results_per_page=2, timeout=adapter._timeout
        )
