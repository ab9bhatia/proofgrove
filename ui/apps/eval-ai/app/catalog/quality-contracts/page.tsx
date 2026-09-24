import { redirect } from "next/navigation";

/** Preserved deep link. Evaluation governance now lives at /contracts. */
export default function QualityContractCatalogRedirect() {
  redirect("/contracts");
}
