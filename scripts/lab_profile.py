"""Explicit local profiles. Seeding and the Next.js process never receive keys."""
from decimal import Decimal, InvalidOperation


def environments(source, root):
    mode = source.get('PROOFGROVE_MODE', 'offline')
    if mode not in ('offline', 'local', 'live'):
        raise ValueError('PROOFGROVE_MODE must be offline, local or live.')
    # Providers not explicitly selected must not inherit host API credentials.
    # Live mode restores only its acknowledged server-side OpenAI key below.
    runtime = {key: value for key, value in source.items()
               if key.upper() != 'API_KEY' and not key.upper().endswith('_API_KEY')}
    runtime.update({
        'APP_ENV': 'dev', 'DATABASE_URL': f'sqlite+aiosqlite:///{root / "backend/data/eval-ai.db"}',
        'JUDGE_MODE': 'mock', 'JUDGE_USE_FRAMEWORKS': 'false',
        'JUDGE_PROVIDER': 'openai', 'OPENAI_BASE_URL': 'https://api.openai.com/v1',
        'EVALUATION_RUNTIME': 'local', 'PLATFORM_AUTH_REQUIRED': 'false',
        'POD_NAMESPACE': 'tenant-local-classroom', 'TRACE_ARCHIVE_ENABLED': 'false',
        'TRACE_INDEX_ENABLED': 'false', 'OTEL_SDK_DISABLED': 'true',
        'PROOFGROVE_API_URL': 'http://127.0.0.1:8010',
        'OPENAI_API_KEY': '', 'AZURE_OPENAI_API_KEY': '',
        'NEXT_TELEMETRY_DISABLED': '1', 'EVALAI_RUM_ENABLED': 'false',
        'PYTHONUNBUFFERED': '1', 'PROOFGROVE_MODE': mode,
        'PROOFGROVE_MODEL': '', 'PROOFGROVE_ROOT': str(root),
    })
    seed = dict(runtime, PROOFGROVE_MODE='offline')
    if mode == 'live':
        if not source.get('OPENAI_API_KEY', '').strip() or not source.get('PROOFGROVE_MODEL', '').strip():
            raise ValueError('Live mode needs a server-side OPENAI_API_KEY and an explicit PROOFGROVE_MODEL.')
        try:
            budget = Decimal(source.get('PROOFGROVE_BUDGET_USD', '0'))
            valid_budget = budget.is_finite() and budget > 0
        except InvalidOperation:
            valid_budget = False
        if source.get('PROOFGROVE_ALLOW_PAID_CALLS') != 'yes' or not valid_budget:
            raise ValueError('Set PROOFGROVE_ALLOW_PAID_CALLS=yes and a positive PROOFGROVE_BUDGET_USD after reviewing provider costs. This acknowledgement is not an enforced spending cap.')
        runtime.update(OPENAI_API_KEY=source['OPENAI_API_KEY'], PROOFGROVE_MODEL=source['PROOFGROVE_MODEL'].strip(), JUDGE_MODEL=source['PROOFGROVE_MODEL'].strip())
    if mode == 'local':
        model = source.get('PROOFGROVE_MODEL', 'llama3.2:latest').strip()
        if not model:
            raise ValueError('Local mode needs an installed Ollama model ID.')
        runtime.update(OPENAI_BASE_URL='http://127.0.0.1:11434/v1', OPENAI_API_KEY='',
                       PROOFGROVE_MODEL=model, JUDGE_MODEL=model)
        # Never inherit cloud model profiles into the local provider.
        for letter in ('A', 'B', 'C'):
            name = f'PROOFGROVE_MODEL_{letter}'
            runtime[name] = source.get(f'PROOFGROVE_LOCAL_MODEL_{letter}', '').strip() or model
    ui = dict(runtime)
    for key in list(ui):
        if any(word in key.upper() for word in ('API_KEY', 'SECRET', 'TOKEN', 'PASSWORD')):
            ui.pop(key)
    return runtime, seed, ui
