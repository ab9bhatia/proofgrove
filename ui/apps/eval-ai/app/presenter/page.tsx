import { PresenterConsole } from "@/components/presenter-console";
import { novaLinks } from "@/lib/nova-links";
export const dynamic = "force-dynamic";
export const metadata = { title: "Private presenter notes", robots: { index: false, follow: false } };
export default async function PresenterPage() {
  return <PresenterConsole links={await novaLinks()} />;
}
