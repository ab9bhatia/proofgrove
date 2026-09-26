"""Exception contracts shared across layers (no imports: safe from any module).

``TenantVisibleError`` is the explicit contract behind ``safe_error_message``:
an exception class inherits it only when every place that raises it writes
the message itself. Wrapping a foreign exception's text (a driver, an HTTP
client, an SDK) into such a class breaks the contract -- reduce that text to a
type name or a status code before it becomes the message.
"""


class TenantVisibleError(Exception):
    """Marker: the message was authored for tenant-visible evidence."""


class EvaluationInputError(ValueError, TenantVisibleError):
    """An evaluation could not proceed because of what the caller supplied.

    The ``ValueError`` base keeps existing ``except ValueError`` handlers and
    tests working; the marker lets the message be persisted as evidence.
    """
