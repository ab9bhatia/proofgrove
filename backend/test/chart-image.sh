#!/usr/bin/env bash
set -euo pipefail

service_dir="$(cd "$(dirname "$0")/.." && pwd)"
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT
api="sha256:$(printf '%064d' 1)"
ui="sha256:$(printf '%064d' 2)"
sink="sha256:$(printf '%064d' 3)"
version=0.0.0-0123456789ab
package="$temp/eval-hub-${version}.tgz"
cp "$service_dir/chart/values.yaml" "$temp/source-values.yaml"

render() {
  helm template image-test "$@" --namespace tenant-image-test \
    --set telemetry.enabled=true --set traceArchive.enabled=true \
    --set-string route.hostname=eval-hub.image-check.example
}
assert_images() {
  local host=$1
  shift
  local rendered
  rendered=$(render "$package" "$@")
  for entry in "eval-hub@$api" "eval-ai@$ui" "trace-archive-sink@$sink"; do
    grep -Fq "image: \"${host}/evalai-evalai/evalai/services/${entry}\"" <<<"$rendered"
  done
  # API, migration init container and runtime-credential test Pod share the pin.
  [[ $(grep -Fc "image: \"${host}/evalai-evalai/evalai/services/eval-hub@${api}\"" <<<"$rendered") -eq 3 ]]
}

bash "$service_dir/package-chart.sh" "$api" "$ui" "$sink" "$version" 0123456789ab "$temp"
helm lint "$package" --namespace tenant-image-test
assert_images ghcr.io
assert_images cache.example.com --set-string imageRegistry=cache.example.com
assert_images localhost:5000 --set-string imageRegistry=localhost:5000
cat > "$temp/azure-infra.yaml" <<'YAML'
appInfra:
  tenantNamespace: tenant-image-test
  traceArchiveProfile: azure
  keyvaultUrl: https://example.vault.azure.net
  azureTenantId: 00000000-0000-0000-0000-000000000001
  workloadIdentityClientId: 00000000-0000-0000-0000-000000000002
  adminSecretsClientId: 00000000-0000-0000-0000-000000000003
  traceArchiveWriterClientId: 00000000-0000-0000-0000-000000000004
  traceArchiveEndpoint: https://example.blob.core.windows.net
  traceArchiveBucket: eval-hub-traces
  postgresHost: example.postgres.database.azure.com
  postgresDatabase: evalhub
  serviceBusNamespace: example.servicebus.windows.net
  serviceBusQueue: eval-hub-trace-events
telemetry:
  sink:
    ingestAuthTokenSecretName: image-test-ingest
evalaiEgress:
  privateEndpointCidr: 192.0.2.0/24
YAML
assert_images cache.example.com -f "$service_dir/chart/values-azure.yaml" \
  -f "$temp/azure-infra.yaml" --set-string imageRegistry=cache.example.com
rendered=$(render "$package" --set-string image=local-api:dev \
  --set-string ui.image.repository=local-ui --set-string ui.image.tag=dev \
  --set-string ui.image.digest= --set-string telemetry.sink.image=local-sink:dev)
for image in local-api:dev local-ui:dev local-sink:dev; do
  grep -Fq "image: \"$image\"" <<<"$rendered"
done
rendered=$(render "$service_dir/chart")
for image in eval-hub:latest eval-ai:latest trace-archive-sink:latest; do
  grep -Fq "image: \"$image\"" <<<"$rendered"
done
cmp "$temp/source-values.yaml" "$service_dir/chart/values.yaml"

for component in 0 1 2; do
  digests=("$api" "$ui" "$sink")
  digests[component]=sha256:invalid
  if bash "$service_dir/package-chart.sh" "${digests[@]}" "$version" test "$temp/invalid" >"$temp/error" 2>&1; then
    echo "FAIL: accepted invalid component digest" >&2
    exit 1
  fi
  grep -Fq 'Invalid image digest' "$temp/error"
  [[ ! -e "$temp/invalid" ]]
done
for registry in https://cache.example.com cache.example.com/path cache.example.com/ cache@example.com; do
  if render "$package" --set-string "imageRegistry=$registry" >"$temp/error" 2>&1; then
    echo "FAIL: accepted invalid registry" >&2
    exit 1
  fi
  grep -Fq 'imageRegistry must be a host' "$temp/error"
done
if render "$service_dir/chart" --set-string imageRegistry=cache.example.com >"$temp/error" 2>&1; then
  echo 'FAIL: rewrote unqualified local images' >&2
  exit 1
fi
grep -Fq 'imageRegistry requires an image with an explicit registry host' "$temp/error"
if render "$package" --set-string ui.image.digest=invalid >"$temp/error" 2>&1; then
  echo 'FAIL: accepted malformed UI digest' >&2
  exit 1
fi
grep -Fq 'ui.image.digest must be a sha256 digest' "$temp/error"
echo 'PASS: three immutable images, migration pin, registry/legacy overrides, local defaults and invalid inputs'
