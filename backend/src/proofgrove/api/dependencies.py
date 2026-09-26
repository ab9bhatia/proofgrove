"""FastAPI dependency injection."""

from collections.abc import AsyncGenerator
from functools import lru_cache

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from proofgrove.datasets.postgres_store import SqlDatasetStore
from proofgrove.datasets.registry import DatasetRegistryService
from proofgrove.db.session import async_session
from proofgrove.db.store import EvaluationStore
from proofgrove.evaluation.adapters import build_judge
from proofgrove.evaluation.engine import EvaluationEngine
from proofgrove.settings import settings


async def get_db_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session() as session:
        yield session


async def get_evaluation_store(session: AsyncSession = Depends(get_db_session)) -> EvaluationStore:
    return EvaluationStore(session)


def get_evaluation_engine() -> EvaluationEngine:
    return EvaluationEngine(judge=build_judge(settings))


@lru_cache
def get_storage_client() -> SqlDatasetStore:
    """Create a singleton SQLAlchemy-backed dataset store for the configured DB."""
    return SqlDatasetStore()


@lru_cache
def get_registry_service() -> DatasetRegistryService:
    """Create a singleton DatasetRegistryService."""
    return DatasetRegistryService(storage=get_storage_client())
