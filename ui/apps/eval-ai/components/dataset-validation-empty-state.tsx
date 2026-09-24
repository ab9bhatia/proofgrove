import { Button } from "@evalai/shared/ui/button";

export function canRunDatasetValidation(apiStatus: string, displayStatus: string): boolean {
  return apiStatus === "DRAFT" && displayStatus === "DRAFT";
}

export function DatasetValidationEmptyState({
  apiStatus,
  displayStatus,
  actionLoading,
  onValidate,
}: {
  apiStatus: string;
  displayStatus: string;
  actionLoading: string | null;
  onValidate: () => void;
}) {
  if (canRunDatasetValidation(apiStatus, displayStatus)) {
    return (
      <div className="py-8 text-center text-muted-foreground">
        <p>No validation run yet</p>
        <Button className="mt-3" size="sm" disabled={actionLoading !== null} onClick={onValidate}>
          Run validation
        </Button>
      </div>
    );
  }

  const message =
    displayStatus === "RETIRED"
      ? "Retired versions cannot be validated. Restore this dataset as an editable draft to copy its records into the next version."
      : `Only draft versions can be validated. This version is ${displayStatus.toLowerCase()}.`;

  return (
    <div className="py-8 text-center">
      <p className="font-medium text-foreground">Validation unavailable</p>
      <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
