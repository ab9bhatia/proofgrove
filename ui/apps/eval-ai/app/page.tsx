import type { Metadata } from "next";
import { LearningExperience } from "@/components/learning/learning-experience";

export const metadata: Metadata = {
  title: "Start here",
  description: "Understand evaluation, explore its building blocks and run your first repeatable test.",
};

export default function Home() {
  return <LearningExperience />;
}
