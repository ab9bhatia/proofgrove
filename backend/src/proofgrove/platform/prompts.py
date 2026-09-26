"""Prompt library: named prompts, auto-versioned, referenced by a run.

A prompt version is a system prompt someone chose to keep. It is deliberately
narrower than the prompt objects in comparable tools: no model configuration
(the model is the run's axis when comparing models, so a prompt that pins one
would contradict that) and no template variables (the dataset row is already
the user message).
"""

from __future__ import annotations

import re
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from proofgrove.platform.payloads import CREDENTIAL_PATTERNS

#: Prompts are the user's own text and can be long, but not unbounded: the only
#: other guard is a global 1 MiB request cap, which a runaway paste would pass
#: while making every subsequent invocation expensive.
MAX_PROMPT_CHARS = 32_000

#: The key packs tenant, id and version into one string, so an id containing a
#: separator would make it ambiguous.
_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

#: Reserved because they are resolved, not stored: `latest` always means the
#: newest version, and a label may never shadow them.
AUTOMATIC_LABELS = frozenset({"latest"})


def prompt_version_key(prompt_id: str, version: int, tenant_id: str | None = None) -> str:
    """Tenant-qualified key, mirroring `evaluator_version_key`.

    Tenant is part of the key rather than a column beside it: two tenants must
    both be able to own `support-prompt@1`.
    """

    scope = tenant_id or "platform"
    return f"{scope}:{prompt_id}@{version}"


def parse_prompt_ref(reference: str) -> tuple[str, str]:
    """Parse `prompt-id@version-or-label`; a bare id is deliberately invalid.

    Returning the right-hand side unparsed lets the caller decide whether it is
    a version number or a label — both are legitimate ways to name a prompt,
    and only the store can resolve a label.
    """

    prompt_id, separator, selector = reference.partition("@")
    if not prompt_id or not separator or not selector:
        raise ValueError("prompt references must use prompt-id@version or prompt-id@label")
    return prompt_id, selector


def reject_embedded_credentials(content: str) -> None:
    """Refuse a prompt that carries a credential, without altering it.

    Evaluation evidence is redacted on the way to storage, but a prompt is not
    evidence — it is executed. Substituting into it would send the model text
    the author never wrote and leave the recorded digest matching neither the
    stored nor the executed content. So the credential is refused at the door
    and the text is never rewritten.
    """

    for pattern, described in CREDENTIAL_PATTERNS:
        if pattern.search(content):
            raise ValueError(
                f"This prompt appears to contain {described}. Remove it and save again — "
                "prompts are stored and replayed verbatim, so they are never scrubbed for you."
            )


def validated_prompt_id(value: str) -> str:
    """A prompt id that cannot make the version key ambiguous."""

    if not _ID_PATTERN.match(value):
        raise ValueError(
            "prompt_id must be alphanumeric with dots, dashes or underscores, "
            "and must not contain '@' or ':'"
        )
    return value


def validated_prompt_content(value: str) -> str:
    """Non-empty prompt text within a bound the provider will accept."""

    text = value.strip()
    if not text:
        raise ValueError("prompt content must not be empty")
    if len(text) > MAX_PROMPT_CHARS:
        raise ValueError(f"prompt content must be at most {MAX_PROMPT_CHARS} characters")
    return text


class PromptVersion(BaseModel):
    """One saved revision of a named prompt."""

    prompt_id: str
    version: int
    tenant_id: str
    name: str
    description: str | None = None
    content: str
    content_hash: str
    labels: list[str] = Field(default_factory=list)
    created_by: str = "user"
    #: When this version was saved. The row has always carried it; without it on
    #: the wire a version history can only say "v3", never when or after what.
    created_at: datetime | None = None
    #: Set once the version is retired. Archived versions leave the pickers but
    #: stay resolvable, so historical runs and exact reruns keep working.
    archived_at: datetime | None = None

    @field_validator("prompt_id")
    @classmethod
    def _valid_id(cls, value: str) -> str:
        return validated_prompt_id(value)

    @field_validator("content")
    @classmethod
    def _bounded_content(cls, value: str) -> str:
        return validated_prompt_content(value)
