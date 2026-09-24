"""Target ↔ system-Project binding.

A discovered agent/target is registered as an immutable ``TargetVersion`` whose
``project_id`` points at the internal ``catalog_registry`` Project. That catalog
Project is a registry of deployable snapshots, not the tenant's *system* home for
a target's quality configuration and traces.

This binding records, separately from any immutable ``TargetVersion``, which
tenant *system* Project a logical target maps to for a given environment. It lets
the evaluate flow infer a system Project from the selected agent/target without
mutating historical version rows.

One binding per ``(tenant_id, target_id, environment)``; different environments
of the same logical target bind to different system Projects.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from pydantic import BaseModel, Field


class TargetProjectBinding(BaseModel):
    """Maps a logical target (+ environment) to a tenant system Project.

    ``target_id`` is the *logical* target id (e.g. ``kagent-<hash>``), never an
    immutable ``TargetVersion.target_version_id``. ``system_project_id`` must
    reference an ``EvaluationProject`` with ``purpose=system`` in the same tenant.
    """

    binding_id: str = Field(default_factory=lambda: str(uuid4()))
    tenant_id: str
    target_id: str
    environment: str
    system_project_id: str
    created_by: str = "system"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
