"""Collector-confirmed trace catalog: archive-backed index worker and models.

Langfuse-style worker→index architecture (owner-approved): raw OTLP spans land
in the S3 trace archive via the collector/RabbitMQ sink; proofgrove maintains a
relational index (``captured_trace_index`` / ``captured_span_index``) with
honest lifecycle states so Projects list real observability records instead of
only evaluation correlation ids.
"""
