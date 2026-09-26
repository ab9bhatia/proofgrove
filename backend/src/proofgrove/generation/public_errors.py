"""Public generation failures use an exact allowlist, including historical jobs."""

_FORMAT_ERRORS = {
    "LLM returned non-JSON", "LLM response missing a non-empty records array",
    "no usable records generated from the instruction", "LLM returned invalid JSON for a generation seed",
}
_SAFE_ERRORS = {
    "interrupted",
    "Generation response reached the output limit. Reduce Size or shorten the requested cases.",
    "Generation model timed out. Reduce Size or choose another connected model.",
    "Cannot reach the generation model. Check its connection in Models and retry.",
    "Generation model rejected authentication. Check the provider connection in Models.",
    "Generation provider limit reached. Check provider capacity or choose a local model.",
    "Generation provider rejected the request. Refresh Models or choose another connected model.",
    "Model did not return the requested number of distinct complete records. Reduce Size or choose another model.",
}


def public_generation_error(message: str) -> str:
    if message in _FORMAT_ERRORS:
        return "The selected model did not return valid dataset JSON. Try fewer rows or another connected model. No dataset was created."
    if message in _SAFE_ERRORS:
        return message
    return "Dataset generation failed. Check the generation inputs and try again."
