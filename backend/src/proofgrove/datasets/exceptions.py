"""Dataset-specific exceptions."""

from proofgrove.errors import TenantVisibleError


class DatasetError(TenantVisibleError):
    """Base exception for dataset operations."""


class DatasetNotFoundError(DatasetError):
    """Raised when a dataset or version does not exist."""


class DatasetImmutableError(DatasetError):
    """Raised when attempting to modify a non-DRAFT dataset version."""


class InvalidTransitionError(DatasetError):
    """Raised when a lifecycle state transition is not allowed."""


class DatasetValidationError(DatasetError):
    """Raised when dataset content fails validation."""
