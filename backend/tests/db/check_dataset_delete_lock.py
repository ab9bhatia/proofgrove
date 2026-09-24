"""Verify deletion rechecks DRAFT under a PostgreSQL row lock; disposable DB only.

WORKER_TEST_DATABASE_URL=postgresql+asyncpg://... python tests/db/check_dataset_delete_lock.py
"""

import os
import threading
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from sqlalchemy import select

from evalhub.datasets.exceptions import DatasetImmutableError
from evalhub.datasets.models import DatasetMetadata
from evalhub.datasets.postgres_store import SqlDatasetStore
from evalhub.db.models import GoldenDatasetORM
from evalhub.settings import settings


def main():
    settings.database_url = os.environ["WORKER_TEST_DATABASE_URL"]
    settings.app_env = "test"
    storage = SqlDatasetStore()
    name = "synthetic-delete-lock-" + uuid4().hex
    tenant = "synthetic"
    storage.create_dataset(name, DatasetMetadata(tenant_id=tenant, product_id="test", created_by="test"))
    entered = threading.Event()

    def delete():
        entered.set()
        storage.delete_dataset(name, tenant)

    with ThreadPoolExecutor(max_workers=1) as pool:
        with storage._sessionmaker() as publisher:
            row = publisher.scalars(select(GoldenDatasetORM).where(
                GoldenDatasetORM.dataset_name == name, GoldenDatasetORM.tenant_id == tenant,
            ).with_for_update()).one()
            row.status = "PUBLISHED"
            publisher.flush()
            future = pool.submit(delete)
            assert entered.wait(2)
            try:
                future.result(timeout=0.2)
            except TimeoutError:
                pass  # Delete waits for publication's row lock.
            else:
                raise AssertionError("delete did not wait for publication")
            publisher.commit()
        try:
            future.result(timeout=5)
        except DatasetImmutableError:
            pass
        else:
            raise AssertionError("published dataset was deleted")
    assert storage.get_metadata(name, tenant).status.value == "PUBLISHED"
    print("PASS: delete waits for the publishing transaction, rechecks status, and preserves the dataset")


if __name__ == "__main__":
    main()
